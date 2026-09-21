import { isDeepStrictEqual } from "node:util";
import {
  normalizeConfigIoDeps,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
} from "../../config/io.read-helpers.js";
import { resolveStateDir } from "../../config/paths.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PackageIntegrityFingerprint } from "../../infra/package-update-integrity.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import {
  readUpdateStateSchemaVersions,
  resolveUpdateStateContentVersion,
  updateStateSchemaVersionsMatch,
  type UpdateStateSchemaVersion,
} from "../../infra/update-candidate-state.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import { writeUpdateRecoveryBackupOutcome } from "../../infra/update-recovery-backup.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  readUpdateConfigSnapshot,
  type UpdateConfigSnapshot,
} from "./update-command-config-snapshot.js";
import type {
  UpdateServiceDefinitionRecovery,
  OriginalManagedServiceRuntime,
} from "./update-command-service-context-types.js";
import type { PreManagedServiceStop } from "./update-command-service.js";

export type RollbackFailedUpdateParams = {
  result: UpdateRunResult;
  previousRoot: string;
  packageTransaction?: PackageUpdateTransaction;
  unchangedCore?: { root: string; fingerprint: PackageIntegrityFingerprint };
  allowGatewayRestart?: boolean;
  updateRecoveryBackup?: UpdateRecoveryBackupRef;
  rollbackBlockedReason?: "state-migrated-no-rollback" | "rollback-state-unverified";
  schemaVersions?: UpdateStateSchemaVersion[];
  candidateSchemaVersions?: OpenClawSchemaVersions;
  previousSchemaVersions?: OpenClawSchemaVersions;
  previousVerified?: boolean;
  originalManagedServiceRuntime?: OriginalManagedServiceRuntime;
  configSnapshot: ConfigFileSnapshot;
  activationConfig?: UpdateConfigSnapshot;
  opts: UpdateCommandOptions;
  preManagedServiceStop?: PreManagedServiceStop;
  timeoutMs: number;
  nodeRunner?: string;
  invocationCwd?: string;
  definitionRecovery: UpdateServiceDefinitionRecovery;
};

export async function reportFailedUpdateRollback(
  params: RollbackFailedUpdateParams,
  context: {
    result: UpdateRunResult;
    stateRestored: boolean;
    stoppedForRollback?: PreManagedServiceStop;
    before?: PreManagedServiceStop;
    run: UpdateCommandOptions["run"];
    env: NodeJS.ProcessEnv;
    recoveryAdmitted: boolean;
    assertCurrent: () => void;
    assertAdmission: (env: NodeJS.ProcessEnv) => Promise<void>;
  },
  reason: string,
  detail = reason,
) {
  const {
    result,
    stateRestored,
    stoppedForRollback,
    before,
    run,
    env,
    recoveryAdmitted,
    assertCurrent,
    assertAdmission,
  } = context;

  const failure: UpdateRunResult = {
    ...result,
    status: "error",
    rollbackOutcome: result.rollbackOutcome ?? { status: "not-attempted", reason },
    reason:
      result.recovery?.serviceRestartSafe === true && result.recovery.packageRollbackVerified
        ? (params.result.reason ?? reason)
        : reason,
  };
  if (!params.updateRecoveryBackup || stateRestored) {
    return { result: failure, rolledBack: false, stoppedForRollback, stateRestored };
  }
  let recoveryDetail = `${detail} Retained update-recovery set: ${params.updateRecoveryBackup.manifestPath}. Keep the Gateway stopped and run \`npx openclaw@latest doctor --fix\`.`;
  const taskRecovery = (stoppedForRollback ?? before)?.windowsTaskAutoStartRecovery;
  if (recoveryAdmitted && taskRecovery) {
    try {
      // Settle only this live rollback's suspension, never a refused or replayed recovery.
      assertCurrent();
      await assertAdmission(env);
      if (run && resolveOpenClawStateSqlitePath(run.env) !== resolveOpenClawStateSqlitePath(env)) {
        await assertAdmission(run.env);
      }
      assertCurrent();
      await taskRecovery.complete(false);
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      recoveryDetail += ` Windows task autostart settlement failed: ${formatErrorMessage(error)}.`;
    }
  }
  try {
    assertCurrent();
    // Until state is restored, the backup outcome is the safe durable report;
    // the previous runtime cannot write a forward-migrated run ledger.
    await writeUpdateRecoveryBackupOutcome(
      params.updateRecoveryBackup,
      { status: "restore-failed", error: recoveryDetail },
      { assertOwned: assertCurrent },
    );
  } catch (error) {
    recoveryDetail += ` Backup failure outcome could not be recorded: ${formatErrorMessage(error)}.`;
  }
  failure.recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
  failure.steps = [
    ...failure.steps,
    {
      name: "state rollback",
      command: "npx openclaw@latest doctor --fix",
      cwd: params.previousRoot,
      durationMs: 0,
      exitCode: 1,
      stderrTail: recoveryDetail,
    },
  ];
  return {
    result: failure,
    rolledBack: false,
    stoppedForRollback,
    stateRestored: false,
    pendingRecoveryReason: recoveryDetail,
  };
}

