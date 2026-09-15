import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { TranscriptsStore } from "../transcripts/store.js";
import { createMeetingSession } from "./session-factory.js";
import type { MeetingSessionRuntimeHandles } from "./session-runtime.js";
import { createTestRuntime } from "./session-runtime.test-support.js";
import type { TestSession, TestJoinContext } from "./session-runtime.test-support.js";
import type { MeetingBrowserHealth } from "./session-types.js";

describe("createMeetingSession", () => {
  it.each([
    {
      mode: "agent" as const,
      provider: undefined,
      transcriptionProvider: "deepgram",
    },
    {
      mode: "bidi" as const,
      provider: "openai-realtime",
      transcriptionProvider: undefined,
    },
  ])("preserves $mode realtime session fields", ({ mode, provider, transcriptionProvider }) => {
    const session = createMeetingSession({
      platform: {
        id: "test-meeting",
        displayName: "Test Meeting",
        logScope: "[test-meeting]",
        agentConsult: {
          surface: "a test meeting",
          userLabel: "Participant",
          assistantLabel: "Agent",
          questionSourceLabel: "participant",
          workingResponseLabel: "participant",
          extraSystemPrompt: "Answer briefly.",
        },
        session: {
          idPrefix: "test_meeting",
          participantIdentity: (transport) => `Test participant via ${transport}`,
        },
      },
      config: {
        realtime: {
          provider: "deepgram",
          voiceProvider: "openai-realtime",
          transcriptionProvider: "deepgram",
          model: "realtime-model",
          toolPolicy: "safe-read-only",
        },
      },
      resolved: {
        url: "https://meeting.example/room",
        transport: "chrome",
        mode,
        agentId: "operator",
      },
      createdAt: "2026-07-22T00:00:00.000Z",
    });

    expect(session).toMatchObject({
      id: expect.stringMatching(/^test_meeting_/),
      state: "active",
      participantIdentity: "Test participant via chrome",
      realtime: {
        enabled: true,
        strategy: mode,
        provider,
        model: mode === "bidi" ? "realtime-model" : undefined,
        transcriptionProvider,
        toolPolicy: "safe-read-only",
      },
      notes: [],
    });
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("MeetingSessionRuntime durable transcripts", () => {
  it("persists joined agent-mode captions and writes summary rows on leave", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-"));
    tempDirs.push(stateDir);
    const snapshots = [
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [
          {
            at: "2026-07-23T12:00:00.000Z",
            speaker: "Avery",
            text: "We decided to ship the durable notes bridge.",
          },
        ],
      },
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [
          {
            at: "2026-07-23T12:00:00.000Z",
            speaker: "Avery",
            text: "We decided to ship the durable notes bridge.",
          },
          {
            at: "2026-07-23T12:00:05.000Z",
            speaker: "Blake",
            text: "Action: follow up with the docs.",
          },
        ],
      },
    ];
    const { runtime } = createTestRuntime({
      captureTranscript: async () => snapshots.shift(),
      durableTranscripts: { stateDir },
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "notes-tab", openedByPlugin: true },
        };
        return {};
      },
    });

    const { session } = await runtime.join({
      url: "https://meeting.example/notes?context=opaque-value",
      agentId: "notes-agent",
    });
    await expect(
      runtime.startTranscriptSource({
        session: {
          sessionId: "external-mismatch",
          source: {
            providerId: "test-meeting",
            agentId: "notes-agent",
            channelId: "another-session",
            meetingUrl: session.url,
          },
          startedAt: session.createdAt,
        },
        onUtterance: vi.fn(),
      }),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      runtime.startTranscriptSource({
        session: {
          sessionId: "external-agent-mismatch",
          source: {
            providerId: "test-meeting",
            agentId: "another-agent",
            meetingUrl: session.url,
          },
          startedAt: session.createdAt,
        },
        onUtterance: vi.fn(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "No active meeting session matches the transcript source.",
    });
    await runtime.leave(session.id);

    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const storedSession = await store.readSession(session.id);
    expect(storedSession).toMatchObject({
      sessionId: session.id,
      source: { providerId: "test-meeting", meetingUrl: "https://meeting.example/notes" },
      metadata: { agentId: "notes-agent", meetingSessionId: session.id, mode: "agent" },
      stoppedAt: expect.any(String),
    });
    expect(await store.readUtterancesForSession(storedSession!)).toMatchObject([
      { speaker: { label: "Avery" }, text: "We decided to ship the durable notes bridge." },
      { speaker: { label: "Blake" }, text: "Action: follow up with the docs." },
    ]);
    expect(await store.readSummary(storedSession!)).toMatchObject({
      summary: {
        actionItems: [
          "Avery: We decided to ship the durable notes bridge.",
          "Blake: Action: follow up with the docs.",
        ],
        decisions: ["Avery: We decided to ship the durable notes bridge."],
        utteranceCount: 2,
      },
    });
  });

  it("keeps transcribe finalization when durable session startup fails", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-"));
    tempDirs.push(tempDir);
    const blockedStateDir = path.join(tempDir, "not-a-directory");
    await fs.writeFile(blockedStateDir, "blocked", "utf8");
    const captureTranscript = vi.fn(async () => ({ droppedLines: 0, lines: [] }));
    const { runtime } = createTestRuntime({
      captureTranscript,
      durableTranscripts: { stateDir: blockedStateDir },
      transcribe: true,
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "notes-tab", openedByPlugin: true },
        };
        return {};
      },
    });

    const { session } = await runtime.join({
      url: "https://meeting.example/notes",
      agentId: "notes-agent",
    });
    await runtime.leave(session.id);

    expect(captureTranscript).toHaveBeenCalledTimes(2);
    expect(captureTranscript).toHaveBeenCalledWith({ finalize: true });
  });

  it("does not let subscriber delivery failure block meeting leave", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-meeting-notes-"));
    tempDirs.push(stateDir);
    const empty = { droppedLines: 0, epoch: "page-1", lines: [] };
    const final = {
      droppedLines: 0,
      epoch: "page-1",
      lines: [{ speaker: "Avery", text: "Final decision" }],
    };
    const snapshots = [empty, final];
    const releaseBrowserTab = vi.fn(async () => true);
    const { runtime } = createTestRuntime({
      captureTranscript: async () => snapshots.shift(),
      durableTranscripts: { stateDir },
      transcribe: true,
      releaseBrowserTab,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "notes-tab", openedByPlugin: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/notes",
      agentId: "notes-agent",
    });
    const onUtterance = vi.fn(async () => {
      throw new Error("subscriber unavailable");
    });
    await runtime.startTranscriptSource({
      session: {
        sessionId: "external-final",
        source: {
          providerId: "test-meeting",
          agentId: "notes-agent",
          meetingUrl: session.url,
        },
        startedAt: session.createdAt,
      },
      onUtterance,
    });

    await expect(runtime.leave(session.id)).resolves.toMatchObject({ found: true });
    expect(session.state).toBe("ended");
    expect(releaseBrowserTab).toHaveBeenCalledOnce();

    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const stored = await store.readSession(session.id);
    expect(await store.readUtterancesForSession(stored!)).toHaveLength(1);
    expect(await store.readSummary(stored!)).toMatchObject({
      summary: { utteranceCount: 1 },
    });
    expect(onUtterance).toHaveBeenCalledOnce();
  });
});

