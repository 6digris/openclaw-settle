import { getSelfAndAncestorPidsSync } from "../infra/restart-stale-pids.js";
import { recordedUpdateRunDrivers } from "../infra/update-run-activity.js";
import { inspectUpdateRunDriver } from "../infra/update-run-driver.js";
import { getUpdateRun } from "../infra/update-run-reader.js";
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
    return driver ? { runId, pid: driver.pid } : undefined;
  } catch {
    // Unreadable history cannot safely prove an ancestor-held maintenance scope.
    return undefined;
  }
}
