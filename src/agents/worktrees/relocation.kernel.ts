import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { isPathInside } from "../../infra/path-guards.js";
import { isLockOwnerDefinitelyStale } from "../../infra/stale-lock-file.js";
import { getFileLockProcessStartTime } from "../../shared/pid-alive.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { createOpenClawStateSchemaEnsurer } from "../../state/openclaw-state-feature-schema.js";
import {
  rowToRecord,
  WORKTREE_RECORD_COLUMNS,
  listRegistryWorktreesInDatabase,
} from "./registry-read.kernel.js";
import type { WorktreeMoveReceipt, WorktreeRelocationOperations } from "./relocation.types.js";

const table = "worktree_relocations";
const query = (db: DatabaseSync) =>
  getNodeSqliteKysely<
    Pick<DB, "worktree_relocations" | "worktrees" | "state_leases" | "local_workspace_projections">
  >(db);

export const ensureWorktreeRelocationSchema = createOpenClawStateSchemaEnsurer({
  table,
  operationLabel: "worktrees.relocation.schema.ensure",
});

export function assertWorktreeNotProjectOwner(db: DatabaseSync, pathname: string) {
  if (!tableExists(db, "projects")) {
    return;
  }
  const roots = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "projects">>(db).selectFrom("projects").select("repo_root"),
  ).rows;
  if (roots.some((row) => isPathInside(pathname, row.repo_root))) {
    throw new Error(
      "Checkout owns a registered project; whole-graph repository relocation is required",
    );
  }
}

