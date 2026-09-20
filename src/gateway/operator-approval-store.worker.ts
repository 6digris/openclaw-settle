import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  getOperatorApprovalDetailed,
  listTerminalOperatorApprovals,
  OperatorApprovalHistoryCursorError,
} from "./operator-approval-store.js";
import type { OperatorApprovalWorkerOperations } from "./operator-approval-store.worker-contract.js";

export function executeOperatorApprovalCommand(
  command: SqliteWorkerCommand<OperatorApprovalWorkerOperations>,
  databaseOptions: OpenClawStateDatabaseOptions,
) {
  if (command.type === "operatorApproval.getDetailed") {
    return runOpenClawStateWriteTransaction(() => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const result = getOperatorApprovalDetailed({ ...command.input, databaseOptions });
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return result;
    }, databaseOptions);
  }
  try {
    return {
      ok: true as const,
      history: listTerminalOperatorApprovals({ ...command.input, databaseOptions }),
    };
  } catch (error) {
    if (error instanceof OperatorApprovalHistoryCursorError) {
      return { ok: false as const };
    }
    throw error;
  }
}
