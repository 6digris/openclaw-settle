import { assert, expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { RunEmbeddedAgentInternalParams } from "../../agents/embedded-agent-runner/run/internal-params.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { createSubagentRunParams } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { settleSubagentRegistryPersistenceWork } from "../../agents/subagents/registry/subagent-registry.persistence.test-support.js";
import { loadSubagentRunsByRunIdsFromSqlite } from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import {
  markRequesterTurnYielded,
  registerSubagentRun,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { resetTaskFlowRegistryForTests } from "../../tasks/task-flow-registry.test-support.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { createBlockReplySource, setBlockReplyDelivery } from "./block-reply-delivery.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import * as pendingToolTaskDrain from "./pending-tool-task-drain.js";
import type { FollowupRun } from "./queue.js";

type WaitingStatusFixture = {
  createMinimalRun: (params?: {
    opts?: InternalGetReplyOptions;
    currentInboundEventKind?: FollowupRun["currentInboundEventKind"];
  }) => {
    run: () => Promise<ReplyPayload | ReplyPayload[] | undefined>;
  };
  runEmbeddedAgentMock: Pick<Mock, "mockImplementationOnce" | "mockResolvedValueOnce">;
};

async function withPendingSessionSpawn(
  runEmbeddedAgentMock: WaitingStatusFixture["runEmbeddedAgentMock"],
  result: EmbeddedAgentRunResult,
  runTest: () => Promise<void>,
): Promise<void> {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const resetRegistries = () => {
      resetSubagentRegistryForTests({ persist: false });
      resetTaskRegistryForTests({ persist: false });
      resetTaskFlowRegistryForTests({ persist: false });
    };
    resetRegistries();
    const child = {
      runId: "child-run",
      childSessionKey: "agent:main:subagent:child",
      expectsCompletionMessage: true,
    };
    let requester: Parameters<typeof markRequesterTurnYielded>[0] | undefined;
    try {
      runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentInternalParams) => {
          assert(params.preparedRunAdmission);
          assert(params.sessionKey);
          assert(params.agentId);
          await params.preparedRunAdmission.admit("embedded");
          requester = {
            requesterSessionKey: params.sessionKey,
            requesterAgentId: params.agentId,
            requesterTurnRunId: params.runId,
          };
          registerSubagentRun(
            createSubagentRunParams({
              ...child,
              ...requester,
              agentId: params.agentId,
              completionTarget: "parent",
              queued: true,
            }),
          );
          if (result.meta.yielded) {
            expect(markRequesterTurnYielded(requester)).toBe(1);
          }
          return { ...result, acceptedSessionSpawns: [child] };
        },
      );
      await runTest();
      assert(requester);
      expect(loadSubagentRunsByRunIdsFromSqlite([child.runId])).toMatchObject([
        {
          ...child,
          requesterSessionKey: requester.requesterSessionKey,
          requesterAgentId: requester.requesterAgentId,
          execution: { status: "queued" },
          ...(result.meta.continuationPending
            ? {
                requesterTurnRunId: requester.requesterTurnRunId,
                requesterTurnYielded: true,
              }
            : {
                requesterSettleWake: {
                  status: "pending",
                  batchRunIds: [child.runId],
                  requesterYieldBatch: true,
                },
              }),
        },
      ]);
    } finally {
      await settleSubagentRegistryPersistenceWork();
      resetRegistries();
    }
  });
}

