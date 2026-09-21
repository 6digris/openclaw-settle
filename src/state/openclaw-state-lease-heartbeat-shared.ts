import type { StateLeaseProcessOwner } from "../infra/state-lease-process-owner.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease-store.js";

export const LEASE_HEARTBEAT_START_TIMEOUT_MS = 5_000;

// Diagnostic derivative only: fixed numeric observations, separate from lease authority.
// Missing return markers remain meaningful when termination interrupts native work.
export const leaseHeartbeatObservationPhase = {
  parentConstructStart: 0,
  parentConstructReturned: 1,
  parentTimerArmed: 2,
  parentTimerCallback: 3,
  parentSettleCasStart: 4,
  parentSettleCasReturned: 5,
  parentFailure: 6,
  parentStopRequested: 7,
  parentStopJoined: 8,
  workerBody: 9,
  openStart: 10,
  openReturned: 11,
  renewStart: 12,
  coordinatorStart: 13,
  coordinatorOperation: 14,
  busyPolicyStart: 15,
  transactionStart: 16,
  transactionCallback: 17,
  renewalQueryStart: 18,
  renewalQueryReturned: 19,
  transactionCallbackReturned: 20,
  transactionReturned: 21,
  busyPolicyReturned: 22,
  coordinatorReturned: 23,
  renewalCatch: 24,
  expiryReadStart: 25,
  expiryReadReturned: 26,
  renewReturned: 27,
  readyCasStart: 28,
  readyCasReturned: 29,
} as const;

export const leaseHeartbeatObservationValue = {
  openAttempts: 30,
  renewalAttempt: 31,
  catchCategory: 32,
  catchSqliteCode: 33,
  readyCasObserved: 34,
} as const;
export const LEASE_HEARTBEAT_OBSERVATION_CELLS = 35;

export function markLeaseHeartbeatObservation(cells: BigInt64Array, phase: number): void {
  // Retain the first boundary in this startup generation; no growing trace buffer.
  Atomics.compareExchange(cells, phase, 0n, process.hrtime.bigint());
}

export const leaseHeartbeatState = {
  status: 0,
  request: 1,
  ack: 2,
  expiresAt: 3,
  lastRenewedAt: 4,
  startupPhase: 5,
  starting: 0n,
  ready: 1n,
  closed: 2n,
  lost: 3n,
} as const;

// Startup observations never grant readiness or lease authority.
export const leaseHeartbeatStartupPhase = {
  "entry-not-observed": 0n,
  "body-entry": 1n,
  "open-complete": 2n,
  "initial-renew-start": 3n,
  "initial-renew-returned": 4n,
} as const;

export type LeaseHeartbeatRenewalFailure = {
  name: string;
  message: string;
  code?: string;
  errcode?: number;
  attempt: number;
  elapsedMs: number;
};

export type LeaseHeartbeatWorkerData = {
  path: string;
  existingOnly?: boolean;
  /** Private parent retains the actual lifecycle coordinator until native worker exit. */
  parentCoordinatorRetained?: true;
  identity: OpenClawStateLeaseIdentity;
  leaseMs: number;
  acquiredAt: number;
  heartbeatMs: number;
  processOwner?: { identity: StateLeaseProcessOwner; env: NodeJS.ProcessEnv };
  shared: SharedArrayBuffer;
  observations: SharedArrayBuffer;
};
