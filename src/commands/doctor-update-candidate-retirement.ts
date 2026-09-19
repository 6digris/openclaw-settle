import fs from "node:fs/promises";
import {
  UpdateCommandExecutorBusyError,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { readPackageVersion } from "../infra/package-json.js";
import { readBuiltGatewayBuildId } from "../infra/update-git-runtime.js";
import {
  inspectUpdateRecoveryBackups,
  readUpdateRecoveryBackupManifest,
} from "../infra/update-recovery-backup.js";
import { recordedUpdateRunDrivers } from "../infra/update-run-activity.js";
import { inspectUpdateRunDriver } from "../infra/update-run-driver.js";
import { getUpdateRun } from "../infra/update-run-ledger.js";
import { hasVerifiedCompletedUpdate } from "../infra/update-run-record.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  assertRecoveryDriversExited,
  retireDoctorResolvedCapture,
} from "./doctor-update-capture-retirement.js";

/** Existing Gateway reconciliation owns legacy-driver cleanup after the parent exits.
 * Return true while known drivers or installation custody settle, not for ambiguous recovery. */
export async function reconcileCandidateUpdateCaptureRetirement(params: {
  runtime: RuntimeEnv;
  signal: AbortSignal;
}): Promise<boolean> {
  let pending = false;
  for (const capture of await inspectUpdateRecoveryBackups()) {
    if (params.signal.aborted) {
      return false;
    }
    const run = getUpdateRun(capture.runId);
    if (
      !run?.steps.some(
        (step) =>
          step.step === "finalize:capture-retirement" &&
          step.detail === "candidate-reconciliation-v1",
      )
    ) {
      continue;
    }
    if (run.status === "running") {
      pending = true;
      continue;
    }
    if (capture.terminalOutcome !== "committed" || !hasVerifiedCompletedUpdate(run)) {
      continue;
    }
    try {
      const manifest = await readUpdateRecoveryBackupManifest(capture.ref, {
        assertOwned: () => params.signal.throwIfAborted(),
      });
      const drivers = [...recordedUpdateRunDrivers(run), manifest.creator, ...manifest.drivers];
      if (drivers.some((driver) => inspectUpdateRunDriver(driver) === "unknown")) {
        throw new Error(
          "An update driver is unobservable; inspect with openclaw update status --json",
        );
      }
      if (drivers.some((driver) => inspectUpdateRunDriver(driver) === "alive")) {
        pending = true;
        continue;
      }
      const root = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
      if (
        !root ||
        (await fs.realpath(root)) !== (await fs.realpath(manifest.installRoot)) ||
        (await readPackageVersion(root)) !== run.after.version ||
        (run.after.buildId && (await readBuiltGatewayBuildId(root)) !== run.after.buildId)
      ) {
        throw new Error("Capture reconciliation runtime does not match the verified installation");
      }
      const assertCurrent = () => {
        params.signal.throwIfAborted();
        assertRecoveryDriversExited(drivers);
        const current = getUpdateRun(run.runId);
        if (
          !hasVerifiedCompletedUpdate(current) ||
          current.after.version !== run.after.version ||
          current.after.buildId !== run.after.buildId ||
          current.verification.readyz !== true ||
          current.verification.settled !== true ||
          current.verification.channelsReady !== true
        ) {
          throw new Error("Capture reconciliation requires matching durable runtime readiness");
        }
      };
      assertCurrent();
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        const executorFence = await executor.enter(manifest.installRoot);
        assertCurrent();
        await retireDoctorResolvedCapture(capture.ref, params.runtime, undefined, {
          installRoot: manifest.installRoot,
          executorFence,
          assertCurrent,
        });
      });
    } catch (error) {
      if (error instanceof UpdateCommandExecutorBusyError && !params.signal.aborted) {
        pending = true;
        continue;
      }
      if (!params.signal.aborted) {
        params.runtime.error(
          `Update capture retained at ${capture.ref.manifestPath}: ${formatErrorMessage(error)}. Run openclaw update status --json; resolve with npx openclaw@latest doctor --fix.`,
        );
      }
    }
  }
  return pending;
}
