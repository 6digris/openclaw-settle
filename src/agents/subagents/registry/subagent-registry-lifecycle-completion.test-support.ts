import { describe, expect, it, vi, type Mock } from "vitest";
import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import { resolveSessionStorePathForScope } from "../../../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { setDetachedTaskDeliveryStatusByRunId } from "../../../tasks/detached-task-runtime.js";
import type {
  blockSubagentCompletionDelivery,
  settleRequesterCompletionBatch,
} from "../completion/subagent-completion-admission.store.js";
import type { SubagentLifecycleOptions } from "./subagent-registry-lifecycle-context.js";
import { clearSubagentPendingDelivery } from "./subagent-registry-lifecycle-delivery.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function mockBlockedCompletionDeliveryOwner(
  completionDeliveryMocks: {
    blockSubagentCompletionDelivery: Mock<typeof blockSubagentCompletionDelivery>;
    settleRequesterCompletionBatch: Mock<typeof settleRequesterCompletionBatch>;
    runsByEntry: WeakMap<SubagentRunRecord, Map<string, SubagentRunRecord>>;
  },
  taskExecutorMocks: {
    setDetachedTaskDeliveryStatusByRunId: Mock<typeof setDetachedTaskDeliveryStatusByRunId>;
  },
): void {
  completionDeliveryMocks.settleRequesterCompletionBatch.mockImplementation(
    ({
      entries,
      outcome,
    }: Parameters<
      typeof import("../completion/subagent-completion-admission.store.js").settleRequesterCompletionBatch
    >[0]) => {
      for (const { subagent, taskId } of entries) {
        if (subagent.pauseReason !== "sessions_yield") {
          // The store publishes a newly decoded receipt even when already delivered.
          if (outcome.delivered && subagent.delivery) {
            subagent.delivery = { ...subagent.delivery };
          }
          if (
            subagent.expectsCompletionMessage &&
            ["pending", "in_progress"].includes(subagent.delivery?.status ?? "pending")
          ) {
            if (outcome.delivered) {
              const deliveredAt = outcome.deliveredAt ?? Date.now();
              subagent.delivery = {
                ...subagent.delivery,
                status: "delivered",
                disposition: "delivered",
                deliveredAt,
                announcedAt: deliveredAt,
              };
              clearSubagentPendingDelivery(subagent);
              taskExecutorMocks.setDetachedTaskDeliveryStatusByRunId({
                runId: subagent.taskRunId ?? subagent.runId,
                deliveryStatus: "delivered",
              });
            } else {
              completionDeliveryMocks.blockSubagentCompletionDelivery({
                subagent,
                taskId: taskId ?? "",
                reason: outcome.error ?? outcome.reason ?? "requester settle wake failed",
                disposition: outcome.disposition,
              });
            }
          }
          if (subagent.requesterTurnRunId && subagent.expectsCompletionMessage) {
            subagent.retireAfterRequesterTurn =
              subagent.retireAfterRequesterTurn ||
              subagent.requesterSettleWake?.retireAfterSettle ||
              undefined;
          } else if (subagent.requesterSettleWake?.retireAfterSettle) {
            completionDeliveryMocks.runsByEntry.get(subagent)?.delete(subagent.runId);
          }
        }
        subagent.requesterSettleWake = undefined;
      }
    },
  );
  completionDeliveryMocks.blockSubagentCompletionDelivery.mockImplementation(
    ({
      subagent,
      reason,
      suspendedReason,
      disposition,
    }: {
      subagent: SubagentRunRecord;
      reason: string;
      suspendedReason?: "expiry" | "permanent_failure";
      disposition?: NonNullable<SubagentRunRecord["delivery"]>["disposition"];
    }) => {
      subagent.delivery ??= { status: "pending" };
      subagent.delivery.lastError = reason;
      subagent.delivery.deliveredAt = undefined;
      subagent.delivery.announcedAt = undefined;
      if (suspendedReason) {
        subagent.delivery.status = "suspended";
        subagent.delivery.suspendedReason = suspendedReason;
        subagent.delivery.suspendedAt = Date.now();
        subagent.cleanupHandled = false;
        subagent.requesterSettleWake ??= { status: "pending", attemptCount: 0 };
      } else {
        subagent.delivery.status = "failed";
        subagent.delivery.disposition = disposition ?? subagent.delivery.disposition;
        subagent.suppressCompletionDelivery = true;
      }
      return true;
    },
  );
}

