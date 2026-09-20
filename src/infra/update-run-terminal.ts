import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import type { UpdateResultPayload } from "./update-result-payload.js";
import {
  claimUpdateResultTelemetry,
  sendUpdateResultTelemetry,
} from "./update-result-telemetry.js";
import type { UpdateRunLedgerOptions as LedgerOptions } from "./update-run-codec.js";
import {
  finishUpdateRunRecord,
  type FinishUpdateRunResult,
  type UpdateRunRecord,
} from "./update-run-record.js";
import {
  mutateRun,
  mutateRunInTransaction,
  updateRunLedgerSchema as schema,
  upsertStep,
} from "./update-run-write.js";

/** A terminal process diagnostic adds evidence without reopening the recorded outcome. */
export function recordUpdateRunDiagnostic(
  runId: string,
  detail: string,
  options: LedgerOptions = {},
): UpdateRunRecord {
  return mutateRun(
    runId,
    (record) => {
      upsertStep(record, {
        step: "finalize:exit",
        status: "completed",
        endedAtMs: Date.now(),
        detail,
      });
    },
    options,
  );
}

export function finishUpdateRun(
  runId: string,
  result: FinishUpdateRunResult,
  options: LedgerOptions = {},
): UpdateRunRecord {
  let payload: UpdateResultPayload | undefined;
  const finished = runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      const record = mutateRunInTransaction(
        db,
        runId,
        (current) => finishUpdateRunRecord(current, result),
        options,
      );
      payload = claimUpdateResultTelemetry(db, record, options);
      return record;
    },
    options,
    { schemaSql: schema, operationLabel: "update.run", busyTimeoutMs: options.busyTimeoutMs },
  );
  if (payload) {
    // The transaction has committed; a failed delivery can never roll back the update.
    void sendUpdateResultTelemetry(payload, { env: options.env });
  }
  return finished;
}
