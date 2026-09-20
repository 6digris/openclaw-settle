// Persists task registry records through the global shared-state database owner.
import { isDeepStrictEqual } from "node:util";
import type { AdmittedRunContext } from "../agents/admitted-run-context.js";
import {
  executionOwnerBindingFromAdmission,
  type ExecutionOwnerBindingResult,
} from "../audit/execution-owner-binding.js";
import { readSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { repairLegacyTaskIdentifiers } from "../state/openclaw-state-db-legacy-backfills.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { withSharedStateWriteCoordinator } from "../state/openclaw-state-db-write-coordination.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { prepareTaskRecordUpdate } from "./task-registry-transition.operation.js";
import { matchesTaskIdentityInDatabase } from "./task-registry.store.identity.js";
import {
  bindTaskRunExecutionInDatabase,
  deleteTaskRowsWithDeliveryState,
  listTaskRecordsByRuntimeSourceIdInDatabase,
  readTaskRegistrySnapshot,
  readTaskRegistryMutationSnapshotInDatabase,
  readTaskRegistrySnapshotIfReady,
  upsertTaskDeliveryStateInDatabase,
  upsertTaskWithDeliveryStateInDatabase,
  type TaskRegistryDatabase,
  type TaskRegistryReadOnlyLoadResult,
} from "./task-registry.store.kernel.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
} from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord, TaskRuntime } from "./task-registry.types.js";

let cachedDatabase: TaskRegistryDatabase | null = null;

function openTaskRegistryDatabase(): TaskRegistryDatabase {
  const database = openOpenClawStateDatabase();
  const pathname = database.path;
  if (cachedDatabase && cachedDatabase.path === pathname && cachedDatabase.db.isOpen) {
    return cachedDatabase;
  }
  if (cachedDatabase && !cachedDatabase.db.isOpen) {
    cachedDatabase = null;
  }
  cachedDatabase = {
    db: database.db,
    path: pathname,
  };
  return cachedDatabase;
}

function withWriteTransaction(write: (database: OpenClawStateDatabase) => void) {
  // Open once before BEGIN; the callback receives that exact shared-state owner.
  openTaskRegistryDatabase();
  runOpenClawStateWriteTransaction((database) => write(database));
}

export function loadTaskRegistryStateFromSqlite(): TaskRegistryStoreSnapshot {
  return readTaskRegistrySnapshot(openTaskRegistryDatabase());
}

export function repairLegacyTaskIdentifiersInSqlite(): void {
  withWriteTransaction(({ db }) => repairLegacyTaskIdentifiers(db));
}

export function withTaskRegistrySqliteMutation<T>(operation: () => T): T {
  const database = openTaskRegistryDatabase();
  return withSharedStateWriteCoordinator(
    { databasePath: database.path, existing: database.db, operationLabel: "task.mutation" },
    operation,
  );
}

/** A native compatibility caller joins already-granted worker writes before selecting rows. */
export function settleTaskRegistrySqliteWrites(join: (deadlineMs: number) => void): void {
  const deadlineMs = performance.now() + readSqliteBusyTimeout(openTaskRegistryDatabase().db);
  runOpenClawStateWriteTransaction(() => {}, undefined, { operationLabel: "task.event.settle" });
  join(deadlineMs);
}

export function loadTaskRegistryMutationStateFromSqlite(
  scopes: readonly TaskRegistryMutationScope[],
): TaskRegistryStoreSnapshot {
  return readTaskRegistryMutationSnapshotInDatabase(openTaskRegistryDatabase().db, scopes);
}

/** Loads task records without creating or migrating shared state. */
export function loadTaskRegistryStateFromSqliteReadOnly(): TaskRegistryStoreSnapshot {
  return loadTaskRegistryStateFromSqliteReadOnlyResult().snapshot;
}

