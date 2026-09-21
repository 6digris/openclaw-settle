/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionProgressCardController } from "../../components/session-progress-card-controller.ts";
import { sessionProgressCardsForGateway } from "../../lib/session-progress-cards.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import type { GatewayRequestHandler } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { resetChatHistoryProjection } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import {
  createGatewayBrowserClientFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import { adoptStartedChatRun } from "./run-lifecycle.ts";

const history = {
  sessionId: "research-notes",
  sessionInfo: {
    key: "agent:research:notes",
    agentId: "research",
    sessionId: "research-notes",
    kind: "direct",
    updatedAt: 1,
  },
  messages: [{ role: "assistant", content: [{ type: "text", text: "Research transcript" }] }],
} satisfies ChatHistoryResult;

function progressCard(revision = 1): ProgressCard {
  return {
    sessionKey: "agent:research:notes",
    markdown: `Research progress ${revision}`,
    revision,
    updatedAt: 1_700_000_000_000 + revision,
  };
}

function createHistoryProgressPane(request: GatewayRequestHandler) {
  const client = createGatewayBrowserClientFixture({ request });
  const { pane, state, sessions } = createTestChatPane({ client });
  const hello = gatewayHelloForMethods(["chat.history", "progressCard.get", "progressCard.put"]);
  pane.context.gateway.snapshot.hello = hello;
  state.hello = hello;
  state.agentsList = {
    defaultId: "main",
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id: "main" }, { id: "research" }],
  };
  state.assistantAgentId = "main";
  pane.sessionKey = "notes";
  state.sessionKey = "notes";
  state.settings = { sessionKey: "notes", lastActiveSessionKey: "notes" } as typeof state.settings;
  const presentation = pane as TestChatPane & {
    progressCard: SessionProgressCardController;
    progressCardPresentation: () => {
      card: ProgressCard;
      identity: string;
      initiallyCollapsed: boolean;
      initialRunId: string | null;
    } | null;
  };
  const progress = presentation.progressCard;
  onTestFinished(() => progress.hostDisconnected());
  progress.hostConnected();
  const emit = (card: ProgressCard) => {
    const gateway = pane.context.gateway as ApplicationContext["gateway"] & {
      emitTestEvent: (event: GatewayEventFrame) => void;
    };
    gateway.emitTestEvent({
      type: "event",
      event: "progressCard.changed",
      payload: { sessionKey: card.sessionKey, revision: card.revision },
    });
  };
  return { pane, state, sessions, progress, emit, presentation };
}

function stubPresentationFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return () => {
    const queued = [...frames.values()];
    frames.clear();
    for (const callback of queued) {
      callback(performance.now());
    }
  };
}

