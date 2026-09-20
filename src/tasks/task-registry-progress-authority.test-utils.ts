import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type {
  ProgressContinuationCapability,
  ProgressContinuationReceipt,
} from "../channels/progress-continuation.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createInMemoryTaskRegistryStore } from "../test-utils/task-registry-store.js";
import {
  createSubagentTaskBackingDetail,
  resolveManagedTaskBackingDetail,
  prepareTaskBackingRead,
} from "./task-backing-authority.js";
import {
  createManagedTaskFlow,
  createTaskFlowForTask,
  runTaskFlowRegistryWorkerMutation,
} from "./task-flow-registry.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { createTaskProgressContinuation } from "./task-progress-requester.js";
import { captureTaskAgentEventTarget } from "./task-registry-agent-event-target.js";
import type {
  adoptTaskProgressMessage,
  publishTaskProgressMessage,
  TaskProgressPublication,
} from "./task-registry-progress-runtime.js";
import { linkTaskToFlowById } from "./task-registry-record-api.js";
import {
  runTaskRegistryWorkerMutation,
  syncFlowFromTaskAfterTaskMutationAsync,
  tasks,
} from "./task-registry-state.js";
import { createTaskRecord, getTaskById } from "./task-registry.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import type { TaskNotifyPolicy, TaskRecord } from "./task-registry.types.js";

export type TaskProgressTestChild = {
  entry: SubagentRunRecord;
  task: TaskRecord;
  claim: string;
};

type TaskProgressAuthorityFixture = {
  requesterSessionKey: string;
  requesterTurnRunId: string;
  receipt: () => ProgressContinuationReceipt;
  receipts: Map<string, ProgressContinuationReceipt>;
  accepted: (
    items: readonly TaskProgressTestChild[],
  ) => Parameters<typeof createTaskProgressContinuation>[0]["acceptedSessionSpawns"];
  continuation: (
    items: readonly TaskProgressTestChild[],
  ) => Promise<ProgressContinuationCapability | undefined>;
  tool: (entry: SubagentRunRecord, index?: number) => void;
  origin: TaskProgressPublication["origin"];
  child: (
    name: string,
    options?: { notifyPolicy?: TaskNotifyPolicy; turn?: string },
  ) => TaskProgressTestChild;
  adopt: (items: readonly TaskProgressTestChild[]) => Promise<ProgressContinuationCapability>;
  runtime: {
    publishTaskProgressMessage: Mock<typeof publishTaskProgressMessage>;
    adoptTaskProgressMessage: Mock<typeof adoptTaskProgressMessage>;
  };
  publications: Array<TaskProgressPublication & { messageId: string }>;
};

