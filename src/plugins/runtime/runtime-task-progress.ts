import { getLatestLiveSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry-read.js";
import { onSubagentRegistryPersisted } from "../../agents/subagents/registry/subagent-registry-state.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { onSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import {
  prepareTaskBackingRead,
  readTaskBackingInstance,
} from "../../tasks/task-backing-authority.js";
import { getTaskProgressSnapshot } from "../../tasks/task-registry-activity.js";
import { resolveTaskDeliveryOwner } from "../../tasks/task-registry-delivery.js";
import { sameTaskRunScope } from "../../tasks/task-registry-records.js";
import { onTaskRegistryChange } from "../../tasks/task-registry.store.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { mapTaskSummary } from "../../tasks/task-summary.js";
import { deliveryContextKey } from "../../utils/delivery-context.shared.js";
import type {
  BoundAsyncTaskRunsRuntime,
  PluginRuntimeTaskRuns,
  TaskProgressSource,
} from "./runtime-tasks.types.js";

class StaleTaskProgressObservation extends Error {
  constructor() {
    super("Task progress observation is no longer current");
  }
}

/** A read-only subscription on the existing registry publication owner, never a task owner. */
export async function observeRuntimeTaskProgress(
  params: Parameters<BoundAsyncTaskRunsRuntime["observeProgress"]>[0] & {
    binding: Parameters<PluginRuntimeTaskRuns["bindSession"]>[0];
    list: () => Promise<TaskRecord[]>;
  },
): Promise<() => Promise<void>> {
  params.signal.throwIfAborted();
  const lifecycle = getAgentRunLifecycleGeneration();
  const agentId =
    params.binding.agentId ?? parseAgentSessionKey(params.binding.sessionKey)?.agentId;
  const origin = deliveryContextKey(params.binding.requesterOrigin);
  let stopped = false;
  let dirty = false;
  let revision = 0;
  let pending: Promise<void> | undefined;

  const reportError = (error: unknown) => {
    try {
      params.onError?.(error);
    } catch {
      // Observers must not interrupt task publication or subscription retirement.
    }
  };
  const assertActive = () => {
    params.signal.throwIfAborted();
    if (stopped || lifecycle !== getAgentRunLifecycleGeneration()) {
      throw new StaleTaskProgressObservation();
    }
  };
  const publish = async () => {
    const observedRevision = revision;
    const records = await params.list();
    assertActive();
    const read = await prepareTaskBackingRead();
    assertActive();
    if (!read || revision !== observedRevision) {
      throw new StaleTaskProgressObservation();
    }
    const requesterSessionId = agentId
      ? loadSessionEntryReadOnly({ agentId, sessionKey: params.binding.sessionKey })?.sessionId
      : undefined;
    const resolveSource = (task: TaskRecord) => {
      const entry =
        task.runtime === "subagent" && task.childSessionKey
          ? getLatestLiveSubagentRunByChildSessionKey(task.childSessionKey)
          : undefined;
      const generation = readTaskBackingInstance(task.detail)?.generation;
      const sourceRoute = deliveryContextKey(entry?.progressOrigin);
      if (
        task.notifyPolicy === "silent" ||
        !entry?.progressOrigin ||
        !requesterSessionId ||
        entry.completionRequesterSessionId !== requesterSessionId ||
        (entry.taskRunId ?? entry.runId) !== task.runId ||
        generation === undefined ||
        entry.generation !== generation ||
        entry.requesterSessionKey !== task.ownerKey ||
        (entry.requesterAgentId !== undefined &&
          entry.requesterAgentId !== task.requesterAgentId) ||
        entry.killIntent ||
        entry.killReconciliation ||
        entry.execution.suppressSessionEffects ||
        entry.suppressAnnounceReason ||
        entry.collect ||
        !read.hasAuthoritativeTaskBacking(task) ||
        !sourceRoute ||
        sourceRoute !==
          deliveryContextKey(resolveTaskDeliveryOwner(task, read.getTaskFlowById).requesterOrigin)
      ) {
        return undefined;
      }
      return entry;
    };
    const selected = records.flatMap((record) => {
      const current = read.getTaskById(record.taskId);
      if (
        !current ||
        current.createdAt !== record.createdAt ||
        current.requesterAgentId !== record.requesterAgentId ||
        !sameTaskRunScope(current, record)
      ) {
        throw new StaleTaskProgressObservation();
      }
      if (
        origin &&
        deliveryContextKey(
          resolveTaskDeliveryOwner(current, read.getTaskFlowById).requesterOrigin,
        ) !== origin
      ) {
        return [];
      }
      const entry = resolveSource(current);
      const value = entry?.progressOrigin;
      const source: TaskProgressSource | undefined = value
        ? Object.freeze({
            channel: value.channel,
            accountId: value.accountId,
            to: value.to,
            threadId: value.threadId,
            channelId: value.channelId,
            messageId: value.messageId,
          })
        : undefined;
      return [
        {
          record: current,
          summary: mapTaskSummary(current),
          origin: entry && source ? { entry, source } : undefined,
        },
      ];
    });
    const assertCurrent = () => {
      assertActive();
      read.assertCurrent();
      if (revision !== observedRevision) {
        throw new StaleTaskProgressObservation();
      }
      for (const { record, summary, origin: capturedOrigin } of selected) {
        const current = read.getTaskById(record.taskId);
        if (
          !current ||
          !sameTaskRunScope(current, record) ||
          current.createdAt !== record.createdAt ||
          current.requesterAgentId !== record.requesterAgentId ||
          current.status !== record.status ||
          readTaskBackingInstance(current.detail)?.generation !==
            readTaskBackingInstance(record.detail)?.generation ||
          getTaskProgressSnapshot(record.taskId) !== summary.progress ||
          (origin &&
            deliveryContextKey(
              resolveTaskDeliveryOwner(current, read.getTaskFlowById).requesterOrigin,
            ) !== origin)
        ) {
          throw new StaleTaskProgressObservation();
        }
        if (capturedOrigin) {
          const source = capturedOrigin.entry.progressOrigin;
          if (
            !source ||
            resolveSource(current) !== capturedOrigin.entry ||
            source.channel !== capturedOrigin.source.channel ||
            source.accountId !== capturedOrigin.source.accountId ||
            source.to !== capturedOrigin.source.to ||
            source.threadId !== capturedOrigin.source.threadId ||
            source.channelId !== capturedOrigin.source.channelId ||
            source.messageId !== capturedOrigin.source.messageId
          ) {
            throw new StaleTaskProgressObservation();
          }
        }
      }
    };
    assertCurrent();
    await params.onChange(
      selected.map(({ summary }) => summary),
      assertCurrent,
      new Map(
        selected.flatMap(({ record, origin: taskOrigin }) =>
          taskOrigin ? [[record.taskId, taskOrigin.source] as const] : [],
        ),
      ),
    );
  };
  const schedule = () => {
    if (stopped) {
      return;
    }
    revision += 1;
    dirty = true;
    if (pending) {
      return;
    }
    pending = (async () => {
      while (dirty) {
        if (stopped) {
          break;
        }
        dirty = false;
        try {
          await publish();
        } catch (error) {
          if (
            !stopped &&
            !params.signal.aborted &&
            !(error instanceof StaleTaskProgressObservation)
          ) {
            reportError(error);
          }
        }
      }
    })().finally(() => {
      pending = undefined;
      if (dirty && !stopped) {
        schedule();
      }
    });
  };
  const unsubscribeTasks = onTaskRegistryChange((event) => {
    if (
      !event ||
      event.kind === "restored" ||
      (event.kind === "upserted" &&
        (event.task.ownerKey === params.binding.sessionKey ||
          event.previous?.ownerKey === params.binding.sessionKey)) ||
      (event.kind === "deleted" && event.previous.ownerKey === params.binding.sessionKey)
    ) {
      schedule();
    }
  });
  const unsubscribeRuns = onSubagentRegistryPersisted(schedule);
  const unsubscribeSession = onSessionIdentityMutation((mutation) => {
    if (agentId && mutation.agentId !== agentId) {
      return;
    }
    if (mutation.previous.sessionKeys.includes(params.binding.sessionKey)) {
      void stop();
      reportError(new Error("Task progress subscription session was replaced"));
    } else if (
      mutation.kind !== "delete" &&
      mutation.current.sessionKeys.includes(params.binding.sessionKey)
    ) {
      schedule();
    }
  });
  const stop = async () => {
    stopped = true;
    dirty = false;
    unsubscribeTasks();
    unsubscribeSession();
    unsubscribeRuns();
    params.signal.removeEventListener("abort", onAbort);
    await pending;
  };
  const onAbort = () => {
    void stop();
  };
  params.signal.addEventListener("abort", onAbort, { once: true });
  schedule();
  await pending;
  if (params.signal.aborted || stopped) {
    await stop();
    assertActive();
  }
  return stop;
}
