import { describe, expect, it, vi } from "vitest";
import {
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
} from "../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../sessions/user-turn-transcript.test-support.js";
import type { AgentMessage } from "./runtime/index.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { SessionManager } from "./sessions/session-manager.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

function messages(manager: SessionManager) {
  return manager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

function userContents(manager: SessionManager) {
  return messages(manager)
    .filter((message) => message.role === "user")
    .map((message) => message.content);
}

describe("prepared-attempt user persistence suppression", () => {
  it("suppresses only one user on fresh installation", () => {
    const manager = guardSessionManager(SessionManager.inMemory(), {
      runId: "same-run",
      suppressNextUserMessagePersistence: true,
    });
    manager.appendMessage({ role: "user", content: "internal", timestamp: 1 });
    manager.appendMessage({ role: "user", content: "human", timestamp: 2 });
    expect(userContents(manager)).toEqual(["human"]);
  });

  it("re-arms each finalization pass on the same run and preserves the real follow-up", () => {
    const persisted = vi.fn<(message: AgentMessage) => void>();
    const manager = guardSessionManager(SessionManager.inMemory(), {
      runId: "same-run",
      onMessagePersisted: persisted,
    });
    const flush = manager.flushPendingToolResults;
    manager.appendMessage({ role: "user", content: "human", timestamp: 1 });
    for (const text of ["first finalization", "empty-answer retry"]) {
      expect(
        guardSessionManager(manager, {
          runId: "same-run",
          suppressNextUserMessagePersistence: true,
        }),
      ).toBe(manager);
      expect(manager.flushPendingToolResults).toBe(flush);
      manager.appendMessage({ role: "user", content: text, timestamp: 2 });
      manager.appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: "answer" }] }),
      );
    }
    guardSessionManager(manager, { runId: "next-run" });
    manager.appendMessage({ role: "user", content: "follow-up", timestamp: 3 });
    expect(userContents(manager)).toEqual(["human", "follow-up"]);
    expect(messages(manager).filter((message) => message.role === "assistant")).toHaveLength(2);
    expect(persisted.mock.calls.map(([message]) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
    ]);
  });

  it.each([undefined, false])(
    "clears unconsumed suppression on the next prepared attempt: %s",
    (suppress) => {
      const manager = guardSessionManager(SessionManager.inMemory(), {
        runId: "same-run",
        suppressNextUserMessagePersistence: true,
      });
      guardSessionManager(manager, {
        runId: "same-run",
        suppressNextUserMessagePersistence: suppress,
      });
      manager.appendMessage({
        role: "user",
        content: "human after cancelled preparation",
        timestamp: 1,
      });
      expect(userContents(manager)).toEqual(["human after cancelled preparation"]);
    },
  );

  it("retains the installed guard and pending real tool result while preparing finalization", () => {
    const persisted = vi.fn<(message: AgentMessage) => void>();
    const manager = guardSessionManager(SessionManager.inMemory(), {
      runId: "same-run",
      onMessagePersisted: persisted,
    });
    const flush = manager.flushPendingToolResults;
    manager.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "pending-read", name: "read", arguments: {} }],
        stopReason: "toolUse",
      }),
    );
    expect(manager.hasPendingToolResults?.()).toBe(true);
    guardSessionManager(manager, { runId: "same-run", suppressNextUserMessagePersistence: true });
    expect(manager.flushPendingToolResults).toBe(flush);
    expect(manager.hasPendingToolResults?.()).toBe(true);
    manager.appendMessage({
      role: "toolResult",
      toolCallId: "pending-read",
      toolName: "read",
      content: [{ type: "text", text: "completed receipt" }],
      isError: false,
      timestamp: 1,
    });
    expect(manager.hasPendingToolResults?.()).toBe(false);
    manager.appendMessage({ role: "user", content: "internal", timestamp: 2 });
    expect(userContents(manager)).toEqual([]);
    expect(persisted.mock.calls.map(([message]) => message.role)).toEqual([
      "assistant",
      "toolResult",
    ]);
    expect(messages(manager).filter((message) => message.role === "toolResult")).toEqual([
      expect.objectContaining({
        toolCallId: "pending-read",
        content: [{ type: "text", text: "completed receipt" }],
      }),
    ]);
  });

  it.each([false, true])(
    "does not blanket-suppress the next user after canonical prepared-user replay: reused=%s",
    (reused) => {
      const manager = SessionManager.inMemory();
      if (reused) {
        guardSessionManager(manager, { runId: "same-run" });
      }
      const canonical: PersistedUserTurnMessage = {
        role: "user",
        content: "canonical",
        timestamp: 1,
        idempotencyKey: "canonical-key",
      };
      manager.appendMessage(canonical);
      const recorder = createUserTurnTranscriptRecorder({
        message: canonical,
        target: createTestUserTurnTranscriptTarget(),
      });
      recorder.markRuntimePersisted(canonical, undefined, { appended: false });
      const prepared = recorder.message;
      if (!prepared) {
        throw new Error("Expected prepared canonical user");
      }
      guardSessionManager(manager, {
        runId: "same-run",
        preparedUserTurnMessage: prepared,
        preparedUserTurnTranscriptRecorder: recorder,
        suppressNextUserMessagePersistence: true,
      });
      // The prepared canonical user is replayed without another append; queued input is new.
      manager.appendMessage({ role: "user", content: "queued human", timestamp: 2 });
      expect(userContents(manager)).toEqual(["canonical", "queued human"]);
      const users = messages(manager).filter((message) => message.role === "user");
      expect(users[0]).toMatchObject({ idempotencyKey: "canonical-key" });
      expect(users[1]).not.toMatchObject({ idempotencyKey: "canonical-key" });
    },
  );
});