describe("MeetingSessionRuntime failed joins", () => {
  it("cleans an externally ended reusable session before replacing it", async () => {
    const stop = vi.fn(async () => {});
    const releaseBrowserTab = vi.fn(async () => true);
    const joinTransport = vi.fn(
      async ({ session, context }: { session: TestSession; context: TestJoinContext }) => {
        session.browser = {
          launched: true,
          tab: { targetId: session.id, openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        return {};
      },
    );
    const { runtime } = createTestRuntime({
      joinTransport,
      refreshReusableSession: async (session) => {
        session.state = "ended";
      },
      releaseBrowserTab,
    });
    const first = await runtime.join({ url: "https://meeting.example/room", agentId: "main" });

    const replacement = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    expect(first.session.state).toBe("ended");
    expect(replacement.session.id).not.toBe(first.session.id);
    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).not.toHaveBeenCalled();
    expect(joinTransport).toHaveBeenCalledTimes(2);
  });

  it("stops attached transport handles and releases the partial browser tab", async () => {
    const joinError = new Error("transport setup failed");
    const stop = vi.fn(async () => {});
    let releaseAttempts = 0;
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (releaseAttempts++ === 0) {
        return false;
      }
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { createdSessions, runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "partial-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        throw joinError;
      },
    });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(joinError);

    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledTimes(2);
    expect(createdSessions[0]).toMatchObject({ state: "ended", browser: { tab: undefined } });
    expect(runtime.list()).toEqual([]);
  });

  it("retries transport cleanup for an unpublished failed join", async () => {
    const joinError = new Error("transport setup failed");
    const stopError = new Error("transport stop failed");
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce();
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "partial-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        throw joinError;
      },
    });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(joinError);

    expect(stop).toHaveBeenCalledTimes(2);
    expect(releaseBrowserTab).toHaveBeenCalledOnce();
    expect(runtime.list()).toEqual([]);
  });

  it("retries unprocessed retained tabs after settlement rejects", async () => {
    const settlementError = new Error("retained release rejected");
    const oldStop = vi.fn(async () => {});
    const replacementStop = vi.fn(async () => {});
    const releaseOrder: string[] = [];
    let oldReleaseAttempts = 0;
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      releaseOrder.push(session.id);
      if (session.id === "session-1" && oldReleaseAttempts++ === 0) {
        throw settlementError;
      }
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { createdSessions, runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        const first = session.id === "session-1";
        session.browser = {
          launched: true,
          tab: {
            targetId: first ? "retained-tab" : "replacement-tab",
            openedByPlugin: true,
          },
        };
        context.attachRuntimeHandles(session, { stop: first ? oldStop : replacementStop });
        return {};
      },
    });
    await runtime.join({ url: "https://meeting.example/room", agentId: "support" });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(settlementError);

    expect(oldStop).toHaveBeenCalledOnce();
    expect(replacementStop).toHaveBeenCalledOnce();
    expect(releaseOrder).toEqual(["session-1", "session-2", "session-1"]);
    expect(createdSessions[0]?.browser?.tab).toBeUndefined();
    expect(createdSessions[1]).toMatchObject({ state: "ended", browser: { tab: undefined } });
  });

  it("retries retained cleanup when stopping the previous session rejects", async () => {
    const stopError = new Error("previous transport stop failed");
    const settlementError = new Error("retained release rejected");
    const oldStop = vi.fn(async () => {
      throw stopError;
    });
    let releaseAttempts = 0;
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (releaseAttempts++ === 0) {
        throw settlementError;
      }
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const joinTransport = vi.fn(
      async ({ session, context }: { session: TestSession; context: TestJoinContext }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "retained-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop: oldStop });
        return {};
      },
    );
    const { createdSessions, runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport,
    });
    await runtime.join({ url: "https://meeting.example/room", agentId: "support" });

    await expect(
      runtime.join({ url: "https://meeting.example/room", agentId: "main" }),
    ).rejects.toBe(stopError);

    expect(joinTransport).toHaveBeenCalledOnce();
    expect(oldStop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledTimes(2);
    expect(createdSessions[0]).toMatchObject({ state: "ended", browser: { tab: undefined } });
  });
});

