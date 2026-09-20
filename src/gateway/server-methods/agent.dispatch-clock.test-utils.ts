// Imported by agent.test.ts to retain its shared mocked module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { findTaskByRunId } from "../../tasks/task-registry.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import * as agentHandlerHelpers from "../agent-turn/agent-handler-helpers.js";
import { spyDetachedCreateRunningTaskRun } from "./agent-task-tracking.test-helpers.js";
import {
  backendGatewayClient,
  describe0AfterEach0,
  getAgentTestMocks,
  invokeAgent,
  requireValue,
  resetAgentTaskRegistryForTests,
  useTestStateDir,
  waitForAgentCommandCall,
} from "./agent.test-harness.js";

const mocks = getAgentTestMocks();

describe("gateway accepted dispatch clock", () => {
  afterEach(describe0AfterEach0);
  it("keeps accepted native dispatch alive when preparation settles on the last fixture pump", async () => {
    await withTestDir({ prefix: "openclaw-gateway-native-dispatch-boundary-" }, async (root) => {
      useTestStateDir(root);
      resetAgentTaskRegistryForTests();
      const childSessionKey = "agent:main:subagent:native-delayed-child";
      const runId = "native-delayed-subagent-run";
      const baseClient = requireValue(backendGatewayClient(), "expected backend client");
      mocks.userTurnStorePath = "/tmp/sessions.json";
      mocks.loadSessionEntry.mockReturnValue({
        cfg: {},
        storePath: mocks.userTurnStorePath,
        entry: { sessionId: "spawned-child-session", updatedAt: Date.now() },
        canonicalKey: childSessionKey,
      });
      mocks.updateSessionStore.mockResolvedValue(undefined);
      mocks.agentCommand.mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: { durationMs: 100 },
      });
      const createRunningTaskRunSpy = spyDetachedCreateRunningTaskRun();
      const prepared = createDeferred();
      const originalYield = agentHandlerHelpers.yieldAfterAgentAcceptedAck;
      const advancePending = vi.runOnlyPendingTimersAsync.bind(vi);
      let pumps = 0;
      const pump = vi.spyOn(vi, "runOnlyPendingTimersAsync").mockImplementation(async () => {
        const advanced = await advancePending();
        // Release asynchronous preparation at the former final pump. Its acknowledgement
        // timer is now queued, but that pump's timer snapshot has already been drained.
        if (++pumps === 50) {
          prepared.resolve();
        }
        return advanced;
      });
      const yieldAck = vi
        .spyOn(agentHandlerHelpers, "yieldAfterAgentAcceptedAck")
        .mockImplementation(async () => {
          await prepared.promise;
          return originalYield();
        });
      const respond = vi.fn();
      try {
        await invokeAgent(
          {
            message: "delayed native subagent child run",
            sessionKey: childSessionKey,
            idempotencyKey: runId,
          },
          {
            reqId: runId,
            client: {
              connect: baseClient.connect,
              internal: { ...baseClient.internal, agentRunTracking: "native_subagent" },
            },
            respond,
          },
        );
        await waitForAgentCommandCall();
        expect(createRunningTaskRunSpy).not.toHaveBeenCalled();
        expect(findTaskByRunId(runId)).toBeUndefined();
      } finally {
        prepared.resolve();
        pump.mockRestore();
        yieldAck.mockRestore();
      }
    });
  });
});