export function registerTaskProgressAuthorityTests({
  requesterSessionKey: PARENT,
  requesterTurnRunId: TURN,
  receipt,
  receipts,
  accepted,
  continuation,
  tool,
  origin,
  child,
  adopt,
  runtime,
  publications,
}: TaskProgressAuthorityFixture): void {
  function managedChild() {
    const item = child("Managed", { notifyPolicy: "silent" });
    const mirror = expectDefined(createTaskFlowForTask({ task: item.task }), "canonical flow");
    linkTaskToFlowById({ taskId: item.task.taskId, flowId: mirror.flowId });
    const flow = expectDefined(
      createManagedTaskFlow({
        ownerKey: PARENT,
        controllerId: "tests/progress-authority",
        goal: "Show admitted progress",
        requesterOrigin: origin,
      }),
      "managed flow",
    );
    const scope = {
      runtime: "subagent" as const,
      scopeKind: "session" as const,
      ownerKey: PARENT,
      childSessionKey: item.entry.childSessionKey,
      runId: item.entry.runId,
    };
    expect(
      createTaskRecord({
        ...scope,
        requesterAgentId: "main",
        task: "Show admitted progress",
        status: "running",
        deliveryStatus: "pending",
        notifyPolicy: "state_changes",
        parentFlowId: flow.flowId,
        requesterOrigin: origin,
        detail: resolveManagedTaskBackingDetail(scope),
      }),
    ).not.toBeNull();
    return { item, flow };
  }

  it.each(["same child", "unrelated child"] as const)(
    "checks accepted nonresident canonical candidates at publication (%s)",
    async (relation) => {
      const { item } = managedChild();
      await adopt([item]);
      const candidate: TaskRecord = {
        ...item.task,
        taskId: "accepted-new-canonical-task",
        runId: "new-canonical-run",
        ownerKey: "agent:main:another-owner",
        childSessionKey:
          relation === "same child" ? item.entry.childSessionKey : "agent:main:subagent:unrelated",
        detail: createSubagentTaskBackingDetail(2),
      };
      const mirror = expectDefined(
        createTaskFlowForTask({ task: candidate }),
        "new canonical flow",
      );
      candidate.parentFlowId = mirror.flowId;
      const store = getTaskRegistryStore();
      const context = captureOpenClawStateWorkerContext();
      const release = createDeferred();
      let pending: Promise<void> | undefined;
      const publish = runtime.publishTaskProgressMessage.getMockImplementation()!;
      runtime.publishTaskProgressMessage.mockImplementationOnce(async (params) => {
        pending = runTaskRegistryWorkerMutation(
          {
            admission: context.admission,
            scope: { taskId: candidate.taskId, runId: candidate.runId },
            readEventTarget: () => captureTaskAgentEventTarget(candidate),
            publicationRecords: () => new Map([[candidate.taskId, candidate]]),
          },
          async () => {
            await release.promise;
            store.upsertTaskWithDeliveryState({ task: candidate });
          },
          async () => store.loadSnapshot(),
        );
        expect(tasks.has(candidate.taskId)).toBe(false);
        return publish(params);
      });
      try {
        await vi.advanceTimersByTimeAsync(15_000);
        expect(runtime.publishTaskProgressMessage).toHaveBeenCalledOnce();
        expect(publications).toHaveLength(relation === "same child" ? 0 : 1);
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it.each(["progress only", "concurrent audience change", "unpublished audience change"] as const)(
    "preserves exact handoff authority during mirrored activity publication: %s",
    async (change) => {
      const flowStore = getTaskFlowRegistryStore();
      const store = createInMemoryTaskRegistryStore(undefined, flowStore);
      configureTaskRegistryRuntime({ store });
      const item = child("Worker");
      const flow = expectDefined(
        createTaskFlowForTask({ task: item.task, requesterOrigin: origin }),
        "mirrored task flow",
      );
      linkTaskToFlowById({ taskId: item.task.taskId, flowId: flow.flowId });
      const capability = expectDefined(await continuation([item]), "prepared handoff");
      const entered = createDeferred();
      const release = createDeferred();
      const releaseAudience = createDeferred();
      const sync = store.syncLiveTaskFlowAsync.bind(store);
      vi.spyOn(store, "syncLiveTaskFlowAsync").mockImplementation(async (...args) => {
        entered.resolve();
        await release.promise;
        return sync(...args);
      });
      let audienceChange: Promise<void> | undefined;
      if (change === "unpublished audience change") {
        const context = captureOpenClawStateWorkerContext();
        await runTaskFlowRegistryWorkerMutation(
          { flowId: flow.flowId, admission: context.admission },
          async () => {
            flowStore.upsertFlow({
              ...flow,
              requesterOrigin: { ...origin, to: "new-audience" },
            });
          },
          async () => {
            throw new Error("Committed audience change has not reached the projection");
          },
        );
      }
      const publication = syncFlowFromTaskAfterTaskMutationAsync(
        captureOpenClawStateWorkerContext(),
        store,
        expectDefined(getTaskById(item.task.taskId), "linked task"),
        "update",
        flowStore,
      );
      try {
        await Promise.race([
          entered.promise,
          publication.then(() => {
            throw new Error("Flow synchronization finished before its metadata gate");
          }),
        ]);
        if (change === "concurrent audience change") {
          const context = captureOpenClawStateWorkerContext();
          audienceChange = runTaskFlowRegistryWorkerMutation(
            { flowId: flow.flowId, admission: context.admission },
            async () => {
              await releaseAudience.promise;
              flowStore.upsertFlow({
                ...flow,
                requesterOrigin: { ...origin, to: "new-audience" },
              });
            },
            () => flowStore.readFlowAsync(context, flow.flowId),
          );
        }
        expect(await capability.adopt(receipt())).toBe(change === "progress only");
        expect(receipts.size).toBe(change === "progress only" ? 1 : 0);
      } finally {
        release.resolve();
        releaseAudience.resolve();
        await audienceChange;
        await publication;
        await prepareTaskBackingRead();
        capability.close();
      }
    },
  );

  it.each(["audience", "classification"] as const)(
    "rejects an adopted-card send while its flow %s change is unpublished",
    async (change) => {
      const { item, flow } = managedChild();
      await adopt([item]);
      const context = captureOpenClawStateWorkerContext();
      const store = getTaskFlowRegistryStore();
      const release = createDeferred();
      const publish = runtime.publishTaskProgressMessage.getMockImplementation()!;
      runtime.publishTaskProgressMessage.mockImplementationOnce(async (params) => {
        const pending = runTaskFlowRegistryWorkerMutation(
          { flowId: flow.flowId, admission: context.admission },
          async () => {
            await release.promise;
            store.upsertFlow({
              ...flow,
              ...(change === "audience"
                ? { requesterOrigin: { ...origin, to: "new-audience" } }
                : { syncMode: "task_mirrored" as const }),
            });
          },
          () => store.readFlowAsync(context, flow.flowId),
        );
        try {
          return await publish(params);
        } finally {
          release.resolve();
          await pending;
        }
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(runtime.publishTaskProgressMessage).toHaveBeenCalledOnce();
      expect(publications).toEqual([]);
    },
  );
  it("acknowledges committed custody without reviving a closed requester", async () => {
    const item = child("Worker");
    const committed = createDeferred();
    const acknowledged = createDeferred();
    runtime.adoptTaskProgressMessage.mockImplementationOnce(async (params) => {
      params.assertCurrent();
      receipts.set(params.operationId, structuredClone(params.receipt));
      committed.resolve();
      await acknowledged.promise;
      return true;
    });
    const capability = (await continuation([item]))!;
    const pending = capability.adopt(receipt());
    await committed.promise;
    capability.close();
    acknowledged.resolve();

    expect(await pending).toBe(true);
    expect([...receipts.values()].map((card) => card.messageId)).toEqual(["existing-parent-card"]);
    expect(item.entry.requesterSettleWake?.progressOperationId).toBeUndefined();
    tool(item.entry);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toEqual([]);
  });

  it("does not decline committed custody when requester attachment fails", async () => {
    const item = child("Worker");
    const capability = await createTaskProgressContinuation({
      requesterSessionKey: PARENT,
      requesterAgentId: "main",
      requesterTurnRunId: TURN,
      acceptedSessionSpawns: accepted([item]),
      onAdopted: () => {
        throw new Error("Requester settlement failed");
      },
    });
    expect(capability).toBeDefined();
    expect(await capability!.adopt(receipt())).toBe(true);
    capability!.close();
    expect([...receipts.values()].map((card) => card.messageId)).toEqual(["existing-parent-card"]);
  });
  it("rechecks authority at publication and preserves newer activity arriving during transport", async () => {
    const first = child("First");
    await adopt([first]);
    const publish = runtime.publishTaskProgressMessage.getMockImplementation()!;
    runtime.publishTaskProgressMessage.mockImplementationOnce(async (params) => {
      first.entry.killIntent = { requestedAt: Date.now(), reason: "cancelled at handoff" };
      return publish(params);
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toEqual([]);
    const second = child("Second", { turn: "second-turn" });
    await adopt([second]);
    runtime.publishTaskProgressMessage.mockImplementationOnce(async (params) => {
      tool(second.entry, 2);
      return publish(params);
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(publications).toHaveLength(2);
    expect(publications[1]!.content).toContain("public-notes-2.txt");
    expect(publications[1]!.content).toContain("Check release gates");
    expect(publications.every((display) => display.messageId === "existing-parent-card")).toBe(
      true,
    );
    expect(publications.map((display) => display.origin)).toEqual([origin, origin]);
  });
}