export async function isRollbackStateUnchanged(
  params: RollbackFailedUpdateParams,
  context: {
    env: NodeJS.ProcessEnv;
    config: ConfigFileSnapshot["sourceConfig"];
    root: string | null;
    assertCurrent: () => void;
    assertConfigUnchanged: () => Promise<void>;
  },
): Promise<boolean> {
  const { env, config, assertCurrent, assertConfigUnchanged } = context;

  assertCurrent();
  const baseline = params.schemaVersions;
  const current = await readUpdateStateSchemaVersions({
    stateDir: resolveStateDir(env),
    config,
    env,
    root: context.root,
    nodeRunner: params.nodeRunner,
    timeoutMs: params.timeoutMs,
  });
  assertCurrent();
  const sharedPath = resolveOpenClawStateSqlitePath(env);
  if (
    baseline === undefined ||
    !updateStateSchemaVersionsMatch(baseline, current, {
      sharedPath,
      candidateSchemaVersions: params.candidateSchemaVersions,
    })
  ) {
    return false;
  }
  const baselineVersions = new Map(
    baseline.map((entry) => [entry.path, resolveUpdateStateContentVersion(entry)]),
  );
  for (const entry of current) {
    const version = resolveUpdateStateContentVersion(entry);
    if (version === null || baselineVersions.get(entry.path) != null) {
      continue;
    }
    // First-use creation is not migration, but the retained runtime must still
    // support that new store before replacing a reachable candidate.
    const kind = entry.path === sharedPath ? "state" : "agent";
    const supported = params.previousSchemaVersions?.[kind];
    if (supported === undefined || version > supported) {
      throw new Error(
        `Automatic rollback refused: newly created ${kind} database ${entry.path} uses schema ${version}; retained previous package support is ${supported ?? "unknown"}. Keep the update installed.`,
      );
    }
  }
  await assertConfigUnchanged();
  assertCurrent();
  return true;
}

export async function isRollbackConfigUnchanged(
  params: RollbackFailedUpdateParams,
  context: {
    env: NodeJS.ProcessEnv;
    config: ConfigFileSnapshot["sourceConfig"];
    configSnapshot: UpdateConfigSnapshot;
    assertCurrent: () => void;
  },
): Promise<boolean> {
  const { env, config, configSnapshot, assertCurrent } = context;
  let unchanged =
    params.activationConfig?.doctorOwned !== false &&
    (await readUpdateConfigSnapshot(configSnapshot.path)).hash === configSnapshot.hash;
  if (unchanged && params.configSnapshot.includedPaths?.length) {
    // Only the root file is restored. Resolve its captured include graph so
    // edits to separate config files cannot escape the original state guard.
    const deps = normalizeConfigIoDeps({ env: { ...env } });
    const included = resolveConfigIncludesForRead(
      params.configSnapshot.parsed,
      params.configSnapshot.path,
      deps,
    );
    unchanged = isDeepStrictEqual(
      config,
      resolveConfigForRead(included, deps.env).resolvedConfigRaw,
    );
  }
  assertCurrent();

  return unchanged;
}
