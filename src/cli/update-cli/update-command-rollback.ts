import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV } from "../../config/future-version-guard.js";
import {
  hashConfigRaw,
  normalizeConfigIoDeps,
  resolveConfigForRead,
  resolveConfigIncludesForRead,
} from "../../config/io.read-helpers.js";
import { withConfigMutationLock } from "../../config/mutate.js";
import { resolveStateDir } from "../../config/paths.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import { replaceFileAtomic } from "../../infra/replace-file.js";
import {
  readUpdateStateSchemaVersions,
  resolveUpdateStateContentVersion,
  updateStateSchemaVersionsMatch,
} from "../../infra/update-candidate-state.js";
import { NativePackageRollbackError } from "../../infra/update-native-package-stage.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { retainUpdateProfileVerification } from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import { readUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import type { UpdateProfileContext } from "./update-command-finish-types.js";
import { readPackageUpdateIdentity } from "./update-command-package.js";
import { assertUpdateProfileRecoveryAdmission } from "./update-command-recovery.js";
import { runUpdatedInstallGatewayCommand } from "./update-command-service-command.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import {
  createWindowsTaskAutoStartGuard,
  revalidateManagedGatewayServiceAfterUpdate,
} from "./update-command-service-maintenance.js";
import { assertGatewayServiceManagementAllowedForUpdate } from "./update-command-service-plan.js";
import {
  maybeRestartService,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  resolveUpdatedGatewayRestartPort,
  type PreManagedServiceStop,
} from "./update-command-service.js";

