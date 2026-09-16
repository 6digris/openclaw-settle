// @vitest-environment node
import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionGoal } from "../../api/types.ts";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createChatGoalProps } from "./chat-goals.ts";
import { makeChatHost } from "./chat-host.test-support.ts";

const goal: SessionGoal = {
  schemaVersion: 1,
  id: "goal-a",
  objective: "Review the UI",
  status: "paused",
  createdAt: 1,
  updatedAt: 2,
  tokenStart: 0,
  tokensUsed: 10,
  continuationTurns: 0,
};

afterEach(() => vi.restoreAllMocks());

function goalHost(requestHandlers: Record<string, unknown>) {
  const host = makeChatHost({
    currentSessionId: "session-a",
    chatMessage: "Unrelated draft",
    sessionsResult: {
      ...createSessionsListResult(),
      sessions: [{ key: "agent:main", kind: "direct", updatedAt: 2, goal }],
    },
    requestHandlers,
  });
  return Object.assign(host, {
    handleSendChat: vi.fn(async () => true),
    handleChatDraftChange: vi.fn(),
  });
}

describe("Goal render props", () => {
  it("commits goal mode before refreshing the invocation-time draft", () => {
    const host = Object.assign(goalHost({}), {
      handleSendChat: vi.fn(async () => true),
      handleChatDraftChange: vi.fn((message: string): void => {
        expect(host.chatGoalDraftMode).toEqual({ action: "start", sessionId: "session-a" });
        expect(message).toBe("Updated draft");
      }),
    });
    const props = createChatGoalProps(host, true);
    expect(props.goalDraftMode).toBeNull();
    expect(props.currentSessionId).toBe("session-a");
    host.chatMessage = "Updated draft";
    props.onGoalDraftModeChange({ action: "start", sessionId: "session-a" });
    expect(host.handleChatDraftChange).toHaveBeenCalledExactlyOnceWith("Updated draft");
    expect(createChatGoalProps(host, true).goalDraftMode).toBe(host.chatGoalDraftMode);
  });

  it.each([
    [true, "function"],
    [false, "undefined"],
  ] as const)(
    "keeps goal actions available when submit eligibility is %s",
    async (canSubmit, expectedType) => {
      const host = Object.assign(
        goalHost({
          "sessions.goal.update": { status: "updated", goalId: goal.id, goal },
        }),
        {
          handleSendChat: vi.fn(async () => true),
          handleChatDraftChange: vi.fn(),
        },
      );
      const props = createChatGoalProps(host, canSubmit);
      expect(typeof props.onGoalSubmit).toBe(expectedType);
      expect(props.onGoalAction(goal.id, "pause")).toBeUndefined();
      expect(host.request).toHaveBeenCalledWith(
        "sessions.goal.update",
        expect.objectContaining({
          goalId: goal.id,
          action: "pause",
          sessionId: "session-a",
        }),
      );
      await Promise.resolve();
    },
  );

  it("forwards the submission event and returns the goal owner's pending result", async () => {
    const pending = createDeferred<boolean>();
    const host = Object.assign(goalHost({}), {
      handleSendChat: vi.fn(() => pending.promise),
      handleChatDraftChange: vi.fn(),
    });
    host.chatMessage = "Review the UI";
    const props = createChatGoalProps(host, true);
    assert(props.onGoalSubmit);
    const event = new Event("submit");
    const result = props.onGoalSubmit({ action: "start", objective: host.chatMessage }, event);
    expect(result).toBeInstanceOf(Promise);
    expect(host.handleSendChat).toHaveBeenCalledExactlyOnceWith(
      undefined,
      { intent: { kind: "session-goal-start", version: 1, issuedAtMs: expect.any(Number) } },
      event,
    );
    pending.resolve(false);
    expect(await result).toBe(false);
  });
});

