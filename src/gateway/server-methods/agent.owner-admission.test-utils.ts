// Imported by agent.test.ts to exercise the registered handler in its existing mock graph.
import { afterEach, describe, expect, it } from "vitest";
import {
  describe0AfterEach0,
  expectRespondError,
  getAgentTestMocks,
  invokeAgent,
  makeContext,
  primeMainAgentRun,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("agent RPC owner admission", () => {
  afterEach(describe0AfterEach0);

  it.each(
    [
      { agentId: "!!!" },
      { agentId: " " },
      { agentId: "" },
      { to: "agent:---:notes" },
      { to: "agent:main" },
      { to: "agent:main:" },
    ].flatMap((target) => [false, true].map((cached) => ({ target, cached }))),
  )(
    "rejects invalid ownership before dispatch (cached=$cached): $target",
    async ({ target, cached }) => {
      primeMainAgentRun();
      const context = makeContext();
      context.getRuntimeConfig = () => ({ agents: { entries: { main: { default: true } } } });
      const idempotencyKey = `invalid-owner-${cached}`;
      if (cached) {
        context.dedupe.set(`agent:${idempotencyKey}`, {
          ts: Date.now(),
          ok: true,
          payload: { runId: "main-canary", status: "ok" },
        });
      }
      const before = [...context.dedupe];
      mocks.loadSessionEntry.mockClear();
      mocks.updateSessionStore.mockClear();
      const respond = await invokeAgent(
        { message: "test", idempotencyKey, ...target },
        { context },
      );
      expectRespondError(respond, { code: "INVALID_REQUEST" });
      expect(context.dedupe.size).toBe(before.length);
      expect([...context.dedupe]).toEqual(before);
      expect(context.chatAbortControllers.size).toBe(0);
      expect(mocks.agentCommand).not.toHaveBeenCalled();
      expect(mocks.loadSessionEntry).not.toHaveBeenCalled();
      expect(mocks.updateSessionStore).not.toHaveBeenCalled();
      expect(mocks.resolveAgentExplicitRecipientSession).not.toHaveBeenCalled();
    },
  );
});