describe("retained bare pane progress follows accepted history ownership", () => {
  it("loads, refreshes and dismisses the history owner's card without rekeying the composer", async () => {
    let card: ProgressCard | null = progressCard();
    const request = vi.fn(async (method: string) => {
      if (method === "chat.history") {
        return history;
      }
      if (method === "progressCard.put") {
        card = null;
      }
      return { card };
    });
    const { state, progress, emit } = createHistoryProgressPane(request);
    state.chatMessage = "Retained draft";
    progress.hostUpdate();
    expect(request).not.toHaveBeenCalled();

    await loadChatHistory(state, { deferBranches: true });
    expect(request).toHaveBeenCalledWith(
      "chat.history",
      {
        sessionKey: "notes",
        limit: 80,
        maxBytes: 256 * 1024,
      },
      { signal: expect.any(AbortSignal) },
    );
    progress.hostUpdate();
    await vi.waitFor(() => expect(progress.card).toEqual(card));
    expect(request).toHaveBeenLastCalledWith("progressCard.get", {
      sessionKey: "agent:research:notes",
    });
    expect(state.sessionKey).toBe("notes");
    expect(state.chatMessage).toBe("Retained draft");
    expect(resolveUiConversationIdentity(state, state.sessionKey)).toEqual({ sessionKey: "notes" });

    card = progressCard(2);
    emit(card);
    await vi.waitFor(() => expect(progress.card).toEqual(card));
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(2);
    expect(await progress.dismiss(expectDefined(progress.card, "displayed progress card"))).toBe(
      true,
    );
    expect(request).toHaveBeenLastCalledWith("progressCard.put", {
      sessionKey: "agent:research:notes",
      expectedRevision: 2,
    });
    expect(progress.card).toBeNull();
  });

  it("hides progress without clearing saved progress, then restores updates", async () => {
    let card = progressCard();
    const request = vi.fn(async (method: string) =>
      method === "chat.history" ? history : { card },
    );
    const { state, progress, emit, presentation } = createHistoryProgressPane(request);
    state.settings.chatShowTaskProgress = false;
    await loadChatHistory(state, { deferBranches: true });
    progress.hostUpdate();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
    expect(presentation.progressCardPresentation()).toBeNull();

    state.settings.chatShowTaskProgress = true;
    progress.hostUpdate();
    await vi.waitFor(() => expect(presentation.progressCardPresentation()?.card).toEqual(card));

    state.settings.chatShowTaskProgress = false;
    progress.hostUpdate();
    expect(presentation.progressCardPresentation()).toBeNull();
    card = progressCard(2);
    emit(card);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "chat.history",
      "progressCard.get",
    ]);

    state.settings.chatShowTaskProgress = true;
    progress.hostUpdate();
    await vi.waitFor(() => expect(presentation.progressCardPresentation()?.card).toEqual(card));
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "chat.history",
      "progressCard.get",
      "progressCard.get",
    ]);
  });

  it.each([
    { raw: "notes", canonical: "agent:research:notes", request: { key: "agent:research:notes" } },
    { raw: "unknown", canonical: "unknown", request: { key: "unknown", agentId: "research" } },
  ])("binds Swarm parent reads to accepted $raw history", async (target) => {
    const session: GatewaySessionRow = {
      ...expectDefined(history.sessionInfo, "accepted history session"),
      key: target.canonical,
      agentId: "research",
      kind: "direct",
    };
    const request = vi.fn(async (method: string) =>
      method === "chat.history"
        ? { ...history, sessionInfo: session }
        : method === "sessions.describe"
          ? { session }
          : { card: null },
    );
    const { pane, state, sessions } = createHistoryProgressPane(request);
    vi.spyOn(sessions, "canonicalListRevision", "get").mockReturnValue(1);
    vi.spyOn(sessions, "list").mockResolvedValue(
      createSessionsListResult({ omitSessionFromList: true }),
    );
    pane.sessionKey = target.raw;
    state.sessionKey = target.raw;
    state.settings = {
      ...state.settings,
      sessionKey: target.raw,
      lastActiveSessionKey: target.raw,
    };
    const swarmPane = pane as TestChatPane & {
      refreshSwarmRoster: () => void;
      swarmHydrator?: { dispose: () => void; rows: GatewaySessionRow[] };
    };
    onTestFinished(() => swarmPane.swarmHydrator?.dispose());
    swarmPane.refreshSwarmRoster();
    expect(request).not.toHaveBeenCalled();
    await loadChatHistory(state, { deferBranches: true });
    swarmPane.refreshSwarmRoster();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("sessions.describe", target.request),
    );
    await vi.waitFor(() => expect(swarmPane.swarmHydrator?.rows).toContainEqual(session));
    expect(state.sessionKey).toBe(target.raw);
  });

  it.each([
    "navigation",
    "reconnect",
    "client replacement",
    "disconnect",
    "session replacement",
    "history reset",
    "archive",
  ] as const)("retires the accepted progress identity after %s", async (transition) => {
    const card = progressCard();
    const request = vi.fn(async (method: string) =>
      method === "chat.history" ? history : { card },
    );
    const { pane, state, progress, presentation } = createHistoryProgressPane(request);
    await loadChatHistory(state, { deferBranches: true });
    progress.hostUpdate();
    await vi.waitFor(() => expect(progress.card).toEqual(card));

    const presented = presentation.progressCardPresentation();
    expect(presented?.card).toEqual(card);

    if (transition === "navigation") {
      state.sessionKey = "scratch";
    } else if (transition === "reconnect") {
      state.connectionEpoch += 1;
    } else if (transition === "client replacement") {
      state.client = { request } as unknown as GatewayBrowserClient;
      pane.context.gateway.snapshot.client = state.client;
    } else if (transition === "disconnect") {
      state.connected = false;
    } else if (transition === "session replacement") {
      state.currentSessionId = "replacement-notes";
    } else if (transition === "archive") {
      state.selectedChatSessionArchived = true;
    } else {
      resetChatHistoryProjection(state);
    }
    progress.hostUpdate();
    expect(progress.card).toBeNull();
    expect(presentation.progressCardPresentation()).toEqual(
      transition === "reconnect" || transition === "disconnect" ? presented : null,
    );
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(1);
  });

  it("does not adopt a stale history reply after navigation", async () => {
    const old = createDeferred<ChatHistoryResult>();
    const request = vi.fn(() => old.promise);
    const { state, progress } = createHistoryProgressPane(request);
    const load = loadChatHistory(state, { deferBranches: true });
    state.sessionKey = "scratch";
    old.resolve(history);
    expect(await load).toBeUndefined();
    progress.hostUpdate();
    expect(progress.card).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps accepted progress through a same-session background history refresh", async () => {
    const refreshed = createDeferred<ChatHistoryResult>();
    let historyReads = 0;
    const card = progressCard();
    const request = vi.fn((method: string) => {
      if (method === "chat.history") {
        return ++historyReads === 1 ? Promise.resolve(history) : refreshed.promise;
      }
      return Promise.resolve({ card });
    });
    const { state, progress } = createHistoryProgressPane(request);
    await loadChatHistory(state, { deferBranches: true });
    progress.hostUpdate();
    await vi.waitFor(() => expect(progress.card).toEqual(card));

    const refreshing = loadChatHistory(state, { deferBranches: true });
    progress.hostUpdate();
    expect(progress.card).toEqual(card);
    refreshed.resolve(history);
    await refreshing;
    progress.hostUpdate();
    expect(progress.card).toEqual(card);
    expect(request.mock.calls.filter(([method]) => method === "progressCard.get")).toHaveLength(1);
  });

  it("mounts late progress closed when history refresh starts before the presentation frame", async () => {
    const paint = stubPresentationFrames();
    const firstProgress = createDeferred<{ card: ProgressCard }>();
    const refreshed = createDeferred<ChatHistoryResult>();
    let historyReads = 0;
    const request = vi.fn((method: string) =>
      method === "chat.history"
        ? ++historyReads === 1
          ? Promise.resolve(history)
          : refreshed.promise
        : firstProgress.promise,
    );
    const { state, progress, presentation } = createHistoryProgressPane(request);
    await loadChatHistory(state, { deferBranches: true });
    progress.hostUpdate();
    expect(presentation.progressCardPresentation()).toBeNull();
    const refreshing = loadChatHistory(state, { deferBranches: true });
    try {
      progress.hostUpdate();
      expect(state.chatMessages).toMatchObject(history.messages);
      expect(presentation.progressCardPresentation()).toBeNull();
      // The accepted transcript stays visible while its replacement is pending.
      // Deliver precisely the queued first presentation frame during that read.
      paint();
      const card = progressCard();
      firstProgress.resolve({ card });
      await vi.waitFor(() => expect(progress.card).toEqual(card));
      expect(presentation.progressCardPresentation()).toMatchObject({
        card,
        initiallyCollapsed: true,
      });
      expect(state.chatMessages).toMatchObject(history.messages);
    } finally {
      refreshed.resolve(history);
      await refreshing;
    }
  });

  it.each(["known", "before-frame", "after-frame", "empty", "error"] as const)(
    "decides the first disclosure before returning the card (%s)",
    async (arrival) => {
      const paint = stubPresentationFrames();
      let pending = createDeferred<{ card: ProgressCard | null }>();
      const request = vi.fn((method: string) =>
        method === "chat.history" ? Promise.resolve(history) : pending.promise,
      );
      const { state, progress, presentation, emit } = createHistoryProgressPane(request);
      await loadChatHistory(state, { deferBranches: true });
      progress.hostUpdate();
      const card = progressCard();
      if (arrival !== "known") {
        expect(presentation.progressCardPresentation()).toBeNull();
      }
      if (arrival === "after-frame" || arrival === "empty" || arrival === "error") {
        paint();
      }
      if (arrival === "empty" || arrival === "error") {
        if (arrival === "empty") {
          pending.resolve({ card: null });
          await vi.waitFor(() => expect(progress.loading).toBe(false));
        } else {
          pending.reject(new Error("Temporary progress failure"));
          await vi.waitFor(() => expect(progress.error).toBe("unavailable"));
        }
        expect(presentation.progressCardPresentation()).toBeNull();
        pending = createDeferred<{ card: ProgressCard | null }>();
        emit(card);
        expect(presentation.progressCardPresentation()).toBeNull();
      }
      pending.resolve({ card });
      await vi.waitFor(() => expect(progress.card).toEqual(card));
      const expected = arrival !== "known" && arrival !== "before-frame";
      expect(presentation.progressCardPresentation()).toMatchObject({
        card,
        initiallyCollapsed: expected,
      });
      paint();
      expect(presentation.progressCardPresentation()).toMatchObject({
        card,
        initiallyCollapsed: expected,
      });
      // Refreshes retain the decision instead of reclassifying each revision.
      pending = createDeferred<{ card: ProgressCard | null }>();
      emit(progressCard(2));
      expect(presentation.progressCardPresentation()).toMatchObject({
        card,
        initiallyCollapsed: expected,
      });
      pending.resolve({ card: progressCard(2) });
      await vi.waitFor(() => expect(progress.card?.revision).toBe(2));
      expect(presentation.progressCardPresentation()?.initiallyCollapsed).toBe(expected);
      // A successful empty refresh unmounts the card, not this visit's disclosure decision.
      pending = createDeferred<{ card: ProgressCard | null }>();
      emit(progressCard(3));
      pending.resolve({ card: null });
      await vi.waitFor(() => expect(progress.card).toBeNull());
      expect(presentation.progressCardPresentation()).toBeNull();
      pending = createDeferred<{ card: ProgressCard | null }>();
      emit(progressCard(4));
      pending.resolve({ card: progressCard(4) });
      await vi.waitFor(() => expect(progress.card?.revision).toBe(4));
      expect(presentation.progressCardPresentation()?.initiallyCollapsed).toBe(expected);
    },
  );

  it.each(["document", "pane", "disabled", "detached", "client", "session"] as const)(
    "does not count an ineligible %s frame as a visible progress wait",
    async (change) => {
      const paint = stubPresentationFrames();
      const pending = createDeferred<{ card: ProgressCard }>();
      const request = vi.fn((method: string) =>
        method === "chat.history" ? Promise.resolve(history) : pending.promise,
      );
      const { pane, state, progress, presentation } = createHistoryProgressPane(request);
      await loadChatHistory(state, { deferBranches: true });
      progress.hostUpdate();
      expect(presentation.progressCardPresentation()).toBeNull();
      const client = state.client;
      const sessionKey = state.sessionKey;
      const visibility = vi.spyOn(document, "visibilityState", "get");
      onTestFinished(() => {
        visibility.mockRestore();
      });
      if (change === "document") {
        visibility.mockReturnValue("hidden");
      }
      if (change === "pane") {
        pane.presented = false;
      }
      if (change === "disabled") {
        state.settings.chatShowTaskProgress = false;
      }
      if (change === "detached") {
        Object.defineProperty(pane, "isConnected", { value: false });
      }
      if (change === "client") {
        state.client = createGatewayBrowserClientFixture({ request });
      }
      if (change === "session") {
        state.sessionKey = "another-session";
      }
      paint();
      visibility.mockRestore();
      pane.presented = true;
      state.settings.chatShowTaskProgress = true;
      Object.defineProperty(pane, "isConnected", { value: true });
      state.client = client;
      state.sessionKey = sessionKey;
      const card = progressCard();
      pending.resolve({ card });
      await vi.waitFor(() => expect(progress.card).toEqual(card));
      expect(presentation.progressCardPresentation()).toMatchObject({
        card,
        initiallyCollapsed: false,
      });
      paint();
      expect(presentation.progressCardPresentation()?.initiallyCollapsed).toBe(false);
    },
  );

  it.each(["history", "outbox"] as const)(
    "retains the initial run learned from delayed %s recovery across an empty refresh",
    async (source) => {
      const paint = stubPresentationFrames();
      let snapshot: ProgressCard | null = null;
      const request = vi.fn(async (method: string) =>
        method === "chat.history" ? history : { card: snapshot },
      );
      const { pane, state, progress, presentation, emit } = createHistoryProgressPane(request);
      pane.sessionKey = history.sessionInfo.key;
      state.sessionKey = history.sessionInfo.key;
      await loadChatHistory(state, { deferBranches: true });
      progress.hostUpdate();
      expect(presentation.progressCardPresentation()).toBeNull();
      paint();
      snapshot = progressCard();
      emit(snapshot);
      await vi.waitFor(() => expect(progress.card).toEqual(snapshot));
      expect(presentation.progressCardPresentation()).toMatchObject({
        initiallyCollapsed: true,
        initialRunId: null,
      });
      if (source === "history") {
        state.chatRunId = "recovered";
        state.chatRecoveredRunId = "recovered";
      } else {
        state.sessionsResult = {
          ...createSessionsListResult(),
          sessions: [{ ...history.sessionInfo, hasActiveRun: true, activeRunIds: ["recovered"] }],
        };
        state.chatQueue = [
          {
            id: "pending",
            text: "Reconnect",
            createdAt: 1,
            sendRunId: "recovered",
            sendState: "waiting-reconnect",
          },
        ];
      }
      expect(presentation.progressCardPresentation()?.initialRunId).toBe("recovered");
      snapshot = null;
      emit(progressCard(2));
      await vi.waitFor(() => expect(progress.card).toBeNull());
      expect(presentation.progressCardPresentation()).toBeNull();
      // Live adoption of that same already-recovered task is not a new local task.
      state.chatRunId = "recovered";
      state.chatRecoveredRunId = undefined;
      snapshot = progressCard(3);
      emit(snapshot);
      await vi.waitFor(() => expect(progress.card).toEqual(snapshot));
      expect(presentation.progressCardPresentation()).toMatchObject({
        initiallyCollapsed: true,
        initialRunId: "recovered",
      });
    },
  );

  it("does not infer an existing progress owner from a missing history row", async () => {
    const request = vi.fn(async () => ({
      messages: [],
      sessionInfo: {
        key: "agent:research:notes",
        agentId: "research",
        kind: "direct",
        updatedAt: null,
      },
    }));
    const { state, progress } = createHistoryProgressPane(request);
    await loadChatHistory(state, { deferBranches: true });
    progress.hostUpdate();
    expect(progress.card).toBeNull();
    expect(request).toHaveBeenCalledOnce();
  });
});

