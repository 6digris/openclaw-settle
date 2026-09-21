import type { Worker } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { formatSqliteErrorCodeSuffix } from "../infra/sqlite-error-diagnostics.js";
import {
  acquireStateDatabaseHandleLease,
  retainHeldStateDatabaseCoordinator,
} from "../infra/state-database-coordinator.js";
import { createCpuTrackedWorker } from "../infra/worker-cpu.js";
import { runInDetachedAsyncContext } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  leaseHeartbeatState as state,
  leaseHeartbeatStartupPhase,
  leaseHeartbeatObservationPhase as observationPhase,
  leaseHeartbeatObservationValue as observationValue,
  markLeaseHeartbeatObservation,
  LEASE_HEARTBEAT_OBSERVATION_CELLS,
  LEASE_HEARTBEAT_START_TIMEOUT_MS,
  type LeaseHeartbeatRenewalFailure,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";

const WORKER_RESPONSE_TIMEOUT_MS = 1_000;
let observationStartupOrdinal = 0;

export function startOpenClawStateLeaseHeartbeat(
  params: Omit<
    LeaseHeartbeatWorkerData,
    "shared" | "observations" | "parentCoordinatorRetained"
  > & {
    expiresAt: number;
    onLost: (error: Error) => void;
    /** The live host renews until the worker can take over; never revives an expired owner. */
    renewDuringStartup?: () => number;
  },
) {
  const startedAt = performance.now();
  const observationOrigin = process.hrtime.bigint();
  const startupOrdinal = ++observationStartupOrdinal;
  const observations = new BigInt64Array(
    new SharedArrayBuffer(LEASE_HEARTBEAT_OBSERVATION_CELLS * BigInt64Array.BYTES_PER_ELEMENT),
  );
  const mark = (phase: number) => markLeaseHeartbeatObservation(observations, phase);
  const shared = new BigInt64Array(
    new SharedArrayBuffer((state.startupPhase + 1) * BigInt64Array.BYTES_PER_ELEMENT),
  );
  Atomics.store(shared, state.expiresAt, BigInt(params.expiresAt));
  const url = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.stateLeaseHeartbeat);
  const workerArgv = resolveRuntimeWorkerArgv(url);
  // Source aliases belong to the parent-selected tsconfig, not an unrelated cwd.
  // Keep the lease worker isolated from every other ambient environment setting.
  const sourceTsconfig = workerArgv.length > 1 ? process.env.TSX_TSCONFIG_PATH : undefined;
  // Retain a parent-owned physical lease through native worker teardown. A forced
  // Worker.terminate() need not run JS cleanup; the exit event does attest that
  // native source handles have settled before this last guard is released.
  const coordinator = retainHeldStateDatabaseCoordinator(params.path);
  let observationFailed = false;
  let observationReady = false;
  let observationTimerArms = 0;
  let observationTimerDelayMs = 0;
  let observationTimerArmedElapsedMs = 0;
  const observeTimerArm = (delayMs: number) => {
    observationTimerArms += 1;
    observationTimerDelayMs = delayMs;
    observationTimerArmedElapsedMs = Number(process.hrtime.bigint() - observationOrigin) / 1e6;
    mark(observationPhase.parentTimerArmed);
  };
  const emitObservation = (stage: number, stopCode?: number) => {
    // This temporary receipt contains no path, lease identity, environment or error text.
    // Observations must never replace the existing failure or cleanup result.
    try {
      const elapsedMs = Object.fromEntries(
        Object.entries(observationPhase).map(([name, slot]) => {
          const tick = Atomics.load(observations, slot);
          return [name, tick === 0n ? null : Number(tick - observationOrigin) / 1e6];
        }),
      );
      const values = Object.fromEntries(
        Object.entries(observationValue).map(([name, slot]) => [
          name,
          Number(Atomics.load(observations, slot)),
        ]),
      );
      process.stderr.write(
        `[lease-startup-observation] ${JSON.stringify({
          version: 1,
          stage,
          pid: process.pid,
          startupOrdinal,
          parentCoordinatorRetained: Boolean(coordinator),
          status: Number(Atomics.load(shared, state.status)),
          sampleElapsedMs: Number(process.hrtime.bigint() - observationOrigin) / 1e6,
          startupElapsedMs: performance.now() - startedAt,
          startupCapMs: LEASE_HEARTBEAT_START_TIMEOUT_MS,
          startupTimeoutMs,
          timerArms: observationTimerArms,
          timerDelayMs: observationTimerDelayMs,
          timerArmedElapsedMs: observationTimerArmedElapsedMs,
          elapsedMs,
          values,
          stopCode,
        })}\n`,
      );
    } catch {
      // Best-effort diagnostic output cannot alter the original outcome.
    }
  };
  let handle: ReturnType<typeof acquireStateDatabaseHandleLease>;
  try {
    handle = acquireStateDatabaseHandleLease({ databasePath: params.path, busyTimeoutMs: 0 });
  } catch (error) {
    coordinator?.release();
    throw error;
  }
  const release = () => {
    try {
      handle.release();
    } finally {
      coordinator?.release();
    }
  };
  let worker: Worker;
  try {
    mark(observationPhase.parentConstructStart);
    // Native stdio ports can outlive termination and retain their creation context.
    worker = runInDetachedAsyncContext(() =>
      createCpuTrackedWorker(url, {
        workerData: {
          path: params.path,
          existingOnly: params.existingOnly,
          ...(coordinator ? { parentCoordinatorRetained: true as const } : {}),
          identity: {
            scope: params.identity.scope,
            key: params.identity.key,
            owner: params.identity.owner,
          },
          leaseMs: params.leaseMs,
          acquiredAt: params.acquiredAt,
          heartbeatMs: params.heartbeatMs,
          processOwner: params.processOwner,
          shared: shared.buffer,
          observations: observations.buffer,
        } satisfies LeaseHeartbeatWorkerData,
        env: sourceTsconfig ? { TSX_TSCONFIG_PATH: sourceTsconfig } : {},
        execArgv: workerArgv.slice(0, -1),
        stdout: true,
        stderr: true,
      }),
    );
    mark(observationPhase.parentConstructReturned);
  } catch (error) {
    release();
    throw error;
  }
  let onlineObserved = false;
  worker.once("online", () => {
    onlineObserved = true;
  });
  let handleReleaseError: Error | undefined;
  worker.once("exit", () => {
    try {
      release();
    } catch (error) {
      handleReleaseError = new Error("state lease heartbeat handle release failed", {
        cause: error,
      });
      params.onLost(handleReleaseError);
    }
  });
  // Worker stdio uses parent message delivery, which maintenance can block.
  // The heartbeat emits no normal output; drain runtime bootstrap diagnostics.
  worker.stdout.resume();
  worker.stderr.resume();
  const ready = createDeferredCore();
  let startupRenewal: ReturnType<typeof setTimeout> | undefined;
  const clearStartupTimers = () => {
    clearTimeout(startTimer);
    clearTimeout(startupRenewal);
    startupRenewal = undefined;
  };
  const fail = (error: Error) => {
    if (Atomics.load(shared, state.status) === state.closed) {
      return;
    }
    const observeFailure = !observationReady && !observationFailed;
    if (observeFailure) {
      observationFailed = true;
      mark(observationPhase.parentFailure);
    }
    try {
      Atomics.store(shared, state.status, state.lost);
      Atomics.notify(shared, state.ack);
      clearStartupTimers();
      ready.reject(error);
      params.onLost(error);
    } finally {
      // Revoke and notify first; a redirected stderr write can block the parent.
      // The failure marker precedes revocation; this later snapshot has its own time.
      if (observeFailure) {
        emitObservation(0);
      }
    }
  };
  const settleStartup = (trigger: "timeout" | "message") => {
    if (trigger === "timeout") {
      mark(observationPhase.parentTimerCallback);
    }
    clearTimeout(startTimer);
    if (trigger === "timeout" && Atomics.load(shared, state.status) === state.starting) {
      const elapsedMs = performance.now() - startedAt;
      const remainingMs = Math.min(
        LEASE_HEARTBEAT_START_TIMEOUT_MS - elapsedMs,
        Number(Atomics.load(shared, state.expiresAt)) - Date.now(),
      );
      if (remainingMs > 0) {
        // A committed host renewal changes the lease bound, never the startup cap.
        startupTimeoutMs = Math.round(elapsedMs + remainingMs);
        startTimer = setTimeout(() => settleStartup("timeout"), remainingMs);
        observeTimerArm(remainingMs);
        return;
      }
    }
    clearStartupTimers();
    // Readiness precedes notification delivery. A delayed parent must not
    // overwrite ready; callback entry still requires a fresh acknowledgement.
    mark(observationPhase.parentSettleCasStart);
    const observedStatus = Atomics.compareExchange(
      shared,
      state.status,
      state.starting,
      state.lost,
    );
    mark(observationPhase.parentSettleCasReturned);
    if (observedStatus === state.ready) {
      observationReady = true;
      ready.resolve();
    } else {
      // Report the status before our transition, not the lost state it writes.
      const status =
        observedStatus === state.starting
          ? "starting"
          : observedStatus === state.lost
            ? "lost"
            : "closed";
      // This is the phase sampled at failure, not a deadline timestamp. A queued
      // online event also cannot prove whether the worker has entered its module.
      const observedPhase = Atomics.load(shared, state.startupPhase);
      const startupPhase = Object.entries(leaseHeartbeatStartupPhase).find(
        ([, value]) => value === observedPhase,
      )?.[0];
      fail(
        new Error(
          `state lease heartbeat did not become ready (phase=startup, trigger=${trigger}, status=${status}, elapsedMs=${Math.round(performance.now() - startedAt)}, timeoutMs=${startupTimeoutMs}, onlineObserved=${onlineObserved}, startupPhase=${startupPhase})`,
        ),
      );
    }
  };
  let startupTimeoutMs = Math.max(
    1,
    Math.min(LEASE_HEARTBEAT_START_TIMEOUT_MS, params.expiresAt - Date.now()),
  );
  let startTimer = setTimeout(() => settleStartup("timeout"), startupTimeoutMs);
  observeTimerArm(startupTimeoutMs);
  const renewDuringStartup = params.renewDuringStartup;
  const renewStartup = () => {
    startupRenewal = undefined;
    if (Atomics.load(shared, state.status) !== state.starting || !renewDuringStartup) {
      return;
    }
    try {
      const expiresAt = renewDuringStartup();
      if (Atomics.load(shared, state.status) !== state.starting) {
        return;
      }
      Atomics.store(shared, state.expiresAt, BigInt(expiresAt));
      startupRenewal = setTimeout(renewStartup, params.heartbeatMs);
    } catch (error) {
      fail(
        error instanceof Error
          ? error
          : new Error("state lease startup renewal failed", { cause: error }),
      );
    }
  };
  if (renewDuringStartup) {
    startupRenewal = setTimeout(renewStartup, params.heartbeatMs);
  }
  let renewalFailure: LeaseHeartbeatRenewalFailure | undefined;
  const exitError = (exitCode?: number) => {
    const lastRenewedAt = Atomics.load(shared, state.lastRenewedAt);
    const detail = renewalFailure
      ? `: ${renewalFailure.name}: ${renewalFailure.message}${formatSqliteErrorCodeSuffix(renewalFailure)} (attempt=${renewalFailure.attempt}, elapsedMs=${renewalFailure.elapsedMs})`
      : Atomics.load(shared, state.status) === state.lost
        ? ": lease expired or ownership lost"
        : "";
    return new Error(
      `state lease heartbeat exited${detail} (exitCode=${exitCode ?? "unknown"}, acquiredAt=${params.acquiredAt}, lastRenewedAt=${lastRenewedAt || "never"})`,
      renewalFailure
        ? { cause: Object.assign(new Error(renewalFailure.message), renewalFailure) }
        : undefined,
    );
  };
  worker.once("error", (error) =>
    fail(
      renewalFailure ? exitError() : toErrorObject(error, "state lease heartbeat worker failed"),
    ),
  );
  worker.once("exit", (code) => fail(exitError(code)));
  worker.on("message", (failure: LeaseHeartbeatRenewalFailure | null) => {
    if (failure) {
      renewalFailure ??= failure;
    } else {
      settleStartup("message");
    }
  });
  let stopping: Promise<number> | undefined;
  const close = () => {
    Atomics.store(shared, state.status, state.closed);
    Atomics.notify(shared, state.ack);
    clearStartupTimers();
    ready.reject(new Error("state lease heartbeat closed"));
  };
  return {
    ready: ready.promise,
    close,
    stop() {
      mark(observationPhase.parentStopRequested);
      close();
      return (stopping ??= worker.terminate().then((code) => {
        mark(observationPhase.parentStopJoined);
        if (observationFailed) {
          emitObservation(1, code);
        }
        if (handleReleaseError) {
          throw handleReleaseError;
        }
        return code;
      }));
    },
    assertResponsive(expiresAt: number) {
      const deadline =
        performance.now() + Math.min(WORKER_RESPONSE_TIMEOUT_MS, expiresAt - Date.now());
      const request = Atomics.add(shared, state.request, 1n) + 1n;
      worker.postMessage(null, []);
      // Exit/error callbacks may be queued behind a synchronous SQLite phase.
      // Require a fresh acknowledgement, never a cached ready/alive observation.
      while (Atomics.load(shared, state.status) === state.ready) {
        const ack = Atomics.load(shared, state.ack);
        if (ack === request && Atomics.load(shared, state.status) === state.ready) {
          return;
        }
        const remainingMs = deadline - performance.now();
        if (remainingMs <= 0) {
          break;
        }
        Atomics.wait(shared, state.ack, ack, remainingMs);
      }
      const error = new Error("state lease heartbeat is not responsive");
      fail(error);
      throw error;
    },
  };
}
