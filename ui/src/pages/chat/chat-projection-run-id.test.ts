/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import { createInitializationContext, createRenderTestChatPane } from "./chat-pane.test-support.ts";
import * as chatThread from "./chat-thread.ts";
import { createTestTranscript } from "./chat-view.test-helpers.ts";
import { renderChatThread } from "./components/chat-thread.ts";
import { threadProps } from "./components/chat-transcript.test-support.ts";
import { resolveChatProjectionRunId } from "./tool-stream-status.ts";

describe("resolveChatProjectionRunId", () => {
  it("restores only an active run proven by the reconnecting outbox", () => {
    const reconnecting = {
      id: "reconnecting",
      text: "Current prompt",
      createdAt: 1,
      sendRunId: "run-restored",
      sendState: "waiting-reconnect" as const,
    };

    expect(
      resolveChatProjectionRunId({
        activeRunIds: ["run-restored"],
        queue: [reconnecting],
      }),
    ).toBe("run-restored");
    expect(
      resolveChatProjectionRunId({
        activeRunIds: ["run-stale"],
        queue: [reconnecting],
      }),
    ).toBeNull();
    expect(
      resolveChatProjectionRunId({
        localRunId: "run-local",
        activeRunIds: ["run-restored"],
        queue: [reconnecting],
      }),
    ).toBe("run-local");
  });
});

describe("transcript run identity", () => {
  it("marks outbox-only recovery without misclassifying a new local run", () => {
    const pane = createRenderTestChatPane();
    const state = pane.initialize(createInitializationContext());
    state.sessionKey = "agent:main:main";
    state.sessions.reconcile(
      {
        key: state.sessionKey,
        kind: "direct",
        updatedAt: 1,
        hasActiveRun: true,
        activeRunIds: ["restored"],
      },
      createSessionsListResult().defaults,
    );
    state.sessionsResult = state.sessions.state.result;
    state.chatQueue = [
      {
        id: "pending",
        text: "Reconnect",
        createdAt: 1,
        sendRunId: "restored",
        sendState: "waiting-reconnect",
      },
    ];
    pane.render();
    expect(pane.chatProps).toMatchObject({
      runId: "restored",
      progressCardRecoveredRunId: "restored",
    });
    state.chatRecoveredRunId = "restored";
    state.chatRunId = "new-local";
    pane.render();
    expect(pane.chatProps).toMatchObject({
      runId: "new-local",
      progressCardRecoveredRunId: undefined,
    });
  });

  it("does not project a session row's first active run without an explicit run id", () => {
    const build = vi.spyOn(chatThread, "buildCachedChatItems").mockReturnValue([]);

    renderChatThread(
      {
        ...threadProps("run-id-projection"),
        sessions: {
          ts: 0,
          path: "",
          count: 1,
          defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
          sessions: [
            {
              key: "agent:main:main",
              kind: "direct",
              updatedAt: 1,
              hasActiveRun: true,
              activeRunIds: ["arbitrary-first", "other-run"],
            },
          ],
        },
      },
      createTestTranscript(),
    );

    expect(build).toHaveBeenCalledWith(expect.objectContaining({ runId: null }));
  });
});
