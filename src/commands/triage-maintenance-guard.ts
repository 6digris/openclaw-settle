import { getSelfAndAncestorPidsSync } from "../infra/restart-stale-pids.js";
import {
  acquireGatewayMaintenanceCoordinator,
  StateDatabaseCoordinatorContentionError,
} from "../infra/state-database-coordinator.js";
import { recordedUpdateRunDrivers } from "../infra/update-run-activity.js";
import { inspectUpdateRunDriver } from "../infra/update-run-driver.js";
import { getUpdateRun } from "../infra/update-run-reader.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { TriageMaintenanceBlock } from "./triage-prompt.js";
import type { TriageUpdateFailure } from "./triage-update.js";

/** Detect an active update owner above triage before recommending nested maintenance. */
export function inspectTriageMaintenanceBlock(
  failure: TriageUpdateFailure | undefined,
  env: NodeJS.ProcessEnv,
): TriageMaintenanceBlock | undefined {
  const runId = failure && "result" in failure ? failure.result.runId : undefined;
  if (!runId) {
    return undefined;
  }
  try {
    const run = getUpdateRun(runId, { env });
    if (run?.status !== "running") {
      return undefined;
    }
    const ancestors = getSelfAndAncestorPidsSync(undefined, { requireVerifiedParent: true });
    const driver = recordedUpdateRunDrivers(run).find(
      (candidate) => ancestors.has(candidate.pid) && inspectUpdateRunDriver(candidate) === "alive",
    );
    if (!driver) {
      return undefined;
    }
    try {
      const maintenance = acquireGatewayMaintenanceCoordinator({
        databasePath: resolveOpenClawStateSqlitePath(env),
        busyTimeoutMs: 0,
      });
      maintenance.release();
      return undefined;
    } catch (error) {
      return error instanceof StateDatabaseCoordinatorContentionError
        ? { runId, pid: driver.pid }
        : undefined;
    }
  } catch {
    // Unreadable history cannot safely prove an ancestor-held maintenance scope.
    return undefined;
  }
}