describe("MeetingSessionRuntime leave cleanup", () => {
  it("clears stale in-call health after confirmed browser departure", async () => {
    const { runtime } = createTestRuntime({
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          health: {
            inCall: true,
            micMuted: false,
            manualAction: { reason: "old-action", message: "old action" },
            speechReady: true,
            speechBlockedMessage: "old speech block",
            speechBlockedReason: "old-speech-block",
          },
          tab: { targetId: "leave-tab", openedByPlugin: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      browserLeft: true,
      session: {
        browser: {
          health: {
            inCall: false,
            manualAction: undefined,
            speechReady: false,
          },
        },
      },
    });
    expect(session.browser?.health?.manualAction).toBeUndefined();
    expect(session.browser?.health?.micMuted).toBeUndefined();
    expect(session.browser?.health?.speechBlockedReason).toBeUndefined();
    expect(session.browser?.health?.speechBlockedMessage).toBeUndefined();
  });

  it("retries a failed transport stop without repeating settled browser cleanup", async () => {
    const stopError = new Error("transport stop failed");
    const stop = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce();
    const releaseBrowserTab = vi.fn(async (session: TestSession) => {
      if (session.browser) {
        session.browser.tab = undefined;
      }
      return true;
    });
    const { runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "leave-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    await expect(runtime.leave(session.id)).rejects.toBe(stopError);
    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      browserLeft: true,
    });

    expect(stop).toHaveBeenCalledTimes(2);
    expect(releaseBrowserTab).toHaveBeenCalledOnce();
  });

  it("retries browser cleanup that reported an unsuccessful leave", async () => {
    const stop = vi.fn(async () => {});
    const releaseBrowserTab = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { runtime } = createTestRuntime({
      releaseBrowserTab,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "retry-tab", openedByPlugin: true },
        };
        context.attachRuntimeHandles(session, { stop });
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      browserLeft: false,
    });
    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      browserLeft: true,
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(releaseBrowserTab).toHaveBeenCalledTimes(2);
  });
});

