import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import {
  persistUpdateRecoveryConfigWrites,
  withUpdateRecoveryConfigWrites,
} from "../../infra/update-recovery-config-writes.js";
import { recordUpdateRunDiagnostic } from "../../infra/update-run-ledger.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { createUpdateCommandBackup } from "./update-command-backup-lifecycle.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import {
  hasUnsettledUpdateProcesses,
  restoreUpdateRecoveryState,
} from "./update-command-rollback-state.js";

export type FinalizationRecovery = {
  backup?: UpdateRecoveryBackupRef;
  updateRecoveryOwner?: "unprotected";
  assertCurrent: () => void;
  beforeDoctor: () => Promise<void>;
  retainMaintenance?: (
    maintenance: NonNullable<Awaited<ReturnType<typeof beginDoctorMaintenance>>>,
  ) => void;
};

export async function withFinalizationRecovery<T>(
  root: string,
  run: { runId: string; env: NodeJS.ProcessEnv },
  operation: (recovery: FinalizationRecovery) => Promise<T>,
): Promise<T> {
  return await withUpdateCommandExecutor(run.runId, async (executor) => {
    const fence = await executor.enter(root);
    const backup = await createUpdateCommandBackup({
      opts: { run: { ...run, executorFence: fence } },
      root,
      env: process.env,
    });
    const authority = { assertOwned: () => fence.assertCurrent() };
    const guidance = `Update recovery capture retained at ${backup.manifestPath}. Inspect with openclaw update status --json; resolve with npx openclaw@latest doctor --fix.`;
    const report = () => {
      defaultRuntime.error(guidance);
      try {
        fence.assertCurrent();
        recordUpdateRunDiagnostic(run.runId, guidance, { env: run.env });
      } catch {
        // The retained capture and stderr remain inspectable if reporting fails.
      }
    };
    let maintenance: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
    try {
      const result = await withUpdateRecoveryConfigWrites(backup, authority, () =>
        withCommandProcessScope(() =>
          operation({
            backup,
            assertCurrent: authority.assertOwned,
            retainMaintenance: (owned) => {
              maintenance = owned;
            },
            beforeDoctor: async () => {
              await persistUpdateRecoveryConfigWrites(backup, authority);
              authority.assertOwned();
            },
          }),
        ),
      );
      if (maintenance) {
        const owned = maintenance;
        // Restore the service only after config receipts and child lifetimes have settled.
        maintenance = undefined;
        await withCommandProcessScope(async () =>
          owned.finish((await readConfigFileSnapshot({ skipPluginValidation: true })).config),
        );
      }
      // Finalization cannot establish post-update runtime health.
      report();
      return result;
    } catch (error) {
      report();
      if (hasUnsettledUpdateProcesses(error)) {
        throw error;
      }
      try {
        authority.assertOwned();
        const recoveryMaintenance =
          maintenance ??
          (await beginDoctorMaintenance({
            root: null,
            options: { repair: true },
            runtime: defaultRuntime,
          }));
        if (!recoveryMaintenance) {
          throw new Error("Update finalization could not enter offline recovery maintenance.", {
            cause: error,
          });
        }
        let recoveryFailure: unknown;
        try {
          await recoveryMaintenance.closeStores();
          const { warnings } = await restoreUpdateRecoveryState(backup, {
            assertOwned() {
              authority.assertOwned();
              recoveryMaintenance.assertCurrent();
            },
          });
          for (const warning of warnings) {
            defaultRuntime.error(`Warning: ${warning}`);
          }
          if (maintenance) {
            // Repair retained this service owner. Restore only after verified state recovery.
            maintenance = undefined;
            await withCommandProcessScope(async () =>
              recoveryMaintenance.finish(
                (await readConfigFileSnapshot({ skipPluginValidation: true })).config,
              ),
            );
          }
        } catch (cause) {
          recoveryFailure = cause;
          throw cause;
        } finally {
          if (!hasUnsettledUpdateProcesses(recoveryFailure)) {
            await withCommandProcessScope(() => recoveryMaintenance.release());
          }
        }
      } catch (cause) {
        throw new AggregateError(
          [error, cause],
          `Update finalization recovery failed. ${guidance}`,
          {
            cause,
          },
        );
      }
      throw error;
    }
  });
}
