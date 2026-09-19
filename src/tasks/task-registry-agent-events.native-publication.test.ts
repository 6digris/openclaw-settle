import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  emitAgentEvent,
  resetAgentEventsForTest,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTaskFlowForTask } from "./task-flow-registry.js";
import { updateTask } from "./task-registry-mutation.js";
import { publishTaskRecordAfterAtomicStore } from "./task-registry-publication.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { linkTaskToFlowById, markTaskTerminalById } from "./task-registry-record-api.js";
import { tasks, taskActivityByTaskId } from "./task-registry-state.js";
import { getTaskById } from "./task-registry.js";
import { getTaskRegistryStore, onTaskRegistryChange } from "./task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "./task-registry.store.sqlite.js";
import { createTaskFixture } from "./task-registry.test-support.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "./task-runtime.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
});
async function joinEvents() {
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
}

describe("native task event publication handoff", () => {
  it.each([
    "during readback",
    "readback rollback",
    "terminal no-op",
    "terminal metadata",
    "terminal metadata rollback",
    "terminal metadata ABA",
    "running metadata",
    "running metadata rollback",
    "running metadata ABA",
    "terminal metadata chain",
    "running metadata chain",
    "terminal metadata chain rollback",
    "running metadata chain rollback",
    "terminal metadata observer",
    "running metadata observer",
    "running metadata flow observer",
  ] as const)("settles native publication %s", async (scenario) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const terminal = scenario.startsWith("terminal");
      const metadata = scenario.includes("metadata") || scenario === "terminal no-op";
      const chain = scenario.includes("chain");
      const chainRollback = chain && scenario.endsWith("rollback");
      const rollback = !chain && scenario.endsWith("rollback");
      const aba = scenario.endsWith("ABA");
      const observer = scenario.endsWith("observer");
      const flowObserver = scenario === "running metadata flow observer";
      const task = createTaskFixture("cli", {
        requesterSessionKey: "agent:main:main",
        runId: "late-native-publication",
        task: "Original notification",
        status: terminal ? "running" : "queued",
        startedAt: 1_000,
        notifyPolicy: terminal ? "done_only" : "state_changes",
        deliveryStatus: "pending",
      });
      if (flowObserver) {
        const flow = createTaskFlowForTask({ task });
        expect(flow).not.toBeNull();
        expect(linkTaskToFlowById({ taskId: task.taskId, flowId: flow!.flowId })).not.toBeNull();
      }
      const store = getTaskRegistryStore();
      const mutate = store.runAgentEventMutationAsync.bind(store);
      let returned = false;
      let finalized = false;
      let observerUpdated = false;
      const stopObserver = onTaskRegistryChange((event) => {
        if (
          observer &&
          !flowObserver &&
          !observerUpdated &&
          event?.kind === "upserted" &&
          event.task.taskId === task.taskId &&
          event.task.task === "Native notification"
        ) {
          observerUpdated = true;
          updateTask(task.taskId, { task: "Latest notification" });
        }
      });
      if (flowObserver) {
        configureTaskFlowRegistryRuntime({
          observers: {
            onEvent(event) {
              if (
                !observerUpdated &&
                event.kind === "upserted" &&
                tasks.get(task.taskId)?.task === "Native notification"
              ) {
                observerUpdated = true;
                updateTask(task.taskId, { task: "Latest notification" });
              }
            },
          },
        });
      }
      const write = vi
        .spyOn(store, "runAgentEventMutationAsync")
        .mockImplementation((context, input, assertCurrent, onGranted) =>
          mutate(context, input, assertCurrent, (owner) => {
            onGranted(owner);
            if (metadata) {
              const current = getTaskById(task.taskId)!;
              expect(current.status).toBe(terminal ? "succeeded" : "running");
              const update = () => {
                const updated = updateTask(
                  task.taskId,
                  scenario === "terminal no-op" ? current : { task: "Native notification" },
                );
                if (scenario === "terminal no-op") {
                  expect(updated).toEqual(current);
                } else {
                  expect(updated?.task).toBe("Native notification");
                }
              };
              if (rollback || aba || chain) {
                const failure = new Error("Native notification rollback");
                const transaction = () =>
                  runOpenClawStateWriteTransaction(() => {
                    update();
                    expect(peekSystemEvents(task.ownerKey)).toEqual([]);
                    if (rollback) {
                      throw failure;
                    }
                    if (chain) {
                      const advance = () =>
                        expect(
                          updateTask(task.taskId, { task: "Latest notification" }),
                        ).not.toBeNull();
                      if (chainRollback) {
                        expect(() =>
                          runOpenClawStateWriteTransaction(() => {
                            advance();
                            throw failure;
                          }),
                        ).toThrow(failure);
                      } else {
                        advance();
                      }
                    } else {
                      expect(updateTask(task.taskId, current)).not.toBeNull();
                    }
                  });
                if (rollback) {
                  expect(transaction).toThrow(failure);
                } else {
                  transaction();
                }
              } else {
                update();
              }
              finalized = true;
            }
          }).finally(() => {
            returned = true;
          }),
        );
      const load = store.loadMutationSnapshotAsync.bind(store);
      vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
        const snapshot = await load(...args);
        if (!metadata && returned && !finalized) {
          finalized = true;
          const finalize = () =>
            expect(
              markTaskTerminalById({ taskId: task.taskId, status: "succeeded", endedAt: 2_000 }),
            ).not.toBeNull();
          if (rollback) {
            const failure = new Error("Native readback successor rollback");
            expect(() =>
              runOpenClawStateWriteTransaction(() => {
                finalize();
                throw failure;
              }),
            ).toThrow(failure);
          } else {
            finalize();
          }
        }
        return snapshot;
      });
      emitAgentEvent({
        runId: task.runId!,
        stream: "lifecycle",
        data: terminal ? { phase: "end", endedAt: 2_000 } : { phase: "start", startedAt: 1_000 },
      });
      const read = await prepareTaskRegistryRead().finally(stopObserver);
      await joinEvents();
      expect(observerUpdated).toBe(observer);
      expect(finalized).toBe(true);
      expect(write).toHaveBeenCalledOnce();
      expect(read?.getTaskById(task.taskId)?.status).toBe(
        terminal || (!metadata && !rollback) ? "succeeded" : "running",
      );
      if (terminal) {
        expect(taskActivityByTaskId.has(task.taskId)).toBe(false);
      }
      if (metadata) {
        const delivered = peekSystemEvents(task.ownerKey);
        expect(delivered).toHaveLength(aba ? 0 : 1);
        if (!aba) {
          expect(delivered[0]).toContain(
            rollback || scenario === "terminal no-op"
              ? "Original notification"
              : (chain && !chainRollback) || observer
                ? "Latest notification"
                : "Native notification",
          );
        }
      }
    });
  });

  it.each([
    "commit",
    "rollback",
    "failed finalizer",
    "different run",
    "different backing",
    "ABA before join",
    "ABA after join",
    "observer ABA",
    "lifecycle rotation",
    "database retirement",
    "unknown receipt",
  ] as const)("retains the granted publication obligation across native %s", async (scenario) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const task = createTaskFixture("cli", {
        runId: "handoff-" + scenario,
        task: "Native successor",
        status: "queued",
        startedAt: 1_000,
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      const store = getTaskRegistryStore();
      const mutate = store.runAgentEventMutationAsync.bind(store);
      const failure = new Error("Synthetic native finalizer failure");
      const nativeFinished = createDeferred();
      let nativeError: unknown;
      const statuses: string[] = [];
      const stop = onTaskRegistryChange((event) => {
        if (event?.kind === "upserted" && event.task.taskId === task.taskId && event.previous) {
          // Activity-only flushes have no prior row and owe no durable publication.
          statuses.push(event.task.status);
        }
      });
      const replaceABA = () => {
        const current = tasks.get(task.taskId)!;
        for (const record of [{ ...current, task: "Intervening writer" }, current]) {
          store.upsertTaskWithDeliveryState({ task: record });
          publishTaskRecordAfterAtomicStore(record);
        }
      };
      let observedReplacement = false;
      const stopReplacement = onTaskRegistryChange((event) => {
        if (
          scenario === "observer ABA" &&
          !observedReplacement &&
          event?.kind === "upserted" &&
          event.task.taskId === task.taskId &&
          event.task.status === "succeeded"
        ) {
          observedReplacement = true;
          replaceABA();
        }
      });
      const writes = vi
        .spyOn(store, "runAgentEventMutationAsync")
        .mockImplementation((context, input, assertCurrent, onGranted) =>
          mutate(context, input, assertCurrent, (owner) => {
            onGranted(
              scenario === "unknown receipt"
                ? {
                    get committed() {
                      return undefined;
                    },
                    get settlement() {
                      return owner.settlement && { kind: owner.settlement.kind };
                    },
                    waitForSettlement(deadline) {
                      owner.waitForSettlement(deadline);
                      return { kind: "completed" };
                    },
                  }
                : owner,
            );
            try {
              if (scenario === "ABA before join") {
                store.settleAgentEventWrites((deadline) => owner.waitForSettlement(deadline));
                const committed = loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)!;
                for (const record of [{ ...committed, task: "Intervening writer" }, committed]) {
                  store.upsertTaskWithDeliveryState({ task: record });
                  publishTaskRecordAfterAtomicStore(record);
                }
              }
              expect(getTaskById(task.taskId)?.status).toBe("running");
              if (scenario === "ABA after join") {
                replaceABA();
              }
              if (scenario === "lifecycle rotation") {
                rotateAgentEventLifecycleGeneration();
              }
              if (scenario === "database retirement") {
                vi.spyOn(context.admission, "assertCurrent").mockImplementation(() => {
                  throw new Error("Synthetic original database admission retired");
                });
              }
              if (scenario === "different run") {
                updateTask(task.taskId, { runId: "new-native-run", status: "succeeded" });
              } else if (scenario === "different backing") {
                updateTask(task.taskId, {
                  status: "succeeded",
                  detail: {
                    kind: "task_backing_instance",
                    runtime: "acp",
                    instanceId: "replacement",
                    generation: 1,
                  },
                });
              } else if (scenario === "failed finalizer") {
                const write = vi
                  .spyOn(store, "upsertTaskWithDeliveryState")
                  .mockImplementationOnce(() => {
                    throw failure;
                  });
                try {
                  expect(
                    markTaskTerminalById({
                      taskId: task.taskId,
                      status: "succeeded",
                      endedAt: 2_000,
                    }),
                  ).toBeNull();
                } finally {
                  write.mockRestore();
                }
              } else if (scenario === "rollback") {
                expect(() =>
                  runOpenClawStateWriteTransaction(() => {
                    expect(
                      markTaskTerminalById({
                        taskId: task.taskId,
                        status: "succeeded",
                        endedAt: 2_000,
                      }),
                    ).not.toBeNull();
                    throw failure;
                  }),
                ).toThrow(failure);
              } else {
                expect(
                  markTaskTerminalById({
                    taskId: task.taskId,
                    status: "succeeded",
                    endedAt: 2_000,
                  }),
                ).not.toBeNull();
              }
            } catch (error) {
              nativeError = error;
            } finally {
              nativeFinished.resolve();
            }
          }),
        );
      emitAgentEvent({
        runId: task.runId!,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      const readOutcome = prepareTaskRegistryRead().then(
        (read) => ({ read, error: undefined }),
        (error: unknown) => ({ read: undefined, error }),
      );
      await vi.waitFor(() => expect(writes).toHaveBeenCalledOnce());
      await nativeFinished.promise;
      const outcome = await readOutcome.finally(() => {
        stop();
        stopReplacement();
      });
      await joinEvents();
      expect(nativeError).toBeUndefined();
      expect(writes).toHaveBeenCalledOnce();
      const keptWorkerPublication = scenario === "rollback" || scenario === "failed finalizer";
      if (scenario === "commit" || keptWorkerPublication) {
        expect(outcome.error).toBeUndefined();
        expect(outcome.read?.getTaskById(task.taskId)?.status).toBe(
          keptWorkerPublication ? "running" : "succeeded",
        );
        expect(statuses.filter((status) => status === "running")).toHaveLength(
          keptWorkerPublication ? 1 : 0,
        );
      } else {
        expect(outcome.error).toBeInstanceOf(Error);
      }
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(task.taskId)?.status).toBe(
        keptWorkerPublication ? "running" : "succeeded",
      );
    });
  });
});