/** Reads task state only when the existing database already has the canonical task shape. */
export function loadTaskRegistryStateFromSqliteReadOnlyResult(): TaskRegistryReadOnlyLoadResult {
  return (
    withExistingOpenClawStateDatabaseReadOnly(readTaskRegistrySnapshotIfReady) ?? {
      state: "ready",
      snapshot: { tasks: new Map(), deliveryStates: new Map() },
    }
  );
}

/** Reads task rows for one runtime/source without restoring the process registry snapshot. */
export function listTaskRegistryRecordsByRuntimeSourceIdFromSqlite(params: {
  runtime: TaskRuntime;
  sourceId?: string;
}): TaskRecord[] {
  const sourceId = params.sourceId?.trim();
  if (params.sourceId !== undefined && !sourceId) {
    return [];
  }
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
      listTaskRecordsByRuntimeSourceIdInDatabase(db, params.runtime, sourceId),
    ) ?? []
  );
}

/** Compares raw persisted identity without creating or migrating shared state. */
export function matchesTaskIdentityFromSqlite(task: TaskRecord): boolean | undefined {
  try {
    return withExistingOpenClawStateDatabaseReadOnly(({ db }) =>
      matchesTaskIdentityInDatabase(db, task),
    );
  } catch {
    return undefined;
  }
}

/** Compare and settle only the joined parent's exact persisted projection, in one write transaction. */
export function settleTriageTaskFromSqlite(params: {
  expected: TaskRecord;
  status: "succeeded" | "failed";
  endedAt: number;
  terminalSummary: string;
  assertCurrent: () => void;
}): TaskRecord | undefined {
  return runOpenClawStateWriteTransaction(({ db }) => {
    params.assertCurrent();
    if (matchesTaskIdentityInDatabase(db, params.expected) !== true) {
      return undefined;
    }
    const snapshot = readTaskRegistryMutationSnapshotInDatabase(db, {
      taskId: params.expected.taskId,
    });
    const current = snapshot.tasks.get(params.expected.taskId);
    if (
      !current ||
      current.runtime !== "cli" ||
      current.taskKind !== "triage_repair" ||
      current.status !== "running" ||
      current.endedAt !== undefined ||
      !isDeepStrictEqual(current, params.expected)
    ) {
      return undefined;
    }
    const { task } = prepareTaskRecordUpdate(current, {
      status: params.status,
      endedAt: params.endedAt,
      lastEventAt: params.endedAt,
      progressSummary: undefined,
      terminalSummary: params.terminalSummary,
    });
    upsertTaskWithDeliveryStateInDatabase(
      { db },
      {
        task,
        deliveryState: snapshot.deliveryStates.get(task.taskId),
      },
    );
    return task;
  });
}

/** Binds only the exact task row selected before admission; runId is never a join key. */
export function bindTaskRunExecution(params: {
  admitted: AdmittedRunContext;
  taskId: string;
  options?: OpenClawStateDatabaseOptions;
}): ExecutionOwnerBindingResult {
  const binding = executionOwnerBindingFromAdmission(params.admitted);
  if (!binding) {
    return "disabled";
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => bindTaskRunExecutionInDatabase(db, params.taskId, binding),
    params.options,
    { operationLabel: "task.run.execution-binding" },
  );
}

export function upsertTaskWithDeliveryStateToSqlite(params: {
  task: TaskRecord;
  deliveryState?: TaskDeliveryState;
}) {
  withWriteTransaction((database) => upsertTaskWithDeliveryStateInDatabase(database, params));
}

export function deleteTaskAndDeliveryStateFromSqlite(taskId: string) {
  withWriteTransaction(({ db }) => {
    deleteTaskRowsWithDeliveryState(db, taskId);
  });
}

export function upsertTaskDeliveryStateToSqlite(state: TaskDeliveryState) {
  withWriteTransaction(({ db }) => upsertTaskDeliveryStateInDatabase(db, state));
}

export function closeTaskRegistryDatabase() {
  cachedDatabase = null;
  closeOpenClawStateDatabase();
}
