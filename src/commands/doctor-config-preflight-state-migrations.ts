import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import { resolveStateDir } from "../config/paths.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { StartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationLogger,
  MigrationMessages,
  PreparedPostSessionPluginMigration,
} from "../infra/state-migrations.types.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { createDoctorPluginMigrationPreparation } from "./doctor-config-preflight-plugin-migrations.js";
import { assertDoctorPreflightMigrationsComplete } from "./doctor-config-preflight-startup.js";
import * as cronMigration from "./doctor-config-preflight.cron.js";
import { maybeRepairPluginOpenClawHostLinks } from "./doctor-plugin-host-links.js";
import type { CronCodexRuntimePolicyTarget } from "./doctor/cron/store-migration.js";
import type { planAutomaticConfigRepair } from "./doctor/shared/automatic-startup-config-repair.js";
import type { DoctorConfigPreflightOptions } from "./doctor/shared/config-migration-result.js";
import type { resolveStateMigrationConfigInput } from "./doctor/shared/legacy-config-state-migration-input.js";

const loadCronRepair = createLazyRuntimeModule(() => import("./doctor/cron/legacy-repair.js"));

/** Run admitted legacy owners before config repair removes their retired locators. */
export async function runDoctorLegacyStateMigrations(params: {
  stateDirMigrations: typeof import("../infra/state-migrations.state-dir.js");
  stateMigrationInput: ReturnType<typeof resolveStateMigrationConfigInput>;
  options: DoctorConfigPreflightOptions;
  skipPristineCoreStateMigrations: boolean;
  gatewayStartupCheckpointRequired: boolean;
  startupMigrationEnv: NodeJS.ProcessEnv;
  startupMigrationLease?: StartupMigrationLease;
  snapshot: ConfigFileSnapshot;
  automaticConfigRepair: ReturnType<typeof planAutomaticConfigRepair>;
  migrationLog?: MigrationLogger;
  measurePreflightStep: ConfigSnapshotReadMeasure;
  noteStartupStateMigrationResult: (result: MigrationMessages) => void;
  pluginMigrations: Pick<ReturnType<typeof createDoctorPluginMigrationPreparation>, "migrate">;
  pluginMetadata: { run: PluginMetadataSnapshotScopeRunner };
  cronCodexRuntimePolicyTargets: CronCodexRuntimePolicyTarget[];
  stateMigrationStepReceipts: LegacyStateMigrationStepReceipt[];
}) {
  const {
    stateDirMigrations,
    stateMigrationInput,
    options,
    skipPristineCoreStateMigrations,
    gatewayStartupCheckpointRequired,
    startupMigrationEnv,
    startupMigrationLease,
    snapshot,
    automaticConfigRepair,
    migrationLog,
    measurePreflightStep,
    noteStartupStateMigrationResult,
    pluginMigrations,
    pluginMetadata,
    cronCodexRuntimePolicyTargets,
    stateMigrationStepReceipts,
  } = params;
  let postSessionPluginMigration: PreparedPostSessionPluginMigration | undefined;
  let postSessionPluginMigrationPlanBound = false;
  let doctorMediaPersistenceAttempted = false;
  const pluginDoctorOnlyConfig =
    stateMigrationInput?.pluginDoctorConfig ?? stateMigrationInput?.cfg;
  const pluginDoctorOnly =
    skipPristineCoreStateMigrations &&
    pluginDoctorOnlyConfig &&
    !cronMigration.retainStoreConfig(pluginDoctorOnlyConfig);
  if (
    options.doctorOnlyStateMigrations === true &&
    (!stateMigrationInput?.cfg || pluginDoctorOnly)
  ) {
    const { detectLegacyExecApprovals, migrateLegacyExecApprovals } =
      await import("../infra/state-migrations.exec-approvals.js");
    const stateDir = resolveStateDir(process.env);
    // State-root policy can recover even when config cannot drive the general graph.
    // Otherwise that graph owns approvals ordering and must honor earlier refusals.
    noteStartupStateMigrationResult(
      await measurePreflightStep("exec-approvals-migration", () =>
        migrateLegacyExecApprovals({
          detected: detectLegacyExecApprovals({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
          env: process.env,
        }),
      ),
    );
  }
  if (gatewayStartupCheckpointRequired && (snapshot.valid || automaticConfigRepair)) {
    if (!startupMigrationLease) {
      throw new Error("Startup plugin host-link repair requires the startup migration lease.");
    }
    // Repair host links under the pinned lease before plugin migrations import packages.
    await measurePreflightStep("plugin-host-link-repair", () =>
      maybeRepairPluginOpenClawHostLinks({
        env: startupMigrationEnv,
        prompter: { shouldRepair: true },
      }),
    );
  }
  const { autoMigrateLegacyTaskStateSidecars } = stateDirMigrations;
  const migrateTaskStateSidecars = async () =>
    noteStartupStateMigrationResult(
      await measurePreflightStep("task-sidecar-migrations", () =>
        autoMigrateLegacyTaskStateSidecars({ env: process.env, log: migrationLog }),
      ),
    );
  if (stateMigrationInput) {
    // Retired cron.store selects a persisted SQLite partition. Preserve it in machine state
    // before config repair removes the only custom-partition evidence.
    if (pluginDoctorOnly) {
      // Core state is absent, but plugin paths may own external migration state.
      // Keep their doctor owner active without loading channel/session detectors.
      await pluginMigrations.migrate(pluginDoctorOnlyConfig);
    } else if (stateMigrationInput.cfg) {
      const { autoMigrateLegacyState } = await import("../infra/state-migrations.doctor.js");
      const migrationConfig = stateMigrationInput.cfg;
      const pluginDoctorConfig = stateMigrationInput.pluginDoctorConfig;
      const { collectCronCodexRuntimePolicyTargetsReadOnly, repairLegacyCronStoreWithoutPrompt } =
        await measurePreflightStep("cron-repair-import", loadCronRepair);
      const cronResult = await measurePreflightStep("cron-repair", () =>
        repairLegacyCronStoreWithoutPrompt({
          cfg: cronMigration.withLegacyConfig(migrationConfig, pluginDoctorConfig),
          migrateCodexModelRefs: false,
        }),
      );
      noteStartupStateMigrationResult(cronResult);
      if (options.repairPrefixedConfig === true) {
        const cronCodexPlan = await measurePreflightStep("cron-policy-scan", () =>
          collectCronCodexRuntimePolicyTargetsReadOnly({ cfg: migrationConfig }),
        );
        cronCodexRuntimePolicyTargets.push(...cronCodexPlan.targets);
        noteStartupStateMigrationResult({ changes: [], warnings: cronCodexPlan.warnings });
      }
      const legacyStateResult = await measurePreflightStep("legacy-state-migrations", () =>
        pluginMetadata.run({ config: pluginDoctorConfig ?? migrationConfig }, () =>
          autoMigrateLegacyState({
            cfg: migrationConfig,
            ...(pluginDoctorConfig ? { pluginDoctorConfig } : {}),
            configIncludedPaths: snapshot.includedPaths ?? [],
            env: process.env,
            log: migrationLog,
            recoverCorruptTargetStore: options.recoverCorruptTargetStore,
            doctorOnlyStateMigrations: options.doctorOnlyStateMigrations,
            invocationPurpose: options.invocationPurpose,
            ...(options.agentDatabaseMigrationDiscovery
              ? { agentDatabaseMigrationDiscovery: options.agentDatabaseMigrationDiscovery }
              : {}),
            beforeWorkspaceStateMigration: options.beforeWorkspaceStateMigration,
            onStepReceipt: (receipt) => stateMigrationStepReceipts.push(receipt),
            ...(gatewayStartupCheckpointRequired ? { allowLegacyDeviceIdentityImport: true } : {}),
          }),
        ),
      );
      postSessionPluginMigration = legacyStateResult.postSessionPluginMigration;
      postSessionPluginMigrationPlanBound = options.doctorOnlyStateMigrations === true;
      doctorMediaPersistenceAttempted = options.doctorOnlyStateMigrations === true;
      noteStartupStateMigrationResult(legacyStateResult);
      if (options.doctorOnlyStateMigrations === true) {
        await assertDoctorPreflightMigrationsComplete({
          cfg: migrationConfig,
          stepReceipts: stateMigrationStepReceipts,
          report: noteStartupStateMigrationResult,
        });
      }
    } else if (stateMigrationInput.pluginDoctorConfig) {
      const pluginDoctorConfig = stateMigrationInput.pluginDoctorConfig;
      const cronMigrationConfig = cronMigration.retainStoreConfig(pluginDoctorConfig);
      if (cronMigrationConfig) {
        // A partially valid config cannot drive general core migrations, but its retired
        // cron.store is still the sole authority for selecting and preserving that partition.
        const { repairLegacyCronStoreWithoutPrompt } = await measurePreflightStep(
          "cron-repair-import",
          loadCronRepair,
        );
        noteStartupStateMigrationResult(
          await measurePreflightStep("cron-repair", () =>
            repairLegacyCronStoreWithoutPrompt({
              cfg: cronMigrationConfig,
              migrateCodexModelRefs: false,
            }),
          ),
        );
        const { migrateLegacyConfigMachineState } =
          await import("../infra/state-migrations.config-machine-state.js");
        noteStartupStateMigrationResult(
          migrateLegacyConfigMachineState({ config: pluginDoctorConfig, env: process.env }),
        );
      }
      await pluginMigrations.migrate(pluginDoctorConfig);
      await migrateTaskStateSidecars();
    }
  } else {
    await migrateTaskStateSidecars();
  }
  return {
    postSessionPluginMigration,
    postSessionPluginMigrationPlanBound,
    doctorMediaPersistenceAttempted,
  };
}
