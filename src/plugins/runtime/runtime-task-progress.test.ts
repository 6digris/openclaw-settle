import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { emitAgentEvent, resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { emitSessionIdentityMutation } from "../../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSubagentTaskBackingDetail } from "../../tasks/task-backing-records.js";
import { listTasksForRelatedSessionKeyForOwner } from "../../tasks/task-owner-access.js";
import { flushTaskActivity, recordTaskActivityEvent } from "../../tasks/task-registry-activity.js";
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
import { createTaskFixture } from "../../tasks/task-registry.test-support.js";
import {
  configureTaskFlowRegistryRuntime,
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import {
  createInMemoryTaskFlowRegistryStore,
  createInMemoryTaskRegistryStore,
} from "../../test-utils/task-registry-store.js";
import { observeRuntimeTaskProgress } from "./runtime-task-progress.js";
import type { BoundAsyncTaskRunsRuntime } from "./runtime-tasks.types.js";

const ownerKey = "agent:main:task-progress-observation";
const runIds: string[] = [];
const binding = { sessionKey: ownerKey, agentId: "main" };
const list = async () =>
  listTasksForRelatedSessionKeyForOwner({
    relatedSessionKey: ownerKey,
    callerOwnerKey: ownerKey,
    callerAgentId: "main",
  });
type Update = Parameters<Parameters<BoundAsyncTaskRunsRuntime["observeProgress"]>[0]["onChange"]>;

beforeEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  configureTaskRegistryRuntime({ store: createInMemoryTaskRegistryStore() });
  configureTaskFlowRegistryRuntime({ store: createInMemoryTaskFlowRegistryStore() });
  vi.spyOn(sessionAccessor, "loadSessionEntryReadOnly").mockReturnValue({
    sessionId: "current-requester-session",
    updatedAt: 1,
  });
});

afterEach(() => {
  for (const runId of runIds.splice(0)) {
    subagentRuns.delete(runId);
  }
  resetTaskRegistryForTests({ persist: false });
  resetTaskFlowRegistryForTests({ persist: false });
  resetAgentEventsForTest({ preserveListeners: true });
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

function createTask(runId = "observed-child") {
  const origin = { channel: "clickclack", accountId: "default", to: "channel:room" };
  const task = createTaskFixture("subagent", {
    ownerKey,
    requesterSessionKey: ownerKey,
    requesterAgentId: "main",
    childSessionKey: `agent:main:subagent:${runId}`,
    runId,
    task: "Private task prompt",
    requesterOrigin: origin,
    notifyPolicy: "state_changes",
    detail: createSubagentTaskBackingDetail(1),
  });
  const entry = createSubagentRunRecord({
    runId,
    taskRunId: runId,
    generation: 1,
    childSessionKey: task.childSessionKey!,
    requesterSessionKey: ownerKey,
    requesterAgentId: "main",
    completionRequesterSessionId: "current-requester-session",
    requesterOrigin: origin,
    progressOrigin: { ...origin, messageId: "msg_original" },
  });
  subagentRuns.set(runId, entry);
  runIds.push(runId);
  emitAgentEvent({
    runId,
    stream: "item",
    data: { itemId: "work", kind: "tool", phase: "start", title: "Inspecting" },
  });
  return { task, entry };
}

describe("runtime task progress observation", () => {
  it("publishes scoped public facts and fences a retained source when its live backing is replaced", async () => {
    const { task, entry } = createTask();
    createTaskFixture("subagent", {
      ownerKey: "agent:other:private",
      runId: "foreign-child",
      task: "Foreign task prompt",
    });
    let observed: Update | undefined;
    const abort = new AbortController();
    const stop = await observeRuntimeTaskProgress({
      binding,
      list,
      signal: abort.signal,
      onChange: (...args) => {
        observed = args;
      },
    });
    try {
      expect(observed?.[0].map((summary) => summary.id)).toEqual([task.taskId]);
      expect(observed?.[0][0]).not.toHaveProperty("prompt");
      expect(observed?.[0][0]?.progress?.items[0]?.title).toBe("Inspecting");
      expect(observed?.[2].get(task.taskId)?.messageId).toBe("msg_original");
      const assertCurrent = observed![1];
      entry.generation = 2;
      expect(assertCurrent).toThrow();
    } finally {
      await stop();
    }
  });

  it("omits a source locator from an old requester session while keeping authorized task history readable", async () => {
    const { task, entry } = createTask();
    entry.completionRequesterSessionId = "retired-requester-session";
    let observed: Update | undefined;
    const stop = await observeRuntimeTaskProgress({
      binding,
      list,
      signal: new AbortController().signal,
      onChange: (...args) => {
        observed = args;
      },
    });
    try {
      expect(observed?.[0].map((summary) => summary.id)).toEqual([task.taskId]);
      expect(observed?.[2].has(task.taskId)).toBe(false);
    } finally {
      await stop();
    }
  });

  it("coalesces a replacement behind pending publication and prevents predecessor data from being sent", async () => {
    const { task } = createTask();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const delivered: string[] = [];
    let first = true;
    const observing = observeRuntimeTaskProgress({
      binding,
      list,
      signal: new AbortController().signal,
      async onChange(tasks, assertCurrent) {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
        assertCurrent();
        delivered.push(tasks[0]?.progress?.runId ?? "unavailable");
      },
    });
    await entered.promise;
    recordTaskActivityEvent(task, {
      runId: "successor-execution",
      seq: 1,
      ts: 100,
      stream: "execution",
      data: { state: "running" },
    });
    recordTaskActivityEvent(task, {
      runId: "successor-execution",
      seq: 2,
      ts: 101,
      stream: "item",
      data: { itemId: "successor-work", phase: "start", kind: "tool", title: "Successor work" },
    });
    flushTaskActivity(task.taskId);
    release.resolve();
    const stop = await observing;
    try {
      expect(delivered).toEqual(["successor-execution"]);
    } finally {
      await stop();
    }
  });

  it.each(["abort", "session-reset"] as const)(
    "joins pending publication and retires its authority on %s",
    async (reason) => {
      createTask();
      const abort = new AbortController();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const delivered: string[] = [];
      const observing = observeRuntimeTaskProgress({
        binding,
        list,
        signal: abort.signal,
        async onChange(tasks, assertCurrent) {
          entered.resolve();
          await release.promise;
          assertCurrent();
          delivered.push(tasks[0]!.id);
        },
      });
      const rejected = expect(observing).rejects.toBeInstanceOf(Error);
      await entered.promise;
      if (reason === "abort") {
        abort.abort(new Error("Subscription stopped"));
      } else {
        emitSessionIdentityMutation({
          agentId: "main",
          kind: "reset",
          previous: { sessionId: "current-requester-session", sessionKeys: [ownerKey] },
          current: { sessionId: "replacement-session", sessionKeys: [ownerKey] },
        });
      }
      release.resolve();
      await rejected;
      expect(delivered).toEqual([]);
    },
  );
});
