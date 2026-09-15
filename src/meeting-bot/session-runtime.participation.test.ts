import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  MeetingParticipationAttempt,
  MeetingParticipationOptions,
} from "./participation-types.js";
import { createTestRuntime } from "./session-runtime.test-support.js";
import type { TestSession } from "./session-runtime.test-support.js";
import type { MeetingTranscriptSnapshot } from "./session-types.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("MeetingSessionRuntime participation ownership", () => {
  function participationRuntime(
    params: {
      captureTranscript?: Parameters<typeof createTestRuntime>[0]["captureTranscript"];
      transcribe?: boolean;
    } = {},
  ) {
    const rows = new Map<string, MeetingParticipationAttempt>();
    const execute = vi.fn<MeetingParticipationOptions<TestSession>["execute"]>(async () => ({
      status: "succeeded",
    }));
    const store: MeetingParticipationOptions<TestSession>["store"] = {
      lookup: async (key) => rows.get(key),
      register: async (key, value) => {
        rows.set(key, value);
      },
      registerIfAbsent: async (key, value) => {
        if (rows.has(key)) {
          return false;
        }
        rows.set(key, value);
        return true;
      },
      entries: async () => [...rows].map(([key, value]) => ({ key, value, createdAt: 0 })),
      delete: async (key) => rows.delete(key),
    };
    const { runtime } = createTestRuntime({
      ...params,
      participation: {
        store,
        capabilities: () => ["hand.set"],
        validateAction: () => undefined,
        execute,
      },
      joinTransport: async ({ session }) => {
        session.browser = {
          launched: true,
          tab: { targetId: "tracked-tab", openedByPlugin: false },
          health: { inCall: true },
        };
        return {};
      },
      releaseBrowserTab: async () => true,
    });
    return { runtime, store, execute };
  }

  it("revokes participation as soon as leave starts, while an admitted claim is awaiting storage", async () => {
    const { runtime, store, execute } = participationRuntime();
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    const { promise: pending, resolve: release } = createDeferredCore();
    const { promise: entered, resolve: claimed } = createDeferredCore();
    const register = store.registerIfAbsent;
    store.registerIfAbsent = async (...args) => {
      claimed();
      await pending;
      return await register(...args);
    };
    const action = runtime.participate(session.id, {
      requestId: "raise",
      action: { type: "hand.set", raised: true },
    });
    await entered;
    const leaving = runtime.leave(session.id);
    expect(runtime.participationContext(session.id)).toMatchObject({
      active: false,
      capabilities: [],
    });
    release();
    expect(await action).toMatchObject({ status: "rejected" });
    await leaving;
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not transfer an observed source to a replacement browser tab", async () => {
    const { runtime, execute } = participationRuntime();
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    const sourceId = runtime.observeParticipationSource(session.id, {
      id: "message",
      epoch: "page",
      revision: "1",
      kind: "chat",
      text: "Raise your hand",
      finalized: true,
    });
    expect(sourceId).toBeTruthy();
    session.browser!.tab = { targetId: "replacement-tab", openedByPlugin: false };
    expect(runtime.inspectParticipationSource(session.id, sourceId!)).toBeUndefined();
    expect(
      await runtime.participate(session.id, {
        requestId: "raise",
        sourceId,
        action: { type: "hand.set", raised: true },
      }),
    ).toMatchObject({ status: "rejected" });
    expect(execute).not.toHaveBeenCalled();
    await runtime.leave(session.id);
  });

  it("rejects a caption snapshot if the browser tab changes while capture is pending", async () => {
    const { promise: pending, resolve: release } = createDeferredCore<MeetingTranscriptSnapshot>();
    const { promise: entered, resolve: started } = createDeferredCore();
    const captureTranscript = vi
      .fn<NonNullable<Parameters<typeof createTestRuntime>[0]["captureTranscript"]>>()
      .mockImplementationOnce(async () => {
        started();
        return await pending;
      })
      .mockResolvedValue(undefined);
    const { runtime } = participationRuntime({ captureTranscript, transcribe: true });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    const reading = runtime.transcript(session.id);
    await entered;
    session.browser!.tab = { targetId: "replacement-tab", openedByPlugin: false };
    release({
      droppedLines: 0,
      epoch: "old-page",
      lines: [
        {
          text: "A stale invitation",
          source: {
            id: "old-caption",
            epoch: "old-page",
            revision: "2",
            finalized: true,
            ownEcho: false,
          },
        },
      ],
    });
    await expect(reading).rejects.toThrow("no longer owns the captured browser tab and route");
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 0, sources: [] });
    await runtime.leave(session.id);
  });

  it("records a caption's original order before finalization and revokes it on a pending correction", async () => {
    const source = {
      id: "caption-1",
      epoch: "page-1",
      revision: "1",
      finalized: false,
      ownEcho: false,
    };
    const completed = {
      text: "Please share the recap",
      source: { ...source, revision: "2", finalized: true },
    };
    const snapshots: MeetingTranscriptSnapshot[] = [
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [],
        pendingLines: [{ text: "Please share", source }],
      },
      { droppedLines: 0, epoch: "page-1", lines: [completed], pendingLines: [] },
      {
        droppedLines: 0,
        epoch: "page-1",
        lines: [completed],
        pendingLines: [{ text: "Please wait", source: { ...source, revision: "3" } }],
      },
    ];
    const { runtime } = participationRuntime({
      captureTranscript: async () => snapshots.shift(),
      transcribe: true,
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    await runtime.transcript(session.id);
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 1, sources: [] });
    await runtime.transcript(session.id);
    const context = runtime.participationContext(session.id);
    expect(context).toMatchObject({
      sourceOrder: 1,
      sources: [{ id: "caption-1", kind: "caption", order: 1, finalized: true, ownEcho: false }],
    });
    const sourceId = context.sources[0]?.sourceId;
    expect(sourceId).toBeTruthy();
    await runtime.transcript(session.id);
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 1, sources: [] });
    expect(runtime.inspectParticipationSource(session.id, sourceId!)).toBeUndefined();
    await runtime.leave(session.id);
  });

  it("invalidates caption authority on an empty new epoch without minting a source event", async () => {
    const oldSnapshot: MeetingTranscriptSnapshot = {
      droppedLines: 0,
      epoch: "old-page",
      lines: [
        {
          text: "Please share the recap",
          source: {
            id: "caption-1",
            epoch: "old-page",
            revision: "2",
            finalized: true,
            ownEcho: false,
          },
        },
      ],
    };
    const snapshots: MeetingTranscriptSnapshot[] = [
      oldSnapshot,
      { droppedLines: 0, epoch: "new-page", lines: [], pendingLines: [] },
      oldSnapshot,
    ];
    const { runtime } = participationRuntime({
      captureTranscript: async () => snapshots.shift(),
      transcribe: true,
    });
    const { session } = await runtime.join({
      url: "https://meeting.example/room",
      agentId: "operator",
    });
    await runtime.transcript(session.id);
    const sourceId = runtime.participationContext(session.id).sources[0]?.sourceId;
    expect(sourceId).toBeTruthy();
    await runtime.transcript(session.id);
    expect(runtime.inspectParticipationSource(session.id, sourceId!)).toBeUndefined();
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 1, sources: [] });
    await runtime.transcript(session.id);
    expect(runtime.participationContext(session.id)).toMatchObject({ sourceOrder: 1, sources: [] });
    await runtime.leave(session.id);
  });
});
