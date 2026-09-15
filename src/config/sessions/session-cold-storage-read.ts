import type { DatabaseSync } from "node:sqlite";
import { beginHistoryProbePhase } from "../../infra/session-history-probe.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  assertSessionTranscriptHot,
  SessionTranscriptColdError,
} from "./session-cold-storage-state.js";

/** The cold marker and hot rows must belong to one snapshot, including cached statement lookups. */
export function readHotSessionTranscriptSnapshot<T>(
  database: { db: DatabaseSync },
  sessionId: string,
  purpose:
    | "identity"
    | "header"
    | "tail"
    | "incremental"
    | "checkpoint"
    | "events"
    | "raw rows"
    | "storage rows"
    | "match",
  read: () => T,
): T {
  return runSqliteDeferredTransactionSync(
    database.db,
    () => {
      assertSessionTranscriptHot(database.db, sessionId);
      return read();
    },
    { operationLabel: `session transcript ${purpose} read` },
  );
}

/** A peer can archive after restoration settles but before the read completes. */
export async function readRestoredSessionTranscript<T>(
  scope: SessionTranscriptReadScope,
  read: () => T | Promise<T>,
  options?: { readOnly?: boolean },
): Promise<T> {
  // Read workers report cold storage to their host; only the host restores it.
  if (options?.readOnly) {
    return read();
  }
  const importDone = beginHistoryProbePhase("branch-cold-import");
  let coldStorage: typeof import("./session-cold-storage.js");
  try {
    coldStorage = await import("./session-cold-storage.js");
  } catch (error) {
    importDone?.(true);
    throw error;
  } finally {
    importDone?.();
  }
  const { restoreSessionColdTranscript } = coldStorage;
  const restoreDone = beginHistoryProbePhase("branch-cold-restore");
  try {
    await restoreSessionColdTranscript(scope);
  } catch (error) {
    restoreDone?.(true);
    throw error;
  } finally {
    restoreDone?.();
  }
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof SessionTranscriptColdError) || error.sessionId !== scope.sessionId) {
      throw error;
    }
    const retryDone = beginHistoryProbePhase("branch-cold-restore");
    try {
      await restoreSessionColdTranscript(scope);
    } catch (restoreError) {
      retryDone?.(true);
      throw restoreError;
    } finally {
      retryDone?.();
    }
    return await read();
  }
}
