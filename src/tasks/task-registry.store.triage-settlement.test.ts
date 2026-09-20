import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadTaskRegistryStateFromSqlite,
  settleTriageTaskFromSqlite,
  upsertTaskWithDeliveryStateToSqlite,
} from "./task-registry.store.sqlite.js";
import type { TaskRecord } from "./task-registry.types.js";

it.each(["same", "replaced-identity", "replaced-detail", "already-terminal", "owner-closed"])(
  "settles only the exact persisted triage task in one transaction (%s)",
  async (mode) => {
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
        const after = loadTaskRegistryStateFromSqlite();
        expect(after.tasks.get("unrelated-peer")).toEqual(before.tasks.get("unrelated-peer"));
        if (mode === "same") {
          expect(after.tasks.get(task.taskId)).toMatchObject({ status: "succeeded", endedAt: 200 });
        } else {
          expect(after).toEqual(before);
        }
      },
    );
  },
);
