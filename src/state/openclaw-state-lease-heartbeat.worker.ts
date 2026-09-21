import { parentPort, workerData } from "node:worker_threads";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { runWithSqliteCoordinator } from "../infra/sqlite-coordinator.js";
import {
  isSqliteLockError,
  sqliteErrorCode,
  sqliteExtendedResultCode,
} from "../infra/sqlite-error-diagnostics.js";
import { runSqliteTransactionSync } from "../infra/sqlite-transaction-core.js";
import {
  acquireStateDatabaseCoordinator,
  StateDatabaseCoordinatorContentionError,
} from "../infra/state-database-coordinator.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { openTrackedStateDatabase, closeTrackedStateDatabase } from "./openclaw-state-db-handle.js";
import {
  leaseHeartbeatState as state,
  leaseHeartbeatStartupPhase as startupPhase,
  leaseHeartbeatObservationPhase as observationPhase,
  leaseHeartbeatObservationValue as observationValue,
  markLeaseHeartbeatObservation,
  LEASE_HEARTBEAT_START_TIMEOUT_MS,
  type LeaseHeartbeatRenewalFailure,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import {
  readOpenClawStateLeaseExpiry,
  renewOpenClawStateLeaseInTransaction,
} from "./openclaw-state-lease-store.js";

// SAFETY: The lease owner alone starts this private entry with its typed structured-clone payload.
const params = workerData as LeaseHeartbeatWorkerData;
const shared = new BigInt64Array(params.shared);
const observations = new BigInt64Array(params.observations);
let observingStartup = true;
const mark = (phase: number) => {
  if (observingStartup) {
    markLeaseHeartbeatObservation(observations, phase);
  }
};
mark(observationPhase.workerBody);
Atomics.store(shared, state.startupPhase, startupPhase["body-entry"]);
function withLifecycleCoordinator<T>(label: string, operation: () => T): T {
  // This private worker participates in an actual parent-owned coordinator,
  // retained before construction and released only after native worker exit.
  // Its persisted lease identity and expiry are still checked for every renewal.
  return params.parentCoordinatorRetained
    ? operation()
    : runWithSqliteCoordinator(
        acquireStateDatabaseCoordinator({ databasePath: params.path, busyTimeoutMs: 0 }),
        label,
        operation,
      );
}
function openHeartbeatDatabase() {
  // The parent's bound is a retry deadline, not ownership. Renewal below still
  // checks the exact current persisted owner/expiry before changing the row.
  const deadline = Date.now() + LEASE_HEARTBEAT_START_TIMEOUT_MS;
  const remaining = () =>
    Math.min(deadline, Number(Atomics.load(shared, state.expiresAt))) - Date.now();
  while (remaining() > 0 && Atomics.load(shared, state.status) === state.starting) {
    Atomics.add(observations, observationValue.openAttempts, 1n);
    try {
      return withLifecycleCoordinator("maintenance heartbeat open", () =>
        openTrackedStateDatabase(params.path, { existingOnly: params.existingOnly }),
      );
    } catch (error) {
      if (!(error instanceof StateDatabaseCoordinatorContentionError)) {
        throw error;
      }
    }
    Atomics.wait(shared, state.status, state.starting, Math.max(1, Math.min(25, remaining())));
  }
  throw new Error("state lease heartbeat startup deadline expired or owner stopped");
}
mark(observationPhase.openStart);
const db = openHeartbeatDatabase();
mark(observationPhase.openReturned);
Atomics.store(shared, state.startupPhase, startupPhase["open-complete"]);
let processOwner = params.processOwner;
let heartbeat: ReturnType<typeof setTimeout> | undefined;
let attempt = 0;
const lose = () => {
  Atomics.compareExchange(shared, state.status, state.starting, state.lost);
  Atomics.compareExchange(shared, state.status, state.ready, state.lost);
  Atomics.notify(shared, state.ack);
  clearTimeout(heartbeat);
  closeTrackedStateDatabase(db);
  parentPort?.close();
};
const renew = () => {
  if (Atomics.load(shared, state.status) >= state.closed) {
    return;
  }
  let expiresAt: number | undefined;
  attempt += 1;
  if (observingStartup) {
    Atomics.store(observations, observationValue.renewalAttempt, BigInt(attempt));
  }
  try {
    // Native lookup can be slow; keep it outside write admission and startup readiness.
    if (
      processOwner?.identity.startedAt === null &&
      Atomics.load(shared, state.status) === state.ready
    ) {
      processOwner.identity.startedAt = getFileLockProcessStartTime(
        processOwner.identity.pid,
        processOwner.env,
      );
    }
    mark(observationPhase.coordinatorStart);
    expiresAt = withLifecycleCoordinator("maintenance heartbeat renewal", () => {
      mark(observationPhase.coordinatorOperation);
      mark(observationPhase.busyPolicyStart);
      const renewedAt = runWithSqliteBusyTimeout(
        db,
        0,
        () => {
          mark(observationPhase.transactionStart);
          const result = runSqliteTransactionSync(
            db,
            () => {
              mark(observationPhase.transactionCallback);
              if (Atomics.load(shared, state.status) >= state.closed) {
                mark(observationPhase.transactionCallbackReturned);
                return undefined;
              }
              mark(observationPhase.renewalQueryStart);
              const result = renewOpenClawStateLeaseInTransaction(
                db,
                params.identity,
                params.leaseMs,
                processOwner?.identity,
              );
              mark(observationPhase.renewalQueryReturned);
              mark(observationPhase.transactionCallbackReturned);
              return result;
            },
            "immediate",
            { logger: { warn() {} } },
          );
          mark(observationPhase.transactionReturned);
          return result;
        },
        { lockFailureReporting: "suppress" },
      );
      mark(observationPhase.busyPolicyReturned);
      return renewedAt;
    });
    mark(observationPhase.coordinatorReturned);
    if (expiresAt !== undefined) {
      Atomics.store(shared, state.lastRenewedAt, BigInt(expiresAt - params.leaseMs));
    }
    if (expiresAt !== undefined && processOwner?.identity.startedAt != null) {
      processOwner = undefined;
    }
  } catch (error) {
    mark(observationPhase.renewalCatch);
    if (observingStartup) {
      // Numeric categories: 1 coordinator contention, 2 SQLite contention, 3 other.
      Atomics.store(
        observations,
        observationValue.catchCategory,
        error instanceof StateDatabaseCoordinatorContentionError
          ? 1n
          : isSqliteLockError(error)
            ? 2n
            : 3n,
      );
      Atomics.store(
        observations,
        observationValue.catchSqliteCode,
        BigInt(sqliteExtendedResultCode(error) ?? -1),
      );
    }
    if (!(error instanceof StateDatabaseCoordinatorContentionError) && !isSqliteLockError(error)) {
      parentPort?.postMessage(
        {
          name: error instanceof Error ? error.name : "Error",
          message: coerceErrorMessage(error),
          code: sqliteErrorCode(error),
          errcode: sqliteExtendedResultCode(error),
          attempt,
          elapsedMs: Date.now() - params.acquiredAt,
        } satisfies LeaseHeartbeatRenewalFailure,
        [],
      );
      lose();
      return;
    }
    mark(observationPhase.expiryReadStart);
    expiresAt = readOpenClawStateLeaseExpiry(db, params.identity);
    mark(observationPhase.expiryReadReturned);
  }
  if (expiresAt === undefined) {
    lose();
    return;
  }
  // Contention may delay renewal, but must never delay expiry detection by a
  // full heartbeat interval or authorize renewal after the persisted deadline.
  heartbeat = setTimeout(renew, Math.max(1, Math.min(params.heartbeatMs, expiresAt - Date.now())));
};

Atomics.store(shared, state.startupPhase, startupPhase["initial-renew-start"]);
mark(observationPhase.renewStart);
renew();
mark(observationPhase.renewReturned);
Atomics.store(shared, state.startupPhase, startupPhase["initial-renew-returned"]);
mark(observationPhase.readyCasStart);
const readyObserved = Atomics.compareExchange(shared, state.status, state.starting, state.ready);
Atomics.store(observations, observationValue.readyCasObserved, readyObserved);
mark(observationPhase.readyCasReturned);
observingStartup = false;
if (readyObserved === state.starting) {
  parentPort?.on("message", () => {
    if (Atomics.load(shared, state.status) !== state.ready) {
      return;
    }
    // A caller may hold the state write transaction while checking ownership.
    // Liveness acknowledgements must never wait for that caller's SQLite lock.
    Atomics.store(shared, state.ack, Atomics.load(shared, state.request));
    Atomics.notify(shared, state.ack);
  });
  parentPort?.postMessage(null, []);
}
