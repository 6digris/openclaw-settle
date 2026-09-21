import { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSubagentTaskBackingDetail } from "../../tasks/task-backing-records.js";
import { updateTask } from "../../tasks/task-registry-mutation.js";
import { publishTaskRecordAfterAtomicStore } from "../../tasks/task-registry-publication.js";
import { getTaskById, resetTaskRegistryForTests } from "../../tasks/task-registry-query.js";
import { markTaskTerminalById } from "../../tasks/task-registry-record-api.js";
import { emitTaskRegistryObserverEvent } from "../../tasks/task-registry-state.js";
import { configureTaskRegistryRuntime } from "../../tasks/task-registry.store.js";
import type { TaskRecord } from "../../tasks/task-registry.types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createInMemoryTaskRegistryStore } from "../../test-utils/task-registry-store.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import {
  clearSubagentRunsReadCacheForTest,
  persistSubagentRunsToDiskOrThrow,
} from "../subagents/registry/subagent-registry-state.js";
import { createSubagentsTool } from "./subagents-tool.js";

it("keeps persisted subagent wait selection off the calling thread", async () => {
  await withOpenClawTestState(
    { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
    async () => {
      const ownerKey = "agent:main:main";
      const childKey = "agent:main:subagent:persisted-wait";
      const run = createSubagentRunRecord({
        runId: "physical-run",
        taskRunId: "logical-run",
        generation: 1,
        childSessionKey: childKey,
        requesterSessionKey: ownerKey,
        requesterAgentId: "main",
        completion: { required: false },
        delivery: { status: "not_required" },
      });
      persistSubagentRunsToDiskOrThrow(new Map([[run.runId, run]]));
      clearSubagentRunsReadCacheForTest();
      const selected: TaskRecord = {
        taskId: "selected-native-task",
        runId: "logical-run",
        runtime: "subagent",
        ownerKey,
        requesterSessionKey: ownerKey,
        requesterAgentId: "main",
        childSessionKey: childKey,
        scopeKind: "session",
        task: "Synthetic persisted wait",
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 1,
        detail: createSubagentTaskBackingDetail(1),
      };
      configureTaskRegistryRuntime({
        store: createInMemoryTaskRegistryStore({
          tasks: new Map([[selected.taskId, selected]]),
          deliveryStates: new Map(),
        }),
      });
      let registryReads = 0;
      const statements = (["get", "all", "iterate"] as const).map((method) => {
        const execute = StatementSync.prototype[method];
        return vi.spyOn(StatementSync.prototype, method).mockImplementation(function (
          this: StatementSync,
          ...args: unknown[]
        ) {
          if (/\bfrom\s+"?subagent_runs\b/i.test(this.sourceSQL)) {
            registryReads++;
          }
          return Reflect.apply(execute, this, args);
        });
      });
      try {
        const result = await createSubagentsTool({ agentSessionKey: ownerKey, config: {} }).execute(
          "wait",
          { action: "wait", taskIds: [selected.taskId], timeoutSeconds: 0 },
        );
        expect(result.details).toMatchObject({
          reason: "timeout",
          tasks: [{ taskId: selected.taskId }],
        });
        expect(registryReads).toBe(0);
      } finally {
        for (const statement of statements) {
          statement.mockRestore();
        }
        resetTaskRegistryForTests();
        clearSubagentRunsReadCacheForTest();
      }
    },
  );
});

it.each(["completion", "reparent", "broad", "agent-collision"] as const)(
  "scopes descendant waits across unrelated publications and %s",
  async (transition) => {
    const ownerKey = "agent:main:main";
    const childKey = "agent:main:child";
    const record = (taskId: string, owner: string): TaskRecord => ({
      taskId,
      runtime: "cli",
      ownerKey: owner,
      requesterSessionKey: owner,
      scopeKind: "session",
      task: taskId,
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 1,
    });
    const unrelated = {
      ...record("unrelated", "agent:main:other"),
      detail: { unrelated: true, payload: "unrelated retained runtime detail" },
    };
    const selected = {
      ...record("selected", transition === "agent-collision" ? ownerKey : childKey),
      detail: { selected: true },
      ...(transition === "agent-collision" ? { requesterAgentId: "other" } : {}),
    };
    const sibling = { ...record("sibling", ownerKey), detail: { unrelated: true } };
    const parent = {
      ...record("parent", ownerKey),
      childSessionKey: transition === "agent-collision" ? ownerKey : childKey,
      ...(transition === "agent-collision" ? { agentId: "other" } : {}),
    };
    configureTaskRegistryRuntime({
      store: createInMemoryTaskRegistryStore({
        tasks: new Map([selected, unrelated, parent, sibling].map((task) => [task.taskId, task])),
        deliveryStates: new Map(),
      }),
    });
    getTaskById(selected.taskId);
    const firstRead = createDeferred();
    const originalClone = globalThis.structuredClone;
    const clone = vi.spyOn(globalThis, "structuredClone").mockImplementation((value, options) => {
      if (value && typeof value === "object" && "selected" in value) {
        firstRead.resolve();
      }
      return originalClone(value, options);
    });
    const tool = createSubagentsTool({ agentSessionKey: ownerKey, config: {} });
    const abort = new AbortController();
    const waiting = tool.execute(
      "wait",
      { action: "wait", taskIds: [selected.taskId] },
      abort.signal,
    );
    try {
      await firstRead.promise;
      expect(clone).not.toHaveBeenCalledWith(expect.objectContaining({ unrelated: true }));
      clone.mockClear();
      emitTaskRegistryObserverEvent(() => ({ kind: "upserted", task: unrelated }));
      emitTaskRegistryObserverEvent(() => ({ kind: "upserted", task: sibling }));
      await Promise.resolve();
      expect(clone).not.toHaveBeenCalled();
      if (transition === "reparent") {
        updateTask(parent.taskId, { childSessionKey: "agent:main:different-child" });
        expect((await waiting).details).toMatchObject({
          reason: "unavailable",
          unavailable: [selected.taskId],
          tasks: [],
        });
        // Atomic publications must rebind the same ancestry index as ordinary mutations.
        publishTaskRecordAfterAtomicStore(parent);
        expect(
          (
            await tool.execute("snapshot", {
              action: "wait",
              taskIds: [selected.taskId],
              timeoutSeconds: 0,
            })
          ).details,
        ).toMatchObject({ reason: "timeout", tasks: [{ taskId: selected.taskId }] });
        return;
      }
      if (transition === "broad") {
        emitTaskRegistryObserverEvent(() => ({ kind: "restored" }));
        await Promise.resolve();
        expect(clone).toHaveBeenCalledWith(expect.objectContaining({ selected: true }));
      }
      markTaskTerminalById({ taskId: selected.taskId, status: "succeeded", endedAt: Date.now() });
      expect((await waiting).details).toMatchObject({
        reason: "completed",
        completed: [selected.taskId],
        tasks: [{ taskId: selected.taskId, deliveryStatus: "not_applicable" }],
      });
      expect(clone).not.toHaveBeenCalledWith(expect.objectContaining({ unrelated: true }));
    } finally {
      abort.abort();
      await waiting.catch(() => {});
      clone.mockRestore();
      resetTaskRegistryForTests();
    }
  },
);
