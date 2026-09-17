import path from "node:path";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { tryReadJson } from "../../infra/json-files.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { resolveUpdateFinalizationTimeoutMs } from "../../infra/update-finalization-budget.js";
import {
  canResolveRegistryVersionForPackageTarget,
  verifyPackageUpdateRecovery,
} from "../../infra/update-global.js";
import { UpdateRequesterRevokedError } from "../../infra/update-requester-authority.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult, UpdateStepResult } from "../../infra/update-runner-types.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "../../state/openclaw-database-preflight.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../../state/openclaw-schema-versions.js";
import { formatCliCommand } from "../command-format.js";
import {
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import {
  normalizeTag,
  readPackageVersion,
  resolveGitInstallDir,
  UpdatePreMutationError,
} from "./shared.js";
import { UpdateCandidateValidation } from "./update-command-candidate-validation.js";
import { maybeRepairLegacyConfigForUpdateChannel } from "./update-command-config.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import type { UpdateProfileContext } from "./update-command-finish-types.js";
import { updateGitInstall } from "./update-command-git.js";
import {
  formatUpdateAncestryBlockMessage,
  handoffUpdateFromGateway,
} from "./update-command-handoff.js";
import {
  readUpdateCandidateSource,
  revalidateUpdateDatabaseContext,
} from "./update-command-managed-context.js";
import {
  runPackageInstallUpdate,
  preparePackageDoctorContext,
  runPackageUpdateDoctor,
  type PackageInstallUpdateParams,
} from "./update-command-package.js";
import { assertUpdateCommandRecovery } from "./update-command-recovery.js";
import {
  createUpdateCommandFailureResult,
  type MutableUpdateExecutionResult,
} from "./update-command-result.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type PreManagedServiceStop,
} from "./update-command-service-maintenance.js";
import {
  collectServiceInspectionFailureFacts,
  GatewayServiceUpdateOwnershipError,
  resolvePackageRuntimePreflight,
} from "./update-command-service-plan.js";