function receipt(row: Selectable<DB["worktree_relocations"]>): WorktreeMoveReceipt {
  return {
    operationId: row.operation_id,
    worktreeId: row.worktree_id,
    // SAFETY: worktree_relocations.phase has a CHECK for exactly WorktreeMovePhase values.
    phase: row.phase as WorktreeMoveReceipt["phase"],
    revision: row.revision,
    // SAFETY: admitWorktreeRelocation serializes the typed plan; later transitions never replace it.
    plan: JSON.parse(row.plan_json) as WorktreeMoveReceipt["plan"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

export function readWorktreeRelocations(db: DatabaseSync): WorktreeMoveReceipt[] {
  if (!tableExists(db, table)) {
    return [];
  }
  return executeSqliteQuerySync(
    db,
    query(db).selectFrom(table).selectAll().orderBy("created_at", "asc"),
  ).rows.map(receipt);
}

export function readWorktreeProjection(
  db: DatabaseSync,
  id: string,
): WorktreeRelocationOperations["worktrees.projection"]["output"] {
  if (!tableExists(db, "local_workspace_projections")) {
    return undefined;
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    query(db)
      .selectFrom("local_workspace_projections")
      .select([
        "projection_path",
        "session_id",
        "revision",
        "journal_json",
        "pending_ref",
        "paused_runtimes_json",
      ])
      .where("worktree_id", "=", id),
  );
  return row
    ? {
        path: row.projection_path,
        sessionId: row.session_id,
        revision: row.revision,
        unsettled: Boolean(row.journal_json || row.pending_ref || row.paused_runtimes_json),
      }
    : undefined;
}

export function readWorktreeBackupInventory(db: DatabaseSync) {
  assertNoWorktreeRelocation(db);
  const records = tableExists(db, "worktrees") ? listRegistryWorktreesInDatabase(db) : [];
  const projections = tableExists(db, "local_workspace_projections")
    ? executeSqliteQuerySync(
        db,
        query(db)
          .selectFrom("local_workspace_projections")
          .select(["worktree_id", "projection_path"])
          .orderBy("worktree_id", "asc"),
      ).rows
    : [];
  const roots = [
    ...new Set([
      ...records.flatMap((record) =>
        record.removedAt === undefined
          ? [record.repoRoot, record.path]
          : record.snapshotRef
            ? [record.repoRoot]
            : [],
      ),
      ...projections.map((row) => row.projection_path),
    ]),
  ].toSorted();
  // Completed receipts detect move-away-and-back while an archive is traversing.
  const revision = createHash("sha256")
    .update(
      JSON.stringify({
        roots,
        operations: readWorktreeRelocations(db).map(
          ({ operationId, revision: operationRevision }) => ({
            operationId,
            revision: operationRevision,
          }),
        ),
      }),
    )
    .digest("hex");
  return { roots, revision };
}

export function readWorktreeInventory(
  db: DatabaseSync,
): WorktreeRelocationOperations["worktrees.inventory"]["output"] {
  return {
    worktrees: tableExists(db, "worktrees") ? listRegistryWorktreesInDatabase(db) : [],
    relocations: readWorktreeRelocations(db),
    projections: tableExists(db, "local_workspace_projections")
      ? executeSqliteQuerySync(
          db,
          query(db)
            .selectFrom("local_workspace_projections")
            .select([
              "worktree_id",
              "projection_path",
              "session_id",
              "journal_json",
              "pending_ref",
              "paused_runtimes_json",
            ])
            .orderBy("worktree_id", "asc"),
        ).rows.map((row) => ({
          worktreeId: row.worktree_id,
          path: row.projection_path,
          sessionId: row.session_id,
          unsettled: Boolean(row.journal_json || row.pending_ref || row.paused_runtimes_json),
        }))
      : [],
  };
}

/** The fence survives process death and stale run-lease cleanup. */
export function assertNoWorktreeRelocation(db: DatabaseSync, worktreeId?: string): void {
  if (!tableExists(db, table)) {
    return;
  }
  let pending = query(db).selectFrom(table).select("operation_id").where("phase", "!=", "verified");
  if (worktreeId !== undefined) {
    pending = pending.where("worktree_id", "=", worktreeId);
  }
  const row = executeSqliteQueryTakeFirstSync(db, pending.limit(1));
  if (row) {
    throw new Error(
      `Worktree relocation ${row.operation_id} is unresolved; inspect worktrees verify before continuing.`,
    );
  }
}

/** A prepared cwd cannot become an unmanaged old path between selection and lease admission. */
export function assertWorktreeRunPathsCurrent(
  db: DatabaseSync,
  id: string,
  currentPath: string,
  candidates: readonly string[],
): void {
  const projection = readWorktreeProjection(db, id);
  const currentPaths = [currentPath, ...(projection ? [projection.path] : [])];
  const retiredPaths = readWorktreeRelocations(db)
    .filter((row) => row.worktreeId === id)
    .flatMap((row) =>
      row.plan.projection
        ? [row.plan.source.path, row.plan.projection.source.path]
        : [row.plan.source.path],
    );
  for (const candidate of candidates) {
    if (
      !currentPaths.some((root) => isPathInside(root, candidate)) &&
      retiredPaths.some((root) => isPathInside(root, candidate))
    ) {
      throw new Error(
        "Workspace moved after this run selected its path; resolve the current session workspace before retrying",
      );
    }
  }
}

export function admitWorktreeRelocation(
  db: DatabaseSync,
  input: WorktreeRelocationOperations["worktrees.relocation.admit"]["input"],
): WorktreeRelocationOperations["worktrees.relocation.admit"]["output"] {
  const k = query(db);
  const prior = executeSqliteQueryTakeFirstSync(
    db,
    k.selectFrom(table).selectAll().where("operation_id", "=", input.operationId),
  );
  if (prior) {
    if (
      prior.worktree_id !== input.plan.record.id ||
      prior.plan_json !== JSON.stringify(input.plan)
    ) {
      throw new Error("Relocation operation already exists with different intent");
    }
    // Even the same process must not replay a filesystem effect after losing its reply.
    return { receipt: receipt(prior), admitted: false };
  }
  assertNoWorktreeRelocation(db, input.plan.record.id);
  assertWorktreeNotProjectOwner(db, input.plan.record.path);
  const current = executeSqliteQueryTakeFirstSync(
    db,
    k
      .selectFrom("worktrees")
      .select(WORKTREE_RECORD_COLUMNS)
      .where("id", "=", input.plan.record.id),
  );
  if (
    !current ||
    current.removed_at !== null ||
    JSON.stringify(rowToRecord(current)) !== JSON.stringify(input.plan.record)
  ) {
    throw new Error("Worktree changed after preview; inspect a fresh preview");
  }
  // No stale cleanup here: unknown or unreleased custody is not relocation admission.
  if (
    executeSqliteQueryTakeFirstSync(
      db,
      k
        .selectFrom("state_leases")
        .select("owner")
        .where("scope", "=", `worktree-run:${input.plan.record.id}`)
        .limit(1),
    )
  ) {
    throw new Error("Worktree has a run or removal lease; finish its native lifecycle first");
  }
  const row = executeSqliteQueryTakeFirstSync(
    db,
    k
      .insertInto(table)
      .values({
        operation_id: input.operationId,
        worktree_id: input.plan.record.id,
        executor: input.executor,
        executor_pid: process.pid,
        executor_start_time: getFileLockProcessStartTime(process.pid),
        phase: "admitted",
        filesystem_settled: 0,
        revision: 0,
        plan_json: JSON.stringify(input.plan),
        created_at: input.now,
        updated_at: input.now,
        reason: null,
      })
      .returningAll(),
  )!;
  return { receipt: receipt(row), admitted: true };
}

/** Recovery transfers commit custody only; it never grants another filesystem attempt. */
export function recoverWorktreeRelocation(
  db: DatabaseSync,
  input: WorktreeRelocationOperations["worktrees.relocation.recover"]["input"],
): WorktreeMoveReceipt {
  const k = query(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    k.selectFrom(table).selectAll().where("operation_id", "=", input.operationId),
  );
  if (!row) {
    throw new Error("Relocation receipt not found");
  }
  if (row.phase === "verified") {
    return receipt(row);
  }
  // Controller death alone does not prove its Git child exited. Only the original
  // executor can acknowledge settled filesystem effects; recovery never repeats them.
  if (!row.filesystem_settled) {
    throw new Error(
      "Filesystem completion is unproven; preserve the relocation fence for operator recovery",
    );
  }
  if (
    !isLockOwnerDefinitelyStale({
      payload: {
        pid: row.executor_pid,
        ...(row.executor_start_time === null ? {} : { starttime: row.executor_start_time }),
      },
    })
  ) {
    throw new Error("Relocation executor may still be active; preserve the current operation");
  }
  return receipt(
    executeSqliteQueryTakeFirstSync(
      db,
      k
        .updateTable(table)
        .set({
          executor: input.executor,
          executor_pid: process.pid,
          executor_start_time: getFileLockProcessStartTime(process.pid),
          phase: "recovery_required",
          revision: row.revision + 1,
          updated_at: input.now,
        })
        .where("operation_id", "=", row.operation_id)
        .where("revision", "=", row.revision)
        .returningAll(),
    )!,
  );
}

export function advanceWorktreeRelocation(
  db: DatabaseSync,
  input: WorktreeRelocationOperations["worktrees.relocation.advance"]["input"],
): WorktreeMoveReceipt {
  const k = query(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    k.selectFrom(table).selectAll().where("operation_id", "=", input.operationId),
  );
  if (
    !row ||
    row.executor !== input.executor ||
    row.revision !== input.revision ||
    row.phase === "verified"
  ) {
    throw new Error("Relocation executor or revision changed; no effect may be repeated");
  }
  const allowed =
    row.phase === "admitted"
      ? ["moving", "recovery_required"]
      : row.phase === "moving"
        ? ["moved", "recovery_required"]
        : row.phase === "moved"
          ? ["verified", "recovery_required"]
          : row.phase === "recovery_required"
            ? ["moved", "recovery_required"]
            : [];
  if (!allowed.includes(input.phase)) {
    throw new Error("Invalid relocation transition");
  }
  if (input.phase === "verified") {
    const plan = receipt(row).plan;
    if (plan.projection) {
      if (input.projectionRevision === undefined) {
        throw new Error("Projection revision is required");
      }
      const changed = executeSqliteQuerySync(
        db,
        k
          .updateTable("local_workspace_projections")
          .set({
            projection_path: plan.projection.destination,
            revision: input.projectionRevision + 1,
          })
          .where("worktree_id", "=", row.worktree_id)
          .where("projection_path", "=", plan.projection.source.path)
          .where("session_id", "=", plan.projection.sessionId)
          .where("revision", "=", input.projectionRevision)
          .where("journal_json", "is", null)
          .where("pending_ref", "is", null)
          .where("paused_runtimes_json", "is", null),
      ).numAffectedRows;
      if (changed !== 1n) {
        throw new Error("Projection changed before relocation commit");
      }
    } else if (readWorktreeProjection(db, row.worktree_id)) {
      throw new Error("Projection appeared during relocation");
    }
    const changed = executeSqliteQuerySync(
      db,
      k
        .updateTable("worktrees")
        .set({ path: plan.destination })
        .where("id", "=", row.worktree_id)
        .where("path", "=", plan.record.path)
        .where("last_active_at", "=", plan.record.lastActiveAt)
        .where("removed_at", "is", null),
    ).numAffectedRows;
    if (changed !== 1n) {
      throw new Error("Worktree binding changed before relocation commit");
    }
  }
  return receipt(
    executeSqliteQueryTakeFirstSync(
      db,
      k
        .updateTable(table)
        .set({
          phase: input.phase,
          filesystem_settled: input.phase === "moved" ? 1 : row.filesystem_settled,
          revision: row.revision + 1,
          updated_at: input.now,
          reason: input.reason ?? null,
        })
        .where("operation_id", "=", row.operation_id)
        .where("revision", "=", row.revision)
        .returningAll(),
    )!,
  );
}
