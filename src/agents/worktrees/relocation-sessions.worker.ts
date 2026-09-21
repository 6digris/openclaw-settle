import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { applySessionEntryPatchInDatabase } from "../../config/sessions/session-accessor.sqlite-entry-mutation.js";
import { readSessionEntrySelectionSnapshot } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { originalSessionPaths, relocationSessionDigest } from "./relocation-session-paths.js";
import type { WorktreeSessionReference } from "./relocation.types.js";

export type RelocationSessionOperations = {
  relocate: {
    input: { reference: WorktreeSessionReference; paths: ReturnType<typeof originalSessionPaths> };
    output: undefined;
  };
};

/** Borrow only the canonical agent executor's already-admitted connection. */
export function bindSqliteWorkerBackend(
  input: { agentId: string; env: NodeJS.ProcessEnv },
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<RelocationSessionOperations> {
  const options = {
    agentId: input.agentId,
    path: context.databasePath,
    env: input.env,
  };
  const database = getOpenClawAgentDatabaseIfOpen(options);
  if (!database || database.db !== context.database) {
    throw new Error("Relocation lost its canonical agent database");
  }
  return {
    execute(command) {
      if (getOpenClawAgentDatabaseIfOpen(options) !== database) {
        throw new Error("Relocation lost its canonical agent database");
      }
      // Session patches stage cache state and notifications on the canonical
      // commit edge; a raw SQLite transaction cannot publish or discard them.
      return runOpenClawAgentWriteTransaction(
        (currentDatabase) => {
          if (currentDatabase !== database) {
            throw new Error("Relocation lost its canonical agent database");
          }
          context.admit("transaction");
          const { reference, paths } = command.input;
          const readSnapshot = () =>
            readSessionEntrySelectionSnapshot(database, reference.sessionKey, true);
          const prepared = readSnapshot();
          const current = prepared[0]?.entry;
          if (
            !current ||
            current.sessionId !== reference.sessionId ||
            current.lifecycleRevision !== reference.lifecycleRevision ||
            !isDeepStrictEqual(current.worktree, reference.worktree)
          ) {
            throw new Error("Session incarnation changed during relocation; recovery is required");
          }
          const actualPaths = originalSessionPaths(current);
          if (
            !isDeepStrictEqual(actualPaths, originalSessionPaths(reference)) &&
            !isDeepStrictEqual(actualPaths, paths)
          ) {
            throw new Error("Session workspace changed during relocation; recovery is required");
          }
          // Replay may see our new paths, but every other field must still match
          // the admitted row. Never overwrite a later incarnation or unrelated edit.
          if (
            relocationSessionDigest({ ...current, ...originalSessionPaths(reference) }) !==
            reference.entryDigest
          ) {
            throw new Error("Session row changed since relocation admission; recovery is required");
          }
          applySessionEntryPatchInDatabase(database, {
            operationLabel: "session-entry.patch",
            validateCanonicalKeys: true,
            readSnapshot,
            prepared,
            sessionKey: reference.sessionKey,
            writeBase: current,
            next: isDeepStrictEqual(actualPaths, paths) ? undefined : { ...current, ...paths },
            options: {},
          });
          context.admit("commit");
          return undefined;
        },
        options,
        { operationLabel: "worktrees.relocation.session" },
      );
    },
    assertSettled() {
      assertTransactionUsable(database.db);
      if (database.db.isTransaction) {
        throw new Error("Relocation session transaction did not settle");
      }
    },
    close() {},
  };
}
