import path from "node:path";
import type { UpdateRecoveryBackupRef } from "../infra/update-recovery-backup-contract.js";
import { inspectUpdateRunDriver, type UpdateRunDriver } from "../infra/update-run-driver.js";
import { hasVerifiedCompletedUpdate } from "../infra/update-run-record.js";
import type { UpdateRecoveryFence } from "../infra/update-run-recovery.js";
import type { RuntimeEnv } from "../runtime.js";

export function assertRecoveryDriversExited(drivers: readonly UpdateRunDriver[]): void {
  if (drivers.some((driver) => inspectUpdateRunDriver(driver) !== "dead")) {
    throw new Error(
      "Update recovery still has a live or unobservable owner. Let the update and its Doctor exit, then run `npx openclaw@latest doctor --fix` again.",
    );
  }
}

/** Admission may settle a completed prior update, but never adopt unresolved recovery. */
export async function resolveCompletedDoctorUpdateRecovery(params: {
  installRoot: string;
  executorFence: UpdateRecoveryFence;
  runtime: RuntimeEnv;
}): Promise<void> {
  params.executorFence.assertCurrent();
  const { inspectUpdateRecoveryBackups } = await import("../infra/update-recovery-backup.js");
  const { getUpdateRun } = await import("../infra/update-run-ledger.js");
  const inspections = await inspectUpdateRecoveryBackups({ installRoot: params.installRoot });
  params.executorFence.assertCurrent();
  for (const inspection of inspections) {
    if (
      inspection.terminalOutcome !== "committed" ||
      inspection.captureStatus === "restored" ||
      inspection.captureStatus === "restore-failed" ||
      !hasVerifiedCompletedUpdate(getUpdateRun(inspection.runId))
    ) {
      continue;
    }
    await retireDoctorResolvedCapture(inspection.ref, params.runtime, undefined, params);
  }
}

/** Doctor and update admission share terminal reconciliation without replaying stale captures. */
export async function retireDoctorResolvedCapture(
  ref: UpdateRecoveryBackupRef,
  runtime: RuntimeEnv,
  retirement?: { runId: string; installRoot: string },
  admission?: {
    installRoot: string;
    executorFence: UpdateRecoveryFence;
    assertCurrent?: () => void;
  },
): Promise<void> {
  const {
    readUpdateRecoveryBackupManifest,
    inspectUpdateRecoveryBackups,
    reconcileUpdateRecoveryBackupOutcome,
    retireUpdateRecoveryBackup,
  } = await import("../infra/update-recovery-backup.js");
  const { withUpdateCommandExecutor } =
    await import("../cli/update-cli/update-command-executor.js");
  const manifest = retirement
    ? undefined
    : await readUpdateRecoveryBackupManifest(ref, {
        assertOwned: () => admission?.executorFence.assertCurrent(),
      });
  const target = retirement ?? manifest;
  if (!target) {
    throw new Error("Capture retirement has no recorded identity");
  }
  if (admission && target.installRoot !== path.resolve(admission.installRoot)) {
    throw new Error(`Update capture belongs to another installation: ${ref.manifestPath}`);
  }
  const drivers = manifest ? [manifest.creator, ...manifest.drivers] : [];
  const { assertUpdateRecoveryAdmission } =
    await import("../infra/update-run-recovery-admission.js");
  const { assertNoPendingUpdateRecovery } = await import("../infra/update-run-recovery.js");
  const { getUpdateRun } = await import("../infra/update-run-ledger.js");
  const { withUpdateBackupWriterExclusion } =
    await import("../cli/update-cli/update-command-backup-writers.js");
  const retire = (fence: UpdateRecoveryFence) => {
    fence.assertCurrent();
    admission?.assertCurrent?.();
    assertRecoveryDriversExited(drivers);
    return withUpdateBackupWriterExclusion(
      { root: target.installRoot, env: process.env },
      async (assertWritersOwned) => {
        fence.assertCurrent();
        await assertUpdateRecoveryAdmission({ env: process.env });
        const assertOwned = () => {
          fence.assertCurrent();
          admission?.assertCurrent?.();
          assertWritersOwned();
          assertNoPendingUpdateRecovery({ env: process.env });
          assertRecoveryDriversExited(drivers);
          if (admission) {
            if (!hasVerifiedCompletedUpdate(getUpdateRun(target.runId))) {
              throw new Error(
                `Update capture has no proven successful outcome: ${ref.manifestPath}. Inspect with openclaw update status --json; resolve with npx openclaw@latest doctor --fix.`,
              );
            }
          }
        };
        if (!retirement) {
          const current = (await inspectUpdateRecoveryBackups()).find(
            (entry) =>
              entry.ref.directory === ref.directory &&
              entry.ref.manifestSha256 === ref.manifestSha256,
          );
          if (
            current?.status !== "stale" ||
            (admission &&
              (current.terminalOutcome !== "committed" ||
                current.captureStatus === "restored" ||
                current.captureStatus === "restore-failed"))
          ) {
            throw new Error(
              `Capture resolution is ambiguous: ${ref.manifestPath}. Inspect with openclaw update status --json.`,
            );
          }
          if (admission) {
            await reconcileUpdateRecoveryBackupOutcome(current, { assertOwned });
          }
        }
        assertOwned();
        await retireUpdateRecoveryBackup(ref, { assertOwned });
        runtime.log(`Resolved update capture retired: ${ref.manifestPath}`);
      },
    );
  };
  if (admission) {
    await retire(admission.executorFence);
  } else {
    await withUpdateCommandExecutor(target.runId, async (executor) =>
      retire(await executor.enter(target.installRoot)),
    );
  }
}