/** Restores the previous generation only while schemas and activation-owned config stay intact. */
export async function rollbackFailedUpdate(params: {
  result: UpdateRunResult;
  previousRoot: string;
  packageTransaction?: PackageUpdateTransaction;
  rollbackBlockedReason?: "state-migrated-no-rollback" | "rollback-state-unverified";
  candidateSchemaVersions?: OpenClawSchemaVersions;
  previousSchemaVersions?: OpenClawSchemaVersions;
  profiles: UpdateProfileContext[];
  opts: UpdateCommandOptions;
  timeoutMs: number;
  nodeRunner?: string;
  invocationCwd?: string;
}): Promise<{
  result: UpdateRunResult;
  rolledBack: boolean;
  verifiedAtMs?: number;
  pendingRecoveryReason?: string;
}> {
  const { packageTransaction, opts } = params;
  const invocationEnv = { ...process.env };
  const profiles = params.profiles.map((profile) => {
    const before = profile.preManagedServiceStop;
    const env =
      before?.serviceEnv ?? profile.ownedManagedUpdateEnv ?? opts.run?.env ?? invocationEnv;
    return {
      profile,
      before,
      env,
      recoveryEnv: { ...env, [ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV]: "1" },
      config:
        profile.configSnapshot.sourceConfigBeforeMigrations ?? profile.configSnapshot.sourceConfig,
      configSnapshot: profile.activationConfig ?? {
        path: profile.configSnapshot.path,
        raw: profile.configSnapshot.raw,
        hash: hashConfigRaw(profile.configSnapshot.raw),
      },
      port: undefined as number | undefined,
    };
  });
  type Profile = (typeof profiles)[number];
  const run = opts.run;
  const executor = run?.executorFence;
  const assertCurrent = () => {
    if (opts.run !== run || run?.executorFence !== executor) {
      throw new Error("Package rollback lost its original executor.");
    }
    executor?.assertCurrent();
  };
  let result = params.result;
  const pendingRecovery = (reason: string) => ({
    result: {
      ...result,
      status: "error" as const,
      recovery: {
        serviceRestartSafe: false as const,
        reason: "runtime-verification-failed" as const,
      },
    },
    rolledBack: false,
    pendingRecoveryReason: reason,
  });
  try {
    assertCurrent();
    // A lost live context (including the same run ID) is not permission to
    // fall back to legacy rollback, even when publication removed the main DB.
    await assertUpdateProfileRecoveryAdmission(
      [...profiles.map(({ env }) => env), ...(opts.run ? [opts.run.env] : [])],
      assertCurrent,
    );
  } catch (error) {
    return pendingRecovery(formatErrorMessage(error));
  }
  const failed = (reason: string) => ({
    result: {
      ...result,
      status: "error" as const,
      reason:
        result.recovery?.serviceRestartSafe === true && result.recovery.packageRollbackVerified
          ? (params.result.reason ?? reason)
          : reason,
    },
    rolledBack: false,
  });
  const stateUnchanged = async (entry: Profile) => {
    const { profile, config, env } = entry;
    assertCurrent();
    const baseline = profile.schemaVersions;
    const current = await readUpdateStateSchemaVersions({
      stateDir: resolveStateDir(env),
      config,
      env,
      root: result.root ?? null,
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
    for (const store of current) {
      const version = resolveUpdateStateContentVersion(store);
      if (version === null || baselineVersions.get(store.path) != null) {
        continue;
      }
      // First-use creation is not migration, but the retained runtime must still
      // support that new store before replacing a reachable candidate.
      const kind = store.path === sharedPath ? "state" : "agent";
      const supported = params.previousSchemaVersions?.[kind];
      if (supported === undefined || version > supported) {
        throw new Error(
          `Automatic rollback refused: newly created ${kind} database ${store.path} uses schema ${version}; retained previous package support is ${supported ?? "unknown"}. Keep the candidate installed.`,
        );
      }
    }
    await assertConfigUnchanged(entry);
    assertCurrent();
    return true;
  };
  let failureReason = "rollback-state-unverified";
  const assertConfigUnchanged = async ({ profile, configSnapshot, config, env }: Profile) => {
    assertCurrent();
    let unchanged =
      profile.activationConfig?.doctorOwned !== false &&
      (await readUpdateConfigSnapshot(configSnapshot.path)).hash === configSnapshot.hash;
    if (unchanged && profile.configSnapshot.includedPaths?.length) {
      // Only the root file is restored. Resolve its captured include graph so
      // edits to separate config files cannot escape the original state guard.
      const deps = normalizeConfigIoDeps({ env: { ...env } });
      const included = resolveConfigIncludesForRead(
        profile.configSnapshot.parsed,
        profile.configSnapshot.path,
        deps,
      );
      unchanged = isDeepStrictEqual(
        config,
        resolveConfigForRead(included, deps.env).resolvedConfigRaw,
      );
    }
    assertCurrent();
    if (!unchanged) {
      failureReason = "state-migrated-no-rollback";
      const detail = `Configuration ${configSnapshot.path} or its included files changed after activation; automatic rollback was refused to preserve those edits.`;
      result = {
        ...result,
        steps: [
          ...result.steps,
          {
            name: "config rollback",
            command: "restore pre-update config",
            cwd: params.previousRoot,
            durationMs: 0,
            exitCode: 1,
            stderrTail: detail,
          },
        ],
      };
      throw new Error(detail);
    }
  };
  const stop = async ({ profile, before, recoveryEnv }: Profile) => {
    assertCurrent();
    failureReason = "service-revalidation-failed";
    // The parent binary can be older than the candidate's stamp even before bytes are restored.
    // This existing recovery allowance belongs only to this guarded stop invocation.
    const retainStopped = (stopped: PreManagedServiceStop) => {
      if (stopped.serviceEnv) {
        stopped.serviceEnv = { ...stopped.serviceEnv };
        delete stopped.serviceEnv[ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS_ENV];
      }
      // Reinspection of an already disabled task creates no new suspension owner.
      stopped.windowsTaskAutoStartRecovery ??=
        profile.preManagedServiceStop?.windowsTaskAutoStartRecovery ??
        before?.windowsTaskAutoStartRecovery;
      profile.preManagedServiceStop = stopped;
    };
    const stopped = await withOwnedManagedUpdateEnv(recoveryEnv, () =>
      maybeStopManagedServiceBeforeMutableUpdate({
        updateRun: opts.run,
        updateInstallKind: "package",
        root: result.root ?? params.previousRoot,
        shouldRestart: true,
        jsonMode: opts.json === true,
        expectedService: profile.preManagedServiceStop ?? before,
        allowInstallRootChange: packageTransaction !== undefined,
        timeoutMs: params.timeoutMs,
        assertCurrent,
        onStopped: retainStopped,
      }),
    );
    retainStopped(stopped);
    assertCurrent();
    if (
      stopped.blockMessage ||
      stopped.serviceMutationAllowed === false ||
      (stopped.running && !stopped.stopped)
    ) {
      throw new Error(stopped.blockMessage ?? "Candidate service could not be stopped safely.");
    }
    return stopped;
  };
  try {
    assertCurrent();
    for (const profile of profiles) {
      if (profile.before?.stopped) {
        profile.port = await resolveUpdatedGatewayRestartPort({
          config: profile.config,
          serviceEnv: profile.env,
        });
        assertCurrent();
      }
    }
    if (params.rollbackBlockedReason) {
      return failed(params.rollbackBlockedReason);
    }
    if (!profiles.length || profiles.some(({ profile }) => !profile.schemaVersions)) {
      return failed("rollback-state-unverified");
    }
    for (const profile of profiles) {
      if (!(await stateUnchanged(profile))) {
        return failed("state-migrated-no-rollback");
      }
    }
    if (!packageTransaction) {
      failureReason = "source-rollback-failed";
      throw new Error("The retained package transaction is unavailable.");
    }
    await packageTransaction.assertRollbackSafe?.();
    assertCurrent();
    for (const profile of profiles) {
      if (profile.before?.stopped) {
        await stop(profile);
      }
    }
    const restore = async () => {
      // Recheck after stop so a final startup migration cannot race the first read.
      failureReason = "rollback-state-unverified";
      for (const profile of profiles) {
        if (!(await stateUnchanged(profile))) {
          return failed("state-migrated-no-rollback");
        }
      }
      failureReason = "source-rollback-failed";
      assertCurrent();
      const { activePackageRoot, ...restored } = await packageTransaction.rollback(assertCurrent);
      // Restoration changes the active runtime before any later reporting or
      // restart can fail. Carry that identity through every recovery outcome.
      result = {
        ...result,
        root: activePackageRoot ?? undefined,
        after: undefined,
        steps: [...result.steps, restored],
      };
      assertCurrent();
      if (restored.exitCode === 0) {
        // The transaction verified the previous package. Do not gate its restart
        // on an extra diagnostic read whose result would be discarded.
        result.after = result.before;
        result.recovery = {
          serviceRestartSafe: false,
          packageRollbackVerified: true,
          reason: "runtime-verification-failed",
        };
      } else if (activePackageRoot) {
        result.after = await readPackageUpdateIdentity(activePackageRoot);
        assertCurrent();
      }
      if (opts.run) {
        recordUpdateRunStep(
          opts.run.runId,
          {
            step: "package rollback",
            status: restored.exitCode === 0 ? "completed" : "failed",
            endedAtMs: Date.now(),
            ...(restored.reason ? { detail: restored.stderrTail ?? restored.reason } : {}),
          },
          { env: opts.run.env },
        );
      }
      if (restored.exitCode !== 0) {
        return failed(restored.reason ?? "source-rollback-failed");
      }
      failureReason = "rollback-state-unverified";
      for (const profile of profiles) {
        await assertConfigUnchanged(profile);
      }
      const restoredConfigs = new Set<string>();
      for (const profile of profiles) {
        const { configSnapshot } = profile;
        const configPath = path.resolve(configSnapshot.path);
        if (restoredConfigs.has(configPath)) {
          continue;
        }
        restoredConfigs.add(configPath);
        if (configSnapshot.hash === hashConfigRaw(configSnapshot.raw)) {
          continue;
        }
        if (configSnapshot.raw === null) {
          await assertConfigUnchanged(profile);
          await fs.rm(configSnapshot.path, { force: true });
        } else {
          await replaceFileAtomic({
            filePath: configSnapshot.path,
            content: configSnapshot.raw,
            mode: 0o600,
            preserveExistingMode: false,
            beforeRename: () => assertConfigUnchanged(profile),
          });
        }
      }
      assertCurrent();
      return undefined;
    };
    // Unchanged config needs only the legacy read checks, including read-only
    // installs. Doctor-owned replacement must exclude config writers before
    // package rollback and retain that owner until config restoration settles.
    const configLocks = [
      ...new Map(
        profiles
          .filter(({ configSnapshot }) => configSnapshot.hash !== hashConfigRaw(configSnapshot.raw))
          .map((profile) => [path.resolve(profile.configSnapshot.path), profile] as const),
      ),
    ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const withLocks = async (index: number): ReturnType<typeof restore> => {
      const lock = configLocks[index];
      return lock
        ? await withOwnedManagedUpdateEnv(lock[1].env, () =>
            withConfigMutationLock({ lockPath: lock[0], assertCurrent }, () =>
              withLocks(index + 1),
            ),
          )
        : await withOwnedManagedUpdateEnv(invocationEnv, restore);
    };
    const refused = await withLocks(0);
    assertCurrent();
    if (refused) {
      return refused;
    }
    // A no-service or --no-restart update owns file restoration only. Preserve
    // its original failure without claiming or changing a Gateway generation.
    // The origin owns the shared run's scalar health observation.
    const restartProfiles = [...profiles.slice(1), ...profiles.slice(0, 1)].filter(
      ({ before, port }) => before?.stopped && port !== undefined,
    );
    if (!restartProfiles.length) {
      return { result, rolledBack: false };
    }
    const previousVersion = result.before?.version;
    const previousBuildId = result.before?.buildId;
    if (!previousVersion) {
      return failed("previous-version-unverified");
    }
    let verifiedAtMs: number | undefined;
    let healthy = true;
    let restartSafe = true;
    let recoveryFailureReason: string | undefined;
    const recoveryErrors: unknown[] = [];
    for (const { profile, before, env, recoveryEnv, port } of restartProfiles) {
      const stopped = profile.preManagedServiceStop;
      if (!stopped || port === undefined || !profile.previousVerified) {
        healthy = restartSafe = false;
        recoveryFailureReason ??= "previous-version-unverified";
        continue;
      }
      let authorized = false;
      try {
        await withOwnedManagedUpdateEnv(recoveryEnv, async () => {
          failureReason = "service-revalidation-failed";
          await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
            stopped,
            true,
            createWindowsTaskAutoStartGuard({
              root: params.previousRoot,
              before: stopped,
              timeoutMs: params.timeoutMs,
            }),
            assertCurrent,
          );
          assertCurrent();
          // Prior verification covers this executable too; candidate Node cannot
          // stand in for the previously serving runtime during recovery.
          let verdict = stopped.serviceUpdateVerdict ?? before?.serviceUpdateVerdict;
          const nodeRunner = before?.serviceNodeRunner ?? params.nodeRunner;
          if (verdict?.kind === "owned" && verdict.refreshDefinition) {
            await runUpdatedInstallGatewayCommand(
              {
                result,
                opts,
                invocationEnv: env,
                serviceInstallEnv: before?.serviceDefinitionEnv,
                nodeRunner,
                timeoutMs: params.timeoutMs,
                invocationCwd: params.invocationCwd,
                assertCurrent,
              },
              "install",
            );
            const state = await readGatewayServiceState(resolveGatewayService(), {
              env: recoveryEnv,
              requireEffective: true,
              requireLoadedCommand: true,
              validateEnvBeforeStatusRead: assertGatewayServiceManagementAllowedForUpdate,
              timeoutMs: params.timeoutMs,
            });
            assertCurrent();
            verdict = await revalidateManagedGatewayServiceAfterUpdate({
              state,
              root: params.previousRoot,
              preManagedServiceStop: stopped,
            });
          }
          assertCurrent();
          const recovery: UpdateRunResult["recovery"] = {
            serviceRestartSafe: true,
            packageRollbackVerified: true,
            version: previousVersion,
            ...(previousBuildId ? { buildId: previousBuildId } : {}),
          };
          authorized = true;
          failureReason = "restart-unhealthy";
          const beforeVerification = [...result.steps];
          const restartOutcome = await maybeRestartService({
            shouldRestart: true,
            result: { ...result, recovery },
            opts,
            recordGatewayVerification: profile === params.profiles[0],
            refreshServiceEnv: false,
            serviceUpdateVerdict: verdict,
            serviceManagerUid: before?.serviceManagerUid,
            serviceEnv: recoveryEnv,
            serviceInstallEnv: before?.serviceDefinitionEnv,
            gatewayPort: port,
            requireRunningServiceAfterRestart: true,
            timeoutMs: params.timeoutMs,
            nodeRunner,
            invocationCwd: params.invocationCwd,
            onVerified: (at) => {
              verifiedAtMs = Math.max(verifiedAtMs ?? at, at);
            },
          });
          assertCurrent();
          if (profiles.length > 1) {
            retainUpdateProfileVerification(
              result,
              params.profiles.indexOf(profile) + 1,
              beforeVerification,
            );
          }
          healthy &&= restartOutcome === "ok";
        });
      } catch (error) {
        assertCurrent();
        healthy = false;
        restartSafe &&= authorized;
        recoveryFailureReason ??= failureReason;
        recoveryErrors.push(error);
      }
    }
    assertCurrent();
    if (restartSafe) {
      result.recovery = {
        serviceRestartSafe: true,
        packageRollbackVerified: true,
        version: previousVersion,
        ...(previousBuildId ? { buildId: previousBuildId } : {}),
        ...(healthy ? { service: "healthy" as const } : {}),
      };
    }
    if (opts.run) {
      recordUpdateRunStep(
        opts.run.runId,
        {
          step: "previous generation restoration",
          status: healthy ? "completed" : "failed",
          endedAtMs: Date.now(),
          ...(recoveryErrors.length
            ? { detail: recoveryErrors.map(formatErrorMessage).join("; ") }
            : {}),
        },
        { env: opts.run.env },
      );
    }
    if (!restartSafe || recoveryErrors.length) {
      return failed(recoveryFailureReason ?? failureReason);
    }
    return {
      result,
      rolledBack: healthy,
      ...(!healthy || verifiedAtMs === undefined ? {} : { verifiedAtMs }),
    };
  } catch (error) {
    const detail = formatErrorMessage(error);
    try {
      assertCurrent();
    } catch (cause) {
      return pendingRecovery(formatErrorMessage(cause));
    }
    if (error instanceof NativePackageRollbackError) {
      failureReason = error.reason;
    }
    assertCurrent();
    if (opts.run) {
      recordUpdateRunStep(
        opts.run.runId,
        {
          step: "package rollback",
          status: "failed",
          endedAtMs: Date.now(),
          detail,
        },
        { env: opts.run.env },
      );
    }
    return failed(failureReason);
  }
}