export function registerSubagentParentStoreLifecycleCases({
  createRunEntry: createEntry,
  createLifecycleController,
}: {
  createRunEntry: (
    overrides: Partial<SubagentRunRecord> & { endedAt?: number },
  ) => SubagentRunRecord;
  createLifecycleController: (
    params: { entry: SubagentRunRecord } & Partial<SubagentLifecycleOptions>,
  ) => SubagentLifecycleController;
}): void {
  describe("subagent notification parent-store ownership", () => {
    it.each(["announcement", "settled batch"] as const)(
      "suspends %s before a replaced or unknown requester store can adopt it",
      (kind) => {
        for (const unknown of [false, true]) {
          let cfg: OpenClawConfig = {};
          const entry = createEntry({
            endedAt: 4_000,
            expectsCompletionMessage: true,
            requesterSettleWake: { status: "pending", attemptCount: 0 },
          });
          const announce = vi.fn(async () => "delivered" as const);
          const wake = vi.fn(async () => true);
          const persist = vi.fn();
          const controller = createLifecycleController({
            entry,
            getRuntimeConfig: () => cfg,
            runSubagentAnnounceFlow: announce,
            maybeWakeRequesterAfterAllChildrenSettled: wake,
            persistOrThrow: persist,
          });
          if (unknown) {
            entry.requesterStorePath = undefined;
          } else {
            cfg = { session: { store: `${entry.requesterStorePath}.replacement.sqlite` } };
          }
          if (kind === "announcement") {
            expect(controller.startSubagentAnnounceCleanupFlow(entry.runId, entry)).toBe(false);
          } else {
            controller.resumeRequesterSettleWake(entry.runId, entry);
          }
          expect(announce).not.toHaveBeenCalled();
          expect(wake).not.toHaveBeenCalled();
          expect(controller.options.runs.get(entry.runId)).toBe(entry);
          expect(entry.delivery).toMatchObject({
            status: "suspended",
            suspendedReason: "permanent_failure",
            lastError: expect.stringContaining(unknown ? "unknown" : "was replaced"),
          });
          expect(entry.requesterSettleWake).toBeDefined();
          expect(entry.delivery?.deliveredAt).toBeUndefined();
          expect(persist).toHaveBeenCalledWith(entry.runId);
        }
      },
    );
  });
}

export type RunEntryOverrides = Omit<Partial<SubagentRunRecord>, "execution"> & {
  execution?: SubagentRunRecord["execution"];
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunRecord["execution"]["outcome"];
};
export function createRunEntry(overrides: RunEntryOverrides = {}): SubagentRunRecord {
  const { startedAt = 2_000, endedAt, outcome, execution, ...recordOverrides } = overrides;
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    requesterStorePath: resolveSqliteTargetFromSessionStorePath(
      resolveSessionStorePathForScope(
        {
          sessionKey: overrides.requesterSessionKey ?? "agent:main:main",
          agentId: overrides.requesterAgentId,
        },
        {},
      ),
      { agentId: overrides.requesterAgentId },
    ).path,
    task: "finish the task",
    cleanup: "keep",
    createdAt: 1_000,
    ...recordOverrides,
    execution: execution
      ? { startedAt, ...execution }
      : {
          status: endedAt !== undefined || outcome !== undefined ? "terminal" : "running",
          startedAt,
          ...(endedAt === undefined ? {} : { endedAt }),
          ...(outcome === undefined ? {} : { outcome }),
        },
  };
}
