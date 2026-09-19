import type { DatabaseSync } from "node:sqlite";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import {
  mergeUpdateRunRecoveryCaptureState,
  type UpdateRecoveryCaptureState,
} from "./update-recovery-backup-contract.js";
import { decodeRun, encodeRun, type UpdateRunLedgerOptions } from "./update-run-codec.js";
import { updateRunLedgerSchema } from "./update-run-ledger-schema.js";
import { readUpdateRunRecord } from "./update-run-reader.js";
import type { UpdateRunRecord } from "./update-run-record.js";

export function persistRun(
  db: DatabaseSync,
  record: UpdateRunRecord,
  options: UpdateRunLedgerOptions,
): UpdateRunRecord {
  record.updatedAtMs = Math.max(Date.now(), record.updatedAtMs + 1);
  const row = encodeRun(record, options);
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
      .updateTable("update_runs")
      .set(row)
      .where("run_id", "=", record.runId),
  );
  return decodeRun(row);
}

export function mutateRunInTransaction(
  db: DatabaseSync,
  runId: string,
  update: (record: UpdateRunRecord) => void,
  options: UpdateRunLedgerOptions,
): UpdateRunRecord {
  const record = readUpdateRunRecord(db, runId);
  if (!record) {
    throw new Error(`Unknown update run: ${runId}`);
  }
  const before = JSON.stringify(record);
  update(record);
  return before === JSON.stringify(record) ? record : persistRun(db, record, options);
}

export function mutateRun(
  runId: string,
  update: (record: UpdateRunRecord) => void,
  options: UpdateRunLedgerOptions,
): UpdateRunRecord {
  // An existing run can belong to a restored older runtime. History updates
  // must never reopen through bootstrap/migration merely to report its outcome.
  return runExistingOpenClawStateWriteTransaction(
    ({ db }) => mutateRunInTransaction(db, runId, update, options),
    options,
    {
      schemaSql: updateRunLedgerSchema,
      operationLabel: "update.run",
      busyTimeoutMs: options.busyTimeoutMs,
    },
  );
}

/** Exact recovery receipts share the existing run owner, outside diagnostic eviction. */
export function recordUpdateRunRecoveryCapture(
  runId: string,
  patch: Pick<UpdateRecoveryCaptureState, "manifestSha256"> & Partial<UpdateRecoveryCaptureState>,
  assertCurrent: () => void,
  options: UpdateRunLedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      assertCurrent();
      record.origin.updateRecoveryCapture = mergeUpdateRunRecoveryCaptureState(record, patch);
    },
    options,
  );
}
