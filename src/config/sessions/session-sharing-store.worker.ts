import type { DatabaseSync } from "node:sqlite";
import {
  assertTransactionUsable,
  runSqliteImmediateTransactionSync,
} from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import {
  addSessionMemberInDatabase,
  removeSessionMemberInDatabase,
} from "./session-sharing-store.kernel.js";
import type { SessionMemberWriteOperations } from "./session-sharing-store.operations.js";

export function bindSqliteWorkerBackend(
  _input: unknown,
  context: {
    database: DatabaseSync;
    databasePath: string;
    admit(stage: "transaction" | "commit"): void;
  },
): SqliteWorkerBackend<SessionMemberWriteOperations> {
  const database = { db: context.database };
  let closed = false;
  return {
    execute(command) {
      if (closed) {
        throw new Error("Session membership publication is closed");
      }
      return runSqliteImmediateTransactionSync(
        database.db,
        () => {
          context.admit("transaction");
          if (command.type === "members.add") {
            const value = addSessionMemberInDatabase(
              database,
              command.input.sessionKey,
              command.input.params,
            );
            return { value, changed: value.inserted };
          }
          const value = removeSessionMemberInDatabase(
            database,
            command.input.sessionKey,
            command.input.identityId,
            command.input.expected,
            command.input.expectedSessionId,
          );
          return { value, changed: value !== null };
        },
        {
          databaseLabel: context.databasePath,
          operationLabel: command.type,
          withCommit(commit) {
            context.admit("commit");
            commit();
          },
        },
      );
    },
    assertSettled() {
      assertTransactionUsable(database.db);
      if (database.db.isTransaction) {
        throw new Error("Session membership publication left an unsettled transaction");
      }
    },
    close() {
      closed = true;
    },
  };
}
