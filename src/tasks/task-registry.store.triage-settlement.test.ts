import { expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadTaskRegistryStateFromSqlite,
  matchesTaskIdentityFromSqlite,
  settleTriageTaskFromSqlite,
  upsertTaskWithDeliveryStateToSqlite,
} from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";

it.each([
  "same",
  "replaced-identity",
  "replaced-created-at",
  "replaced-detail",
  "already-terminal",
  "owner-closed",
])("settles only the exact persisted triage task in one transaction (%s)", async (mode) => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "triage-exact-settle-" },
    async () => {
      const task: TaskRecord = {
        taskId: "joined-task",
        runtime: "cli",
        taskKind: "triage_repair",
        sourceId: "generation",
        runId: "generation",
        scopeKind: "system",
        ownerKey: "",
        requesterSessionKey: "",
        task: "Repair",
        status: "running",
        createdAt: 100,
        startedAt: 100,
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
        detail: { original: "joined projection" },
      };
      upsertTaskWithDeliveryStateToSqlite({ task });
      const expected = loadTaskRegistryStateFromSqlite().tasks.get(task.taskId);
      if (!expected) {
        throw new Error("Fixture row missing");
      }
      const replacement = {
        ...expected,
        ...(mode === "replaced-identity" ? { startedAt: 101 } : {}),
        ...(mode === "replaced-detail" ? { detail: { replacement: true } } : {}),
        ...(mode === "already-terminal" ? { status: "failed" as const, endedAt: 150 } : {}),
      };
      upsertTaskWithDeliveryStateToSqlite({ task: replacement });
      // A second row with the same run ID must never be finalized as a side effect.
      upsertTaskWithDeliveryStateToSqlite({ task: { ...task, taskId: "unrelated-peer" } });
      const { db } = openOpenClawStateDatabase();
      if (mode === "replaced-created-at") {
        // Bypass the current writer to model a legacy/replacement persisted projection.
        db.prepare("UPDATE task_runs SET created_at = 101 WHERE task_id = ?").run(task.taskId);
        // Normalization conceals this identity change; raw identity must still reject it.
        expect(loadTaskRegistryStateFromSqlite().tasks.get(task.taskId)).toEqual(expected);
      }
      const rawBefore = db.prepare("SELECT * FROM task_runs ORDER BY task_id").all();
      const before = loadTaskRegistryStateFromSqlite();
      const settle = () =>
        settleTriageTaskFromSqlite({
          expected,
          status: "succeeded",
          endedAt: 200,
          terminalSummary: "Verified by original parent",
          assertCurrent: () => {
            if (mode === "owner-closed") {
              throw new Error("owner closed");
            }
          },
        });
      if (mode === "owner-closed") {
        expect(settle).toThrow("owner closed");
      } else {
        expect(settle()?.status).toBe(mode === "same" ? "succeeded" : undefined);
      }
      if (mode === "replaced-created-at") {
        expect(matchesTaskIdentityFromSqlite(expected)).toBe(false);
      }
      const after = loadTaskRegistryStateFromSqlite();
      expect(after.tasks.get("unrelated-peer")).toEqual(before.tasks.get("unrelated-peer"));
      if (mode === "same") {
        expect(after.tasks.get(task.taskId)).toMatchObject({ status: "succeeded", endedAt: 200 });
      } else {
        expect(after).toEqual(before);
        expect(db.prepare("SELECT * FROM task_runs ORDER BY task_id").all()).toEqual(rawBefore);
      }
    },
  );
});
