import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  readWorktreeSessionReferences,
  verifyWorktreeSessionReferences,
} from "./relocation-references.js";
import {
  admitWorktreeRelocation,
  advanceWorktreeRelocation,
  ensureWorktreeRelocationSchema,
  readWorktreeRelocations,
  readWorktreeProjection,
  readWorktreeBackupInventory,
  recoverWorktreeRelocation,
  assertWorktreeNotProjectOwner,
  readWorktreeInventory,
} from "./relocation.kernel.js";
import type { WorktreeRelocationOperations } from "./relocation.types.js";

export function isWorktreeRelocationCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<WorktreeRelocationOperations> {
  switch (command.type) {
    case "worktrees.inventory":
    case "worktrees.backupInventory":
    case "worktrees.projection":
    case "worktrees.references":
    case "worktrees.verifyReferences":
    case "worktrees.relocations":
    case "worktrees.relocation.admit":
    case "worktrees.relocation.advance":
    case "worktrees.relocation.recover":
      return true;
    default:
      return false;
  }
}

/** Inventory preserves source artifacts; only relocation mutations open a writer. */
export function executeWorktreeRelocationCommand(
  command: SqliteWorkerCommand<WorktreeRelocationOperations>,
  context: { databasePath: string },
  open: () => OpenClawStateDatabase,
): WorktreeRelocationOperations[keyof WorktreeRelocationOperations]["output"] {
  if (command.type === "worktrees.inventory") {
    return (
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
        ({ db }) => readWorktreeInventory(db),
        { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
      ) ?? { worktrees: [], relocations: [], projections: [] }
    );
  }
  if (command.type === "worktrees.backupInventory") {
    return (
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
        ({ db }) => readWorktreeBackupInventory(db),
        { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
      ) ?? { roots: [], revision: "missing" }
    );
  }
  if (command.type === "worktrees.projection") {
    return withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readWorktreeProjection(db, command.input.id),
      { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
    );
  }
  if (command.type === "worktrees.references") {
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => {
        assertWorktreeNotProjectOwner(db, command.input.record.path);
        if (command.input.projectionPath) {
          assertWorktreeNotProjectOwner(db, command.input.projectionPath);
        }
      },
      { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
    );
    // Tilde paths must use the caller's resolved effective home, not the
    // worker process home; the canonical state directory remains captured separately.
    return readWorktreeSessionReferences(
      command.input.config,
      { ...getSqliteWorkerStateContext().environment, HOME: command.input.homeDir },
      command.input.record,
      command.input.projectionPath,
    );
  }
  if (command.type === "worktrees.verifyReferences") {
    return verifyWorktreeSessionReferences(
      command.input,
      getSqliteWorkerStateContext().environment,
    );
  }
  if (command.type === "worktrees.relocations") {
    return (
      withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
        ({ db }) => readWorktreeRelocations(db),
        { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
      ) ?? []
    );
  }
  const writeOptions = {
    database: open(),
    path: context.databasePath,
    env: getSqliteWorkerStateContext().environment,
  };
  if (
    command.type === "worktrees.relocation.admit" ||
    command.type === "worktrees.relocation.advance" ||
    command.type === "worktrees.relocation.recover"
  ) {
    ensureWorktreeRelocationSchema(writeOptions);
    return runOpenClawStateWriteTransaction(
      ({ db }) =>
        command.type === "worktrees.relocation.admit"
          ? admitWorktreeRelocation(db, command.input)
          : command.type === "worktrees.relocation.recover"
            ? recoverWorktreeRelocation(db, command.input)
            : advanceWorktreeRelocation(db, command.input),
      writeOptions,
    );
  }
  throw new Error("Unknown worktree relocation worker command");
}