it.each([false, true])(
  "keeps the new local run default when its first card arrives later (finished: %s)",
  async (finishedBeforeCard) => {
    const paint = stubPresentationFrames();
    let pending = createDeferred<{ card: ProgressCard | null }>();
    const request = vi.fn((method: string) =>
      method === "chat.history" ? Promise.resolve(history) : pending.promise,
    );
    const { pane, state, progress, presentation, emit } = createHistoryProgressPane(request);
    await loadChatHistory(state, { deferBranches: true });
    progress.hostUpdate();
    const store = sessionProgressCardsForGateway(pane.context.gateway);
    const target = { sessionKey: history.sessionInfo.key };
    const firstRead = store.load(target);
    expect(presentation.progressCardPresentation()).toBeNull();
    paint();
    adoptStartedChatRun(state, "new-local-submission", 1_700_000_000_000);
    expect(state.chatRecoveredRunId).toBeUndefined();
    expect(presentation.progressCardPresentation()).toBeNull();
    if (finishedBeforeCard) {
      state.chatRunId = null;
      expect(presentation.progressCardPresentation()).toBeNull();
    }
    pending.resolve({ card: progressCard() });
    await firstRead;
    expect(presentation.progressCardPresentation()).toMatchObject({
      card: progressCard(),
      initiallyCollapsed: false,
    });
    pending = createDeferred<{ card: ProgressCard | null }>();
    emit(progressCard(2));
    const emptyRead = store.load(target);
    pending.resolve({ card: null });
    await emptyRead;
    expect(presentation.progressCardPresentation()).toBeNull();
    pending = createDeferred<{ card: ProgressCard | null }>();
    emit(progressCard(3));
    const remountRead = store.load(target);
    pending.resolve({ card: progressCard(3) });
    await remountRead;
    expect(presentation.progressCardPresentation()).toMatchObject({
      card: progressCard(3),
      initiallyCollapsed: false,
    });
  },
);
