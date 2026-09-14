// Connection-bound raw identity reads; the caller owns database admission and lifetime.
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { tableExists, tableHasColumns } from "../state/openclaw-state-db-schema-helpers.js";
import { readStateSchemaMigrationVersion } from "../state/openclaw-state-db-schema-version.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { TaskRecord } from "./task-registry.types.js";

/** Compares raw persisted identity without task-record normalization or mutation. */
export function matchesTaskIdentityInDatabase(
  db: DatabaseSync,
  task: TaskRecord,
): boolean | undefined {
  if (readStateSchemaMigrationVersion(db) !== OPENCLAW_STATE_SCHEMA_VERSION) {
    return undefined;
  }
  const columns = [
    "task_id",
    "runtime",
    "task_kind",
    "source_id",
    "run_id",
    "scope_kind",
    "owner_key",
    "requester_session_key",
    "child_session_key",
    "started_at",
  ] as const;
  if (!tableExists(db, "task_runs") || !tableHasColumns(db, "task_runs", columns)) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "task_runs">>(db)
      .selectFrom("task_runs")
      .select(columns)
      .where("task_id", "=", task.taskId),
  );
  if (!row || (row.started_at !== null && typeof row.started_at !== "number")) {
    return undefined;
  }
  const values = [
    row.task_id,
    row.runtime,
    row.scope_kind,
    row.owner_key,
    row.requester_session_key,
  ];
  const optional = [row.task_kind, row.source_id, row.run_id, row.child_session_key];
  if (
    values.some((value) => typeof value !== "string") ||
    optional.some((value) => value !== null && typeof value !== "string")
  ) {
    return undefined;
  }
  return (
    row.task_id === task.taskId &&
    row.runtime === task.runtime &&
    row.task_kind === (task.taskKind ?? null) &&
    row.source_id === (task.sourceId ?? null) &&
    row.run_id === (task.runId ?? null) &&
    row.scope_kind === task.scopeKind &&
    row.owner_key === task.ownerKey &&
    row.requester_session_key === task.requesterSessionKey &&
    row.child_session_key === (task.childSessionKey ?? null) &&
    row.started_at === (task.startedAt ?? null)
  );
}
