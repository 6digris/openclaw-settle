import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import { claimAgentRunContext, resetAgentRunRegistryForTest } from "../infra/agent-run-registry.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getTaskExecutionObservation } from "./task-execution-observation.js";
import { createTaskRecord, listFreshTasksForOwnerKey } from "./task-registry.js";
import {
  hasTaskSessionOwnerInDatabase,
  listTaskRecordsForOwnerReadInDatabase,
  readTaskRecord,
} from "./task-registry.store.kernel.js";
import {
  loadTaskRegistryStateFromSqlite,
  upsertTaskWithDeliveryStateToSqlite,
} from "./task-registry.store.sqlite.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  resetAgentRunRegistryForTest();
});

it.each([
  { owner: "agent:main:main", requesterAgentId: null, child: "global", expectedAgent: "main" },
  { owner: "global", requesterAgentId: "main", child: "global", expectedAgent: "main" },
  {
    owner: "agent:main:main",
    requesterAgentId: null,
    child: "agent:worker:global",
    expectedAgent: "worker",
  },
  { owner: "global", requesterAgentId: null, child: "global", expectedAgent: undefined },
])(
  "restores child $child for owner $owner and requester $requesterAgentId without agent metadata",
  async ({ owner, requesterAgentId, child, expectedAgent }) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      resetTaskRegistryForTests({ persist: false });
      const runId = "retained-cli";
      const created = expectDefined(
        createTaskRecord({
          runtime: "cli",
          requesterSessionKey: "agent:main:main",
          childSessionKey: "agent:main:global",
          runId,
          status: "running",
          task: "Observe retained CLI execution",
        }),
        "created task",
      );
      const { db } = openOpenClawStateDatabase();
      db.prepare(
        "UPDATE task_runs SET owner_key = ?, requester_session_key = ?, child_session_key = ?, agent_id = NULL, requester_agent_id = ? WHERE task_id = ?",
      ).run(owner, owner, child, requesterAgentId, created.taskId);
      const restored = expectDefined(
        loadTaskRegistryStateFromSqlite().tasks.get(created.taskId),
        "restored task",
      );
      for (const record of [restored, expectDefined(readTaskRecord(db, created.taskId), "task")]) {
        const agentId = expectedAgent ?? "main";
        resetAgentRunRegistryForTest();
        claimAgentRunContext(
          runId,
          { sessionKey: `agent:${agentId}:global`, agentId },
          { trackOwner: true, ownsContext: true },
        );
        expect(getTaskExecutionObservation(record)).toEqual({
          state: expectedAgent ? "running" : "unknown",
        });
        expect(record.childSessionKey).toBe(
          expectedAgent ? `agent:${expectedAgent}:global` : child,
        );
        expect(record.agentId).toBeUndefined();

        resetAgentRunRegistryForTest();
        claimAgentRunContext(
          runId,
          { sessionKey: "agent:other:global", agentId: "other" },
          { trackOwner: true, ownsContext: true },
        );
        expect(getTaskExecutionObservation(record)).toEqual({ state: "unknown" });
      }
      const updated = { ...restored, lastEventAt: restored.createdAt + 1 };
      upsertTaskWithDeliveryStateToSqlite({ task: updated });
      expect(loadTaskRegistryStateFromSqlite().tasks.get(created.taskId)).toEqual(updated);
      expect(
        db
          .prepare(
            "SELECT owner_key, requester_session_key, child_session_key, agent_id, requester_agent_id FROM task_runs WHERE task_id = ?",
          )
          .get(created.taskId),
      ).toEqual({
        owner_key: owner,
        requester_session_key: owner,
        child_session_key: child,
        agent_id: null,
        requester_agent_id: requesterAgentId,
      });
    });
  },
);

it("keeps retained requester aliases distinct from child agents and other requesters", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-task-session-identity-" },
    async () => {
      resetTaskRegistryForTests({ persist: false });
      const records = ["research", "operations"].map((requesterAgentId) =>
        expectDefined(
          createTaskRecord({
            runtime: "subagent",
            requesterSessionKey: "global",
            requesterAgentId,
            agentId: "worker",
            childSessionKey: `agent:worker:subagent:${requesterAgentId}`,
            task: "Scoped requester",
          }),
          "expected task creation to succeed",
        ),
      );
      expect(records.map((record) => record.ownerKey)).toEqual([
        "agent:research:global",
        "agent:operations:global",
      ]);
      const { db } = openOpenClawStateDatabase();
      // Simulate released rows before aliases were qualified at admission.
      db.prepare(
        "UPDATE task_runs SET owner_key = 'global', requester_session_key = 'global'",
      ).run();
      const key = "agent:research:global";
      expect(loadTaskRegistryStateFromSqlite().tasks.get(records[0]!.taskId)).toMatchObject({
        ownerKey: key,
        requesterSessionKey: key,
        childSessionKey: "agent:worker:subagent:research",
      });
      expect(listTaskRecordsForOwnerReadInDatabase(db, key).map((record) => record.taskId)).toEqual(
        [records[0]!.taskId],
      );
      expect((await listFreshTasksForOwnerKey(key)).map((record) => record.taskId)).toEqual([
        records[0]!.taskId,
      ]);
      expect(hasTaskSessionOwnerInDatabase(db, key)).toBe(true);
      expect(hasTaskSessionOwnerInDatabase(db, "agent:worker:global")).toBe(false);
      db.prepare("UPDATE task_runs SET requester_agent_id = NULL").run();
      expect(hasTaskSessionOwnerInDatabase(db, key)).toBe(true);
      expect(hasTaskSessionOwnerInDatabase(db, "agent:worker:global")).toBe(true);
    },
  );
});

it.each(["owner metadata", "reference targets", "fallback owner"] as const)(
  "does not retain an alias that would undo changed %s",
  async (change) => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      resetTaskRegistryForTests({ persist: false });
      const task = expectDefined(
        createTaskRecord({
          runtime: "subagent",
          requesterSessionKey: "agent:research:global",
          ownerKey: "agent:research:global",
          requesterAgentId: "research",
          childSessionKey: "agent:worker:legacy-child",
          agentId: "worker",
          task: "Retained task",
        }),
        "created task",
      );
      const { db } = openOpenClawStateDatabase();
      db.prepare(
        "UPDATE task_runs SET requester_session_key = 'global', owner_key = ?, child_session_key = 'legacy-child', requester_agent_id = ? WHERE task_id = ?",
      ).run(
        change === "fallback owner" ? "agent:research:global" : "global",
        change === "fallback owner" ? null : "research",
        task.taskId,
      );
      const restored = expectDefined(
        loadTaskRegistryStateFromSqlite().tasks.get(task.taskId),
        "restored task",
      );
      const updated = {
        ...restored,
        ...(change === "owner metadata"
          ? { requesterAgentId: "operations", agentId: "helper" }
          : change === "reference targets"
            ? {
                requesterSessionKey: "agent:research:other",
                ownerKey: "agent:research:other",
                childSessionKey: "agent:worker:other-child",
              }
            : { ownerKey: "agent:operations:global" }),
      };
      upsertTaskWithDeliveryStateToSqlite({ task: updated });
      expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)).toEqual(updated);
      expect(
        db
          .prepare(
            "SELECT requester_session_key, owner_key, child_session_key FROM task_runs WHERE task_id = ?",
          )
          .get(task.taskId),
      ).toEqual({
        requester_session_key: updated.requesterSessionKey,
        owner_key: updated.ownerKey,
        child_session_key: change === "fallback owner" ? "legacy-child" : updated.childSessionKey,
      });
    });
  },
);
