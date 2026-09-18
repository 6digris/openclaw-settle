import { describe, expect, it } from "vitest";
import {
  createMinimalRunAgentTurnParams,
  createMockReplyOperation,
  setupAgentRunnerExecutionTestState,
} from "./agent-runner-execution.test-support.js";

const state = await setupAgentRunnerExecutionTestState();
const { executeAgentTurn } = await import("./agent-runner-execution.js");

describe("executeAgentTurn contract", () => {
  it("keeps requester identity separate from the conversation model policy", async () => {
    const params = createMinimalRunAgentTurnParams();
    params.followupRun.run.runtimePolicySessionKey = "agent:main:telegram:default:direct:123";
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { durationMs: 1 },
    });

    const result = await executeAgentTurn(params);

    expect(result.outcome.kind).toBe("settled");
    expect(state.runEmbeddedAgentEntryMock.mock.calls[0]?.[0]).toMatchObject({
      identity: { sessionKey: "main" },
      harness: { sessionKey: "agent:main:telegram:default:direct:123" },
    });
    expect(state.runWithModelFallbackMock.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: "agent:main:telegram:default:direct:123",
    });
  });

  it("returns one closed settled result with winner and fallback facts", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: {
        durationMs: 1,
        agentMeta: { provider: "anthropic", model: "claude-sonnet" },
      },
    });

    const result = await executeAgentTurn(createMinimalRunAgentTurnParams());

    expect(result).toMatchObject({
      runId: expect.any(String),
      outcome: {
        kind: "settled",
        status: "ok",
        resolved: { provider: "anthropic", model: "claude" },
        fallback: { exhausted: false, attempts: [] },
        result: { payloads: [{ text: "done" }] },
      },
    });
  });

  it("keeps publisher-only compaction counts presentation-only after a late user abort", async () => {
    state.runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: "late reply" }],
      meta: { durationMs: 1, agentMeta: { compactionCount: 1, compactionTokensAfter: 40 } },
    });
    const { replyOperation } = createMockReplyOperation();
    let operationResult: typeof replyOperation.result = null;
    const lateAbortedOperation = {
      ...replyOperation,
      get result() {
        return operationResult;
      },
      freezeAbort: () => {
        operationResult = { kind: "aborted", code: "aborted_by_user" };
      },
    };

    const result = await executeAgentTurn(
      createMinimalRunAgentTurnParams({ replyOperation: lateAbortedOperation }),
    );

    expect(result.outcome).toEqual({
      kind: "aborted",
      reason: "user",
      compaction: { count: 1, durable: [] },
    });
  });
});