export async function executeMutableUpdate(
  params: MutableUpdateExecutionParams,
): Promise<MutableUpdateExecutionResult | null> {
  const { opts, updateStepTimeoutMs } = params;
  const originalRun = opts.run;
  const requesterAuthority = originalRun?.requesterAuthority;
  const assertRequesterCurrent = () => {
    if (opts.run !== originalRun || requesterAuthority?.isCurrent() === false) {
      throw new UpdateRequesterRevokedError();
    }
  };
  const assertExecutionCurrent = () => {
    assertUpdateCommandRecovery(opts);
    assertRequesterCurrent();
  };
  const mode: UpdateRunResult["mode"] =
    params.updateInstallKind === "git"
      ? "git"
      : (params.packageInstallTarget?.manager ?? "unknown");
  assertUpdateCommandRecovery(opts);
  const stagedPluginAdmission =
    params.updateInstallKind === "package" &&
    !canResolveRegistryVersionForPackageTarget(params.packageInstallSpec ?? params.tag);
  const profiles: UpdateProfileContext[] = [params.initialProfile];
  params.recoveryState.profiles = profiles;
  let admission: Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>> | undefined;
  let gitContextPrepared = false;
  let recoveryEnv: NodeJS.ProcessEnv | undefined;
  let packageTransaction: PackageUpdateTransaction | undefined;
  const recheckSchemas = async (versions: OpenClawSchemaVersions | undefined) => {
    if (!admission) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        "Database admission was not inspected.",
      );
    }
    await inspectUpdateDatabaseContexts({
      roots: admission.roots,
      scope: admission.scope,
      updateInstallKind: params.updateInstallKind === "git" ? "git" : "package",
      shouldRestart: params.shouldRestart,
      jsonMode: Boolean(opts.json),
      timeoutMs: updateStepTimeoutMs,
      invocationCwd: params.invocationCwd,
      managedServiceRootRedirect: params.managedServiceRootRedirect,
      expectedProfiles: admission.profiles,
      legacyConfigPlan: params.legacyConfigPlan,
    });
    assertExecutionCurrent();
    admission.contexts = await Promise.all(admission.contexts.map(revalidateUpdateDatabaseContext));
    assertExecutionCurrent();
    const schemas = await checkTargetDatabaseSchemasForContexts(versions, admission.contexts);
    assertExecutionCurrent();
    if (hasSchemaRefusal(schemas)) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        formatSchemaRefusalLines(schemas).join("\n"),
      );
    }
    candidate.admittedSchemaVersions = versions;
  };
  const prepareProfiles = async () => {
    for (const profile of profiles) {
      profile.preUpdatePluginInstallRecords = await params.prepareMutableUpdate(
        candidate.envFor(profile),
      );
      assertExecutionCurrent();
    }
  };
  const preflightPlugins = async (targetVersion: string | null, selected = profiles) => {
    await recheckSchemas(candidate.admittedSchemaVersions);
    const { preflightConfiguredNpmPluginTargets } =
      await import("./update-command-plugin-preflight.js");
    assertExecutionCurrent();
    for (const profile of selected) {
      const warnings = await preflightConfiguredNpmPluginTargets({
        config: profile.configSnapshot.sourceConfig,
        env: candidate.envFor(profile),
        targetVersion,
        channel: params.channel,
        timeoutMs: updateStepTimeoutMs,
      });
      assertExecutionCurrent();
      for (const warning of warnings) {
        defaultRuntime[opts.json ? "error" : "log"](warning.message);
      }
    }
    await recheckSchemas(candidate.admittedSchemaVersions);
  };
  const runDoctor = async (root: string): Promise<UpdateStepResult | null> => {
    const steps: UpdateStepResult[] = [];
    for (const profile of profiles) {
      const validation = candidate.profileValidation.get(profile)!;
      assertExecutionCurrent();
      const step = await runPackageUpdateDoctor({
        root,
        managedServiceEnv: candidate.envFor(profile),
        timeoutMs: updateStepTimeoutMs,
        invocationCwd: params.invocationCwd,
        nodeRunner: candidate.nodeFor(profile),
        progress: params.progress,
        onConfigSnapshot: (snapshot) => {
          profile.activationConfig = snapshot;
        },
        getDoctorContext: () =>
          preparePackageDoctorContext({
            capable: validation.doctorConfigWrites,
            runId: originalRun?.runId,
            executorFence: originalRun?.executorFence,
            requester: requesterAuthority?.requester,
            inputHash: validation.validatedConfig?.hash,
            changes: validation.doctorConfigChanges,
            assertCurrent: assertExecutionCurrent,
            assertRequesterCurrent,
          }),
      });
      assertExecutionCurrent();
      if (!step) {
        return null;
      }
      steps.push(step);
      if (step.exitCode !== 0 && !step.advisory) {
        break;
      }
    }
    return steps.reduce<UpdateStepResult | null>(
      (combined, step) => ({
        ...(!combined || step.exitCode !== 0 || !combined.advisory ? step : combined),
        durationMs: (combined?.durationMs ?? 0) + step.durationMs,
        stdoutTail: [combined?.stdoutTail, step.stdoutTail].filter(Boolean).join("\n"),
        stderrTail: [combined?.stderrTail, step.stderrTail].filter(Boolean).join("\n"),
        failureFacts: [...(combined?.failureFacts ?? []), ...(step.failureFacts ?? [])],
      }),
      null,
    );
  };
  const originalRecovery = () =>
    params.installKind === "git"
      ? readCurrentGitUpdateRecovery(params.root, updateStepTimeoutMs)
      : verifyPackageUpdateRecovery(params.root);
  const gitMutationRoots =
    params.updateInstallKind === "git"
      ? params.switchToGit
        ? [params.root, resolveGitInstallDir()]
        : [params.root]
      : null;
  let currentCoreResult = params.alreadyCurrentResult;
  const stopManagedServices = async (phase: "inspect" | "prepare", selected = profiles) => {
    if (params.updateInstallKind !== "package" && params.updateInstallKind !== "git") {
      return;
    }
    try {
      for (const profile of selected) {
        if (!profile.preManagedServiceStop) {
          continue;
        }
        const root = candidate.profileValidation.get(profile)!.root;
        const rememberStopped = (state: PreManagedServiceStop) => {
          profile.preManagedServiceStop = {
            ...state,
            serviceEnv: profile.ownedManagedUpdateEnv ?? state.serviceEnv,
          };
          const recovery = state.windowsTaskAutoStartRecovery;
          if (recovery) {
            const recoveries = (params.recoveryState.windowsTaskAutoStartRecoveries ??= []);
            if (!recoveries.includes(recovery)) {
              recoveries.push(recovery);
            }
          }
        };
        assertExecutionCurrent();
        rememberStopped(
          await maybeStopManagedServiceBeforeMutableUpdate({
            updateInstallKind: params.updateInstallKind,
            root,
            env: candidate.envFor(profile),
            shouldRestart: params.shouldRestart,
            jsonMode: Boolean(opts.json),
            timeoutMs: updateStepTimeoutMs,
            phase,
            expectedService: profile.preManagedServiceStop,
            updateRun: opts.run,
            assertCurrent: assertExecutionCurrent,
            onStopped: rememberStopped,
            handoffFromGateway: (state) =>
              handoffUpdateFromGateway({
                state,
                root,
                opts,
                // Extended-stable resolves its protected selector again; its CLI forbids --tag.
                tag:
                  params.channel === "extended-stable"
                    ? undefined
                    : currentCoreResult
                      ? params.packageInstallSpec &&
                        !canResolveRegistryVersionForPackageTarget(params.packageInstallSpec)
                        ? params.packageInstallSpec
                        : (currentCoreResult.after?.version ?? undefined)
                      : params.updateInstallKind === "package"
                        ? (normalizeTag(params.packageInstallSpec) ?? undefined)
                        : undefined,
                mode,
                timeoutMs: updateStepTimeoutMs,
                devTarget: params.devTarget,
                nodeRunner: currentCoreResult
                  ? candidate.nodeFor(profile)
                  : params.packageUpdateNodeRunner,
                invocationCwd: params.invocationCwd,
                stopProgress: params.stop,
              }),
          }),
        );
        assertExecutionCurrent();
        const stopped = profile.preManagedServiceStop;
        const inspectionFailure = {
          failureFacts: collectServiceInspectionFailureFacts(stopped?.serviceUpdateVerdict),
        };
        if (shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop: stopped })) {
          throw new UpdatePreMutationError(
            "managed-service-preflight",
            [
              `${params.updateInstallKind === "git" ? "Git updates" : "Package updates"} cannot run from inside the gateway service process.`,
              "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
              `Run \`${formatCliCommand("openclaw update")}\` from a terminal outside the gateway service.`,
            ].join("\n"),
            inspectionFailure,
          );
        }
        if (stopped?.blockMessage) {
          throw new UpdatePreMutationError(
            "managed-service-preflight",
            formatUpdateAncestryBlockMessage(stopped.blockMessage),
            inspectionFailure,
          );
        }
      }
    } catch (err) {
      if (err instanceof ScheduledTaskAutoStartRecoveryError) {
        recoveryEnv = err.serviceEnv;
        params.recoveryState.triageTarget.env = err.serviceEnv;
        throw err;
      }
      if (
        err instanceof UpdateCommandAbort ||
        err instanceof UpdatePreMutationError ||
        err instanceof UpdateRequesterRevokedError
      ) {
        throw err;
      }
      if (err instanceof GatewayServiceUpdateOwnershipError) {
        throw new UpdatePreMutationError("managed-service-preflight", err.message, {
          failureFacts: err.failureFacts,
        });
      }
      params.stop();
      throw new UpdatePreMutationError(
        "managed-service-stop-failed",
        `Failed to stop managed gateway service before update: ${String(err)}`,
        { cause: err },
      );
    }
  };

  let result: UpdateRunResult;
  let failure: MutableUpdateExecutionResult["failure"];
  const prepareProfileRuntime = async (
    profile: UpdateProfileContext,
    root: string,
    assertCurrent?: () => void,
  ) => {
    const before = profile.preManagedServiceStop;
    const runtime = await withOwnedManagedUpdateEnv(candidate.envFor(profile), () =>
      resolvePackageRuntimePreflight({
        target: currentCoreResult ? params.packageRuntimeTarget : undefined,
        installedRoot: root,
        nodeRunner: before?.serviceNodeRunner ?? params.packageUpdateNodeRunner,
        shouldRestart: params.shouldRestart && before !== undefined,
        service: before,
        timeoutMs: updateStepTimeoutMs,
      }),
    );
    assertExecutionCurrent();
    assertCurrent?.();
    if (!runtime.ok) {
      throw new UpdatePreMutationError("node-runtime-preflight", runtime.error, {
        failureFacts: runtime.failureFacts,
      });
    }
    profile.packageUpdateNodeRunner = runtime.value.nodeRunner;
    profile.serviceRuntimeRefreshRequired = runtime.value.replacedNodeRunner !== undefined;
  };
  const candidate = new UpdateCandidateValidation(params, profiles, {
    mode,
    opts,
    updateStepTimeoutMs,
    assertCurrent: assertExecutionCurrent,
    recheckSchemas,
    prepareProfileRuntime,
    stopManagedServices,
  });
  const validateCandidate = async (root: string) => {
    try {
      if (stagedPluginAdmission) {
        await recheckSchemas(
          parsePackageOpenClawSchemaVersions(
            await tryReadJson<unknown>(path.join(root, "package.json")),
          ) ?? candidate.admittedSchemaVersions,
        );
        await preflightPlugins(await readPackageVersion(root));
        await prepareProfiles();
      }
    } catch (error) {
      if (error instanceof UpdatePreMutationError) {
        candidate.failureReason = error.reason;
      }
      throw error;
    }
    const steps: UpdateStepResult[] = [];
    const appendValidation = async (profile: UpdateProfileContext, allowRepair: boolean) => {
      const validated = await candidate.validateProfile(profile, root, allowRepair);
      steps.push(...validated);
      return (
        !candidate.failureReason && validated.every((step) => step.exitCode === 0 || step.advisory)
      );
    };
    for (const profile of profiles) {
      if (!(await appendValidation(profile, true))) {
        return steps;
      }
    }
    // A later repair can change shared candidate source. Rehearse earlier
    // profiles again without repair so every activation proof names that source.
    for (const profile of profiles) {
      if (
        candidate.profileValidation.get(profile)!.generation !== candidate.generation &&
        !(await appendValidation(profile, false))
      ) {
        return steps;
      }
    }
    return steps;
  };
  const prepareCurrentCore = async (current: UpdateRunResult): Promise<UpdateRunResult> => {
    currentCoreResult = {
      ...current,
      after: {
        ...(current.after ?? current.before),
        version:
          current.after?.version ??
          current.before?.version ??
          (await readPackageVersion(params.root)),
      },
    };
    const origin = profiles[0]!;
    const env = candidate.envFor(origin);
    await prepareProfileRuntime(origin, current.root ?? params.root);
    await preflightPlugins(currentCoreResult.after!.version ?? null, [origin]);
    await stopManagedServices("inspect", [origin]);
    const budget = (
      await Promise.all(
        profiles.map((profile) =>
          resolveUpdateFinalizationTimeoutMs(updateStepTimeoutMs, {
            env: candidate.envFor(profile),
            pluginCount: Object.keys(profile.configSnapshot.config.plugins?.entries ?? {}).length,
            nodeRunner:
              profile.packageUpdateNodeRunner ??
              profile.preManagedServiceStop?.serviceNodeRunner ??
              params.packageUpdateNodeRunner,
          }),
        ),
      )
    ).reduce((total, allowance) => total + allowance, 0);
    assertExecutionCurrent();
    origin.preUpdatePluginInstallRecords = await params.prepareMutableUpdate(env, budget, true);
    assertExecutionCurrent();
    const context = await revalidateUpdateDatabaseContext(admission!.profiles[0]!.context);
    assertExecutionCurrent();
    const before = context.configSnapshot;
    const plan =
      params.legacyConfigPlan?.snapshot.path === before.path ? params.legacyConfigPlan : undefined;
    origin.storedChannel = normalizeUpdateChannel((plan?.config ?? before.config).update?.channel);
    origin.configSnapshot =
      params.opts.channel && plan
        ? await withOwnedManagedUpdateEnv(env, () =>
            withPluginLifecycleLease({ assertCurrent: assertExecutionCurrent }, () =>
              maybeRepairLegacyConfigForUpdateChannel({
                configSnapshot: before,
                plan,
                jsonMode: Boolean(opts.json),
              }),
            ),
          )
        : before;
    assertExecutionCurrent();
    if (!origin.configSnapshot.valid) {
      throw new Error("Update refused: the selected configuration is still invalid.");
    }
    const changed = before.raw !== origin.configSnapshot.raw;
    if (changed) {
      origin.preUpdatePluginInstallRecords = await loadInstalledPluginIndexInstallRecords({ env });
      assertExecutionCurrent();
    }
    return {
      ...currentCoreResult,
      status: changed ? "ok" : "skipped",
      reason: changed ? undefined : "already-current",
    };
  };
  try {
    if (params.updateInstallKind === "package" || params.updateInstallKind === "git") {
      admission = await inspectUpdateDatabaseContexts({
        roots: gitMutationRoots ?? [params.root],
        scope:
          params.updateInstallKind === "package" &&
          params.packageAlreadyCurrent &&
          currentCoreResult &&
          !stagedPluginAdmission
            ? "profile-maintenance"
            : "installation",
        updateInstallKind: params.updateInstallKind,
        shouldRestart: params.shouldRestart,
        jsonMode: Boolean(opts.json),
        timeoutMs: updateStepTimeoutMs,
        invocationCwd: params.invocationCwd,
        managedServiceRootRedirect: params.managedServiceRootRedirect,
        legacyConfigPlan: params.legacyConfigPlan,
      });
      assertExecutionCurrent();
      profiles.splice(
        0,
        profiles.length,
        ...admission.profiles.map(({ stopState, context }, index) => ({
          configSnapshot: context.configSnapshot,
          preManagedServiceStop: stopState ? { ...stopState, serviceEnv: context.env } : undefined,
          ownedManagedUpdateEnv: context.env,
          requestedChannel: index === 0 ? params.initialProfile.requestedChannel : null,
          storedChannel: normalizeUpdateChannel(context.configSnapshot.config.update?.channel),
          preUpdatePluginInstallRecords: {},
        })),
      );
      admission.profiles.forEach(({ root }, index) =>
        candidate.profileValidation.set(profiles[index]!, {
          root,
          doctorConfigWrites: false,
          doctorConfigChanges: [],
          profileContexts: false,
          gatewayRestartCompletion: false,
          generation: -1,
        }),
      );
      params.recoveryState.triageTarget.env = candidate.envFor(profiles[0]!);
    }
    if (currentCoreResult) {
      result = await prepareCurrentCore(currentCoreResult);
    } else if (params.updateInstallKind === "package") {
      if (!stagedPluginAdmission) {
        await preflightPlugins(params.packageTargetVersion ?? null);
      }
      await stopManagedServices("inspect");
      if (!stagedPluginAdmission) {
        await prepareProfiles();
      }
      const packageUpdate: PackageInstallUpdateParams = {
        reapplyLocalOverrides: opts.reapplyLocalOverrides,
        root: params.root,
        installKind: params.installKind,
        tag: params.tag,
        installSpec: params.packageInstallSpec ?? undefined,
        timeoutMs: updateStepTimeoutMs,
        startedAt: params.startedAt,
        progress: params.progress,
        invocationCwd: params.invocationCwd,
        honorPackageRoot:
          params.managedServiceRootRedirect !== null ||
          params.managedServiceNodeRunner !== undefined,
        nodeRunner: params.packageUpdateNodeRunner,
        installEnv: params.packageInstallEnv,
        installTarget: params.packageInstallTarget,
        validateCandidate,
        beforeActivate: candidate.beforeActivate,
        assertCurrent: assertExecutionCurrent,
        managedServiceEnv: profiles[0]?.preManagedServiceStop?.serviceEnv,
        onTransaction: (transaction) => {
          packageTransaction = transaction;
        },
        runDoctor,
      };
      await recheckSchemas(params.packageTargetSchemaVersions);
      result = params.stagedPackage
        ? await params.stagedPackage.run(packageUpdate)
        : await runPackageInstallUpdate(packageUpdate);
    } else {
      result = await updateGitInstall({
        root: params.root,
        switchToGit: params.switchToGit,
        installKind: params.installKind,
        timeoutMs: params.timeoutMs,
        startedAt: params.startedAt,
        progress: params.progress,
        channel: params.channel,
        devTarget: params.devTarget,
        assertCurrent: assertExecutionCurrent,
        inspectGitTarget: async (target) => {
          assertExecutionCurrent();
          if (opts.run) {
            recordUpdateRunPhase(
              opts.run.runId,
              "staging",
              { target: { kind: "git", sha: target.sha, version: target.version } },
              { env: opts.run.env },
            );
          }
          if (target.metadataUnreadable) {
            throw new UpdatePreMutationError(
              "target-metadata-preflight",
              `Update refused: could not inspect the target's schema support (${target.metadataUnreadable}).`,
            );
          }
          await recheckSchemas(target.schemaVersions);
          if (!gitContextPrepared) {
            await stopManagedServices("inspect");
            await prepareProfiles();
            // Revalidation retains activation's stop and recovery state.
            gitContextPrepared = true;
          }
        },
        onTransaction: (transaction) => {
          packageTransaction = transaction;
        },
        runDoctor,
        getManagedServiceEnvs: () => profiles.map(candidate.envFor),
        getSnapshotSource: async () => {
          const env = candidate.envFor(profiles[0]!);
          const source = await readUpdateCandidateSource(env, params.legacyConfigPlan);
          return { config: source.config, env };
        },
        jsonMode: Boolean(opts.json),
        invocationCwd: params.invocationCwd,
        nodeRunner: params.packageUpdateNodeRunner,
        validateCandidate: async (candidateRoot) => {
          const steps = await validateCandidate(candidateRoot);
          const failed = steps.find((step) => step.exitCode !== 0 && !step.advisory);
          if (failed) {
            throw new UpdatePreMutationError(
              failed.name,
              failed.stderrTail ?? "Update checks failed.",
              { failureFacts: failed.failureFacts },
            );
          }
        },
        beforeGitMutation: async (target) => {
          if (target.metadataUnreadable) {
            throw new UpdatePreMutationError(
              "target-metadata-preflight",
              `Update refused: could not inspect the target's schema support (${target.metadataUnreadable}). Retry, or see ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
            );
          }
          candidate.admittedSchemaVersions = target.schemaVersions;
          await candidate.beforeActivate();
        },
      });
    }
    if (!currentCoreResult && result.status === "skipped" && result.reason === "already-current") {
      result = await prepareCurrentCore(result);
    }
  } catch (err) {
    params.stop();
    if (err instanceof UpdateCommandAbort) {
      return null;
    }
    const preMutationFailure = err instanceof UpdatePreMutationError;
    failure = { cause: err, detail: formatErrorMessage(err) };
    defaultRuntime.error(failure.detail);
    // Only explicit pre-mutation refusal permits original-runtime recovery.
    // Mutable exceptions retain an unsafe outcome through cleanup/reporting.
    result = createUpdateCommandFailureResult({
      durationMs: Date.now() - params.startedAt,
      mode,
      root: params.root,
      recovery: preMutationFailure
        ? await originalRecovery()
        : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      failure,
    });
  }

  if (candidate.failureReason && result.status === "error") {
    result.reason = candidate.failureReason;
  }
  return {
    ...(currentCoreResult ? { coreAlreadyCurrent: true } : {}),
    result,
    failure,
    mutationStarted: candidate.mutationStarted,
    profiles,
    recoveryEnv,
    packageTransaction,
    candidateSchemaVersions: candidate.schemaVersions,
    previousSchemaVersions: candidate.previousSchemaVersions,
  };
}
