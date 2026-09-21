import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { WorktreeMoveReceipt } from "./relocation.types.js";

/** Public receipts expose the outcome, not the internal session/reference custody plan. */
export function projectWorktreeMoveReceipt(receipt: WorktreeMoveReceipt) {
  const { operationId, worktreeId, phase, revision, createdAt, updatedAt, reason, plan } = receipt;
  return {
    operationId,
    worktreeId,
    phase,
    revision,
    createdAt,
    updatedAt,
    source: plan.source.path,
    destination: plan.destination,
    ...(plan.projection
      ? {
          projection: {
            source: plan.projection.source.path,
            destination: plan.projection.destination,
          },
        }
      : {}),
    ...(reason ? { reason } : {}),
  };
}

export async function readWorktreeMoveReceipts(env: NodeJS.ProcessEnv) {
  return (
    (await runOpenClawStateWorkerOperation(
      captureOpenClawStateWorkerContext({ env }),
      (scope) => scope.execute({ type: "worktrees.relocations", input: undefined }),
      { existingOnly: true },
    )) ?? []
  );
}

export async function readManagedWorktreeBackupInventory(env: NodeJS.ProcessEnv = process.env) {
  // The ordinary worker factory initializes its database before dispatching even
  // a read-only command. Backup must retain missing, invalid, and older source bytes.
  return (
    (await runOpenClawStateWorkerOperation(
      captureOpenClawStateWorkerContext({ env }),
      (scope) => scope.execute({ type: "worktrees.backupInventory", input: undefined }),
      { existingOnly: true },
    )) ?? { roots: [], revision: "missing" }
  );
}

export async function readManagedWorktreeInventory(env: NodeJS.ProcessEnv) {
  return (
    (await runOpenClawStateWorkerOperation(
      captureOpenClawStateWorkerContext({ env }),
      (scope) => scope.execute({ type: "worktrees.inventory", input: undefined }),
      { existingOnly: true },
    )) ?? { worktrees: [], relocations: [], projections: [] }
  );
}

export async function assertWorktreeMoveAvailable(
  env: NodeJS.ProcessEnv,
  id: string,
  operationId?: string,
) {
  const active = (await readWorktreeMoveReceipts(env)).find(
    (row) => row.worktreeId === id && row.phase !== "verified",
  );
  if (active && active.operationId !== operationId) {
    throw new Error(
      `Worktree relocation ${active.operationId} requires verification before this operation`,
    );
  }
}
