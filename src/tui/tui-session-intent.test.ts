import { describe, expect, it, vi } from "vitest";
import { createCommandHarness as createHarness } from "./tui-command-handlers.test-support.js";
import {
  createBaseState,
  createTestSessionActions,
  makeTuiBackend,
} from "./tui-session-actions-test-support.js";
import { resolveTuiSessionSelection } from "./tui.js";

describe("TUI Home and exact session intent", () => {
  it("carries Home intent through command sends, settings, reset, and successor creation", async () => {
    const harness = createHarness({ currentSessionIntent: "home", currentSessionId: "home-id" });
    await harness.sendMessage("hello");
    expect(harness.sendChat).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        targetIntent: "home",
      }),
    );
    harness.state.pendingSubmit = null;
    harness.state.activeChatRunId = null;
    await harness.handleCommand("/think high");
    expect(harness.patchSession).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "agent:main:main",
        targetIntent: "home",
      }),
    );
    await harness.handleCommand("/reset");
    expect(harness.resetSession).toHaveBeenCalledWith("agent:main:main", "reset", {
      targetIntent: "home",
    });
    await harness.handleCommand("/new");
    expect(harness.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionKey: "agent:main:main",
        parentTargetIntent: "home",
      }),
    );
  });

  it.each(["", "main", "agent:research:main"])(
    "preserves selector intent through history, abort, and scope refresh for %j",
    async (initialSessionInput) => {
      const state = createBaseState({
        currentAgentId: "research",
        currentSessionKey: "agent:research:main",
        sessionMainKey: "main",
        sessionScope: "per-sender",
        initialSessionApplied: false,
      });
      const loadHistory = vi.fn(async ({ sessionKey }: { sessionKey: string }) => ({
        messages: [],
        sessionInfo: { key: sessionKey },
      }));
      const abortChat = vi.fn().mockResolvedValue({ ok: true, aborted: false });
      const actions = createTestSessionActions({
        client: makeTuiBackend({ loadHistory, abortChat, listSessions: vi.fn() }),
        state,
        initialSessionInput,
        resolveSessionSelection: (raw, agentId = state.currentAgentId) =>
          resolveTuiSessionSelection({
            raw,
            currentAgentId: agentId,
            cfg: {},
            sessionMainKey: state.sessionMainKey,
            sessionScope: state.sessionScope,
          }),
      });
      const agents = {
        defaultId: "research",
        mainKey: "main",
        scope: "per-sender" as const,
        agents: [{ id: "research" }],
      };
      actions.applyAgentsResult(agents);
      await actions.loadHistory();
      await actions.abortActive();
      const intent = initialSessionInput.startsWith("agent:") ? "exact" : "home";
      expect(state.currentSessionIntent).toBe(intent);
      expect(loadHistory.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          sessionKey: "agent:research:main",
          ...(intent === "home" ? { targetIntent: "home" } : {}),
        }),
      );
      expect(abortChat).toHaveBeenCalledWith({
        sessionKey: "agent:research:main",
        ...(intent === "home" ? { targetIntent: "home" } : {}),
      });
      actions.applyAgentsResult({ ...agents, scope: "global" });
      expect(state.currentSessionKey).toBe(
        intent === "home" ? "agent:research:global" : "agent:research:main",
      );
      expect(state.currentSessionIntent).toBe(intent);
      await actions.setSession("agent:research:global");
      expect(state.currentSessionIntent).toBe("exact");
      actions.applyAgentsResult(agents);
      expect(state.currentSessionKey).toBe("agent:research:global");
      await actions.loadHistory();
      expect(loadHistory.mock.calls.at(-1)?.[0]).not.toHaveProperty("targetIntent");
    },
  );
});