export function registerWaitingStatusCases({
  createMinimalRun,
  runEmbeddedAgentMock,
}: WaitingStatusFixture): void {
  it.each<{
    label: string;
    meta: Pick<
      EmbeddedAgentRunResult["meta"],
      "continuationPending" | "yielded" | "yieldAcknowledgment"
    >;
    implicit: boolean;
  }>([
    { label: "implicit continuation", meta: { continuationPending: true }, implicit: true },
    { label: "yield without acknowledgment", meta: { yielded: true }, implicit: false },
    {
      label: "explicit acknowledgment",
      meta: { yielded: true, yieldAcknowledgment: "Research started; results will follow." },
      implicit: false,
    },
  ])("delivers one waiting status for $label", async ({ meta, implicit }) => {
    await withPendingSessionSpawn(
      runEmbeddedAgentMock,
      { payloads: [], meta: { durationMs: 0, ...meta } },
      async () => {
        const onPendingContinuation = vi.fn();
        const { run } = createMinimalRun({ opts: { onPendingContinuation } });

        const result = await run();
        expect(result).toMatchObject({
          text:
            meta.yieldAcknowledgment ??
            "I’m continuing this work and will send the result when it is ready.",
          replyToId: "msg",
        });
        expect(onPendingContinuation).toHaveBeenCalledOnce();
        assert(result && !Array.isArray(result));
        const metadata = getReplyPayloadMetadata(result);
        expect(metadata?.deliverDespiteSourceReplySuppression).toBe(true);
        expect(metadata?.continuationStatus === true).toBe(implicit);
        expect(onPendingContinuation.mock.calls[0]).toEqual(
          implicit ? [{ settle: expect.any(Function) }] : [],
        );
      },
    );
  });

  it.each([false, true])(
    "uses direct delivery completeness at settlement for waiting status (complete=%s)",
    async (completeAtSettlement) => {
      const source = createBlockReplySource();
      source.setComplete(completeAtSettlement);
      const onBlockReply = vi.fn(async (payload: ReplyPayload) => {
        await source.run(async () => {
          setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }), payload);
        });
      });
      runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentInternalParams) => {
          await params.onBlockReply?.({
            text: "Delivered caption",
            mediaUrls: ["https://example.com/direct.png"],
          });
          source.setComplete(!completeAtSettlement);
          return { payloads: [], meta: { yielded: true, yieldAcknowledgment: "Waiting sentinel" } };
        },
      );
      const { run } = createMinimalRun({ opts: { onBlockReply } });

      const result = await run();

      expect(onBlockReply).toHaveBeenCalledOnce();
      expect(source.complete).toBe(!completeAtSettlement);
      if (completeAtSettlement) {
        expect(result).toBeUndefined();
      } else {
        expect(result).toMatchObject({ text: "Waiting sentinel", replyToId: "msg" });
      }
    },
  );

  it.each([
    { phase: "deferred cleanup", earlierSuccess: false },
    { phase: "deferred cleanup", earlierSuccess: true },
    { phase: "task drain", earlierSuccess: false },
    { phase: "task drain", earlierSuccess: true },
  ])(
    "preserves waiting status when direct delivery settles during $phase (earlier success=$earlierSuccess)",
    async ({ phase, earlierSuccess }) => {
      const transportStarted = createDeferred();
      const releaseTransport = createDeferred();
      const delivered: string[] = [];
      let lateDelivery: Promise<void> | undefined;
      let cleanupCompleted = false;
      let drainSnapshot: { cleanupCompleted: boolean; delivered: string[] } | undefined;
      const onBlockReply = vi.fn(async (payload: ReplyPayload) => {
        if (payload.text === "Late caption") {
          transportStarted.resolve();
          await releaseTransport.promise;
        }
        delivered.push(payload.text ?? "");
      });
      const onToolResult = vi.fn(async () => {
        await lateDelivery;
      });
      const originalDrain = pendingToolTaskDrain.drainPendingToolTasks;
      const drainSpy =
        phase === "task drain"
          ? vi
              .spyOn(pendingToolTaskDrain, "drainPendingToolTasks")
              .mockImplementation((options) => {
                drainSnapshot = { cleanupCompleted, delivered: [...delivered] };
                const draining = originalDrain(options);
                releaseTransport.resolve();
                return draining;
              })
          : undefined;
      runEmbeddedAgentMock.mockImplementationOnce(
        async (params: RunEmbeddedAgentInternalParams) => {
          if (earlierSuccess) {
            await params.onBlockReply?.({
              text: "Earlier caption",
              mediaUrls: ["https://example.com/earlier.png"],
            });
          }
          lateDelivery = Promise.resolve(
            params.onBlockReply?.({
              text: "Late caption",
              mediaUrls: ["https://example.com/late.png"],
            }),
          );
          await transportStarted.promise;
          if (phase === "task drain") {
            void params.onToolResult?.({ text: "Pending tool delivery" });
          }
          params.onDeferredLifecycleOwner?.({
            beginRetryWait: () => undefined,
            discard: () => undefined,
            complete: async () => {
              if (phase === "deferred cleanup") {
                releaseTransport.resolve();
                await lateDelivery;
              }
              cleanupCompleted = true;
            },
          });
          return { payloads: [], meta: { yielded: true, yieldAcknowledgment: "Waiting sentinel" } };
        },
      );
      const { run } = createMinimalRun({
        opts: { onBlockReply, onToolResult, forceToolResultProgress: true },
      });

      try {
        const result = await run();

        expect(cleanupCompleted).toBe(true);
        expect(delivered).toEqual(
          earlierSuccess ? ["Earlier caption", "Late caption"] : ["Late caption"],
        );
        if (drainSpy) {
          expect(drainSpy).toHaveBeenCalledOnce();
          expect(onToolResult).toHaveBeenCalledOnce();
          expect(drainSnapshot).toEqual({
            cleanupCompleted: true,
            delivered: earlierSuccess ? ["Earlier caption"] : [],
          });
        }
        if (earlierSuccess) {
          expect(result).toBeUndefined();
        } else {
          expect(result).toMatchObject({ text: "Waiting sentinel", replyToId: "msg" });
        }
      } finally {
        releaseTransport.resolve();
        await lateDelivery;
        drainSpy?.mockRestore();
      }
    },
  );

  it.each([
    { label: "default status" },
    { label: "explicit status", acknowledgment: "Research started; results will follow." },
    {
      label: "room event",
      acknowledgment: "Research started; results will follow.",
      roomEvent: true,
      warning: true,
    },
    { label: "empty acknowledgment", acknowledgment: "[[reply_to_current]]", warning: true },
  ])("resolves an earlier tool warning with $label", async (testCase) => {
    const toolWarning = setReplyPayloadMetadata(
      { text: "⚠️ Bash failed", isError: true },
      { toolErrorWarning: { toolName: "bash" } },
    );
    await withPendingSessionSpawn(
      runEmbeddedAgentMock,
      {
        payloads: [toolWarning],
        meta: { durationMs: 0, yielded: true, yieldAcknowledgment: testCase.acknowledgment },
      },
      async () => {
        const { run } = createMinimalRun({
          currentInboundEventKind: testCase.roomEvent ? "room_event" : undefined,
        });

        await expect(run()).resolves.toMatchObject({
          text: testCase.warning
            ? "⚠️ Bash failed"
            : (testCase.acknowledgment ??
              "I’m continuing this work and will send the result when it is ready."),
          ...(testCase.warning ? { isError: true } : {}),
          replyToId: "msg",
        });
      },
    );
  });
}
