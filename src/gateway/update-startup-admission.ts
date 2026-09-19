// Reuse the canonical update watcher; readiness must not wait for terminal publication.
import { findActiveUpdateRun, getUpdateRun } from "../infra/update-run-reader.js";
import { beginGatewayUpdateSettlementAdmission } from "../process/gateway-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const state = resolveGlobalSingleton<{ current?: { refresh(): boolean } }>(
  Symbol.for("openclaw.gatewayUpdateStartupAdmission"),
  () => ({}),
);

/** Called before exposing the successor's transport, after native custody handback. */
export function beginGatewayUpdateStartupAdmission() {
  const run = findActiveUpdateRun();
  if (!run || !["activating", "restarting", "verifying"].includes(run.phase)) {
    return undefined;
  }
  const admission = beginGatewayUpdateSettlementAdmission(run.runId);
  const owner = {
    refresh() {
      const observed = getUpdateRun(run.runId);
      // Missing/unreadable state is not terminal proof. Reconciliation retains custody.
      if (!observed || observed.status === "running") {
        return true;
      }
      admission.release();
      if (state.current === owner) {
        state.current = undefined;
      }
      return false;
    },
  };
  state.current = owner;
  return {
    settled: admission.settled,
    close() {
      if (state.current === owner) {
        state.current = undefined;
      }
      admission.release();
    },
  };
}

/** The existing watcher calls this after canonical interruption reconciliation. */
export function refreshGatewayUpdateStartupAdmission(): boolean {
  return state.current?.refresh() ?? false;
}