describe("MeetingSessionRuntime speech readiness", () => {
  it("rejects speech when its source expires during browser readiness", async () => {
    const readinessStarted = createDeferredCore();
    const readinessFinished = createDeferredCore();
    const expired = new Error("Speech source expired");
    let sourceCurrent = true;
    const speak = vi.fn();
    const ensureRealtimeBridge = vi.fn(async () => undefined);
    const { runtime } = createTestRuntime({
      talkBack: true,
      releaseBrowserTab: async () => true,
      ensureRealtimeBridge,
      refreshBrowserHealth: async (session) => {
        readinessStarted.resolve();
        await readinessFinished.promise;
        session.browser!.health = { inCall: true, micMuted: false };
      },
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          hasAudioBridge: true,
          health: { inCall: true },
        };
        context.attachRuntimeHandles(session, { speak });
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    const pendingSpeech = runtime.speak(session.id, "Answer the current question", () => {
      if (!sourceCurrent) {
        throw expired;
      }
    });
    await readinessStarted.promise;
    sourceCurrent = false;
    readinessFinished.resolve();

    await expect(pendingSpeech).rejects.toBe(expired);
    expect(ensureRealtimeBridge).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });

  it("keeps a recovered bridge owned for cleanup when its speech source expires", async () => {
    const recoveryStarted = createDeferredCore();
    const recoveryFinished = createDeferredCore();
    const expired = new Error("Speech source expired");
    let sourceCurrent = true;
    const speak = vi.fn();
    const stop = vi.fn(async () => {});
    const { runtime } = createTestRuntime({
      talkBack: true,
      releaseBrowserTab: async () => true,
      ensureRealtimeBridge: async (session) => {
        recoveryStarted.resolve();
        await recoveryFinished.promise;
        session.browser!.hasAudioBridge = true;
        return { speak, stop };
      },
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          hasAudioBridge: false,
          health: { inCall: true, micMuted: false },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    const pendingSpeech = runtime.speak(session.id, "Answer the current question", () => {
      if (!sourceCurrent) {
        throw expired;
      }
    });
    await recoveryStarted.promise;
    sourceCurrent = false;
    recoveryFinished.resolve();

    await expect(pendingSpeech).rejects.toBe(expired);
    expect(speak).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    await expect(runtime.leave(session.id)).resolves.toMatchObject({
      found: true,
      session: { state: "ended" },
    });
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["source expiry", "session leave"] as const)(
    "forwards a live speech guard that rejects after %s",
    async (invalidation) => {
      let sourceCurrent = true;
      const speak =
        vi.fn<NonNullable<MeetingSessionRuntimeHandles<MeetingBrowserHealth>["speak"]>>();
      const { runtime } = createTestRuntime({
        talkBack: true,
        releaseBrowserTab: async () => true,
        joinTransport: async ({ session, context }) => {
          session.browser = {
            launched: true,
            hasAudioBridge: true,
            health: { inCall: true, micMuted: false },
          };
          context.attachRuntimeHandles(session, { speak });
          return {};
        },
      });
      const { session } = await runtime.join({
        url: "https://meeting.example/room",
        agentId: "main",
      });

      await expect(
        runtime.speak(session.id, "Answer the current question", () => {
          if (!sourceCurrent) {
            throw new Error("Speech source expired");
          }
        }),
      ).resolves.toMatchObject({ found: true, spoken: true });
      expect(speak).toHaveBeenCalledExactlyOnceWith(
        "Answer the current question",
        expect.any(Function),
        undefined,
      );
      const forwardedGuard = speak.mock.calls[0]?.[1];
      expect(forwardedGuard).not.toThrow();

      if (invalidation === "session leave") {
        await runtime.leave(session.id);
      } else {
        sourceCurrent = false;
      }
      expect(forwardedGuard).toThrow(
        invalidation === "session leave"
          ? "Meeting session is no longer active"
          : "Speech source expired",
      );
    },
  );

  it("forwards source refresh and rejects when asynchronous speech submission fails", async () => {
    const submissionStarted = createDeferredCore();
    const sourceRefresh = createDeferredCore();
    const refreshFailed = new Error("Speech source refresh failed");
    const refreshCurrent = vi.fn(() => sourceRefresh.promise);
    const speak = vi.fn<NonNullable<MeetingSessionRuntimeHandles<MeetingBrowserHealth>["speak"]>>(
      async (_instructions, assertCurrent, refreshSource) => {
        assertCurrent?.();
        submissionStarted.resolve();
        await refreshSource?.();
      },
    );
    const { runtime } = createTestRuntime({
      talkBack: true,
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session, context }) => {
        session.browser = {
          launched: true,
          hasAudioBridge: true,
          health: { inCall: true, micMuted: false },
        };
        context.attachRuntimeHandles(session, { speak });
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    const pendingSpeech = runtime.speak(
      session.id,
      "Answer the current question",
      undefined,
      refreshCurrent,
    );
    await submissionStarted.promise;
    expect(speak).toHaveBeenCalledExactlyOnceWith(
      "Answer the current question",
      expect.any(Function),
      refreshCurrent,
    );
    expect(refreshCurrent).toHaveBeenCalledOnce();
    sourceRefresh.reject(refreshFailed);

    await expect(pendingSpeech).rejects.toBe(refreshFailed);
  });

  it("treats an unknown microphone state as transiently unverified", async () => {
    const { runtime } = createTestRuntime({
      talkBack: true,
      releaseBrowserTab: async () => true,
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          hasAudioBridge: true,
          health: { inCall: true },
        };
        return {};
      },
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "main",
    });

    expect(runtime.refreshSpeechReadiness(session)).toEqual({
      ready: false,
      reason: "browser-unverified",
      message: "browser unverified",
    });
    expect(session.browser?.health).toMatchObject({
      speechReady: false,
      speechBlockedReason: "browser-unverified",
    });

    session.browser!.health = { ...session.browser?.health, micMuted: false };
    expect(runtime.refreshSpeechReadiness(session)).toEqual({ ready: true });
  });
});