describe("Goal control requests", () => {
  it("edits literal objective text through the typed owner and leaves the chat draft alone", async () => {
    const objective = "  /goal clear\n  is literal text ";
    const host = goalHost({
      "sessions.goal.update": {
        status: "updated",
        goalId: goal.id,
        goal: { ...goal, objective, updatedAt: 3 },
      },
    });
    const { onGoalSubmit } = createChatGoalProps(host, true);
    assert(onGoalSubmit);
    expect(await onGoalSubmit({ action: "edit", goalId: goal.id, objective })).toBe(true);
    expect(host.request).toHaveBeenCalledWith(
      "sessions.goal.update",
      expect.objectContaining({
        sessionKey: host.sessionKey,
        sessionId: "session-a",
        goalId: goal.id,
        operationId: expect.any(String),
        issuedAtMs: expect.any(Number),
        action: "edit",
        objective,
      }),
    );
    expect(host.sessions.state.result?.sessions[0]?.goal?.objective).toBe(objective);
    expect(host.chatMessage).toBe("Unrelated draft");
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });

  it("adopts a fresh Resume run without inventing a user message", async () => {
    const host = goalHost({
      "sessions.goal.update": {
        status: "started",
        goalId: goal.id,
        runId: "resume-run",
        goal: { ...goal, status: "active", updatedAt: 3 },
      },
    });
    createChatGoalProps(host, true).onGoalAction(goal.id, "resume");
    await vi.waitFor(() => expect(host.chatRunId).toBe("resume-run"));
    expect(host.chatMessages).toEqual([]);
    expect(host.chatMessage).toBe("Unrelated draft");
  });

  it("reuses a lost-ACK operation and refreshes replayed state without resurrecting the run", async () => {
    let fail = true;
    const host = goalHost({
      "sessions.goal.update": () => {
        if (fail) {
          throw new Error("Gateway disconnected before the acknowledgment");
        }
        return {
          status: "started",
          goalId: goal.id,
          runId: "old-resume-run",
          replayed: true,
          goal: { ...goal, status: "active" },
        };
      },
    });
    const refresh = vi.spyOn(host.sessions, "refresh").mockResolvedValue();
    const props = createChatGoalProps(host, true);
    props.onGoalAction(goal.id, "resume");
    await vi.waitFor(() =>
      expect(host.lastError).toBe("Gateway disconnected before the acknowledgment"),
    );
    const firstRequest = host.request.mock.calls.find(
      ([method]) => method === "sessions.goal.update",
    )?.[1];
    fail = false;
    host.client = createTestGatewayClient(host.request);
    host.connectionEpoch += 1;
    props.onGoalAction(goal.id, "resume");
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    const requests = host.request.mock.calls.filter(
      ([method]) => method === "sessions.goal.update",
    );
    expect(requests[1]?.[1]).toEqual(firstRequest);
    expect(refresh).toHaveBeenCalledOnce();
    expect(host.chatRunId).toBeNull();
    expect(host.sessions.state.result?.sessions[0]?.goal?.status).toBe("paused");
  });

  it("does not apply a delayed clear to a replacement goal", async () => {
    const pending = createDeferred<{ status: string; goalId: string }>();
    const host = goalHost({ "sessions.goal.clear": () => pending.promise });
    createChatGoalProps(host, true).onGoalAction(goal.id, "clear");
    // The next update comes from the mutation owner after the deferred RPC settles.
    const settled = createDeferred();
    host.requestUpdate = () => settled.resolve();
    host.sessions.patchRowLocal(host.sessionKey, { goal: { ...goal, id: "replacement-goal" } });
    pending.resolve({ status: "cleared", goalId: goal.id });
    await settled.promise;
    expect(host.sessions.state.result?.sessions[0]?.goal?.id).toBe("replacement-goal");
  });

  it("does not apply a delayed Resume to a different visible session", async () => {
    const pending = createDeferred<{ status: string; goalId: string; runId: string }>();
    const host = goalHost({ "sessions.goal.update": () => pending.promise });
    createChatGoalProps(host, true).onGoalAction(goal.id, "resume");
    const settled = createDeferred();
    host.requestUpdate = () => settled.resolve();
    host.sessionKey = "agent:main:other";
    host.currentSessionId = "session-b";
    pending.resolve({ status: "started", goalId: goal.id, runId: "old-session-run" });
    await settled.promise;
    expect(host.chatRunId).toBeNull();
    expect(host.chatMessage).toBe("Unrelated draft");
  });
});
