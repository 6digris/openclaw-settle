import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { tryReadJson } from "../../infra/json-files.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import type { UpdateCandidateRehearsal } from "../../infra/update-candidate-rehearsal.js";
import {
  readUpdateStateSchemaVersions,
  resolveUpdateStateContentVersion,
} from "../../infra/update-candidate-state.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import {
  createUpdateDoctorConfigWarningStep,
  type UpdateDoctorConfigChange,
} from "../../infra/update-doctor-config.js";
import { resolveUpdateFinalizationTimeoutMs } from "../../infra/update-finalization-budget.js";
import {
  canResolveRegistryVersionForPackageTarget,
  verifyPackageUpdateRecovery,
} from "../../infra/update-global.js";
import {
  isCurrentForegroundUpdateHandoffProcess,
  parkForegroundUpdateHandoff,
} from "../../infra/update-managed-service-handoff.js";
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
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
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
import { runUpdateCommandRepair } from "./update-command-repair.js";
import {
  createUpdateCommandFailureResult,
  type MutableUpdateExecutionResult,
} from "./update-command-result.js";
import { isUpdatedInstallGatewayExecutorSupported } from "./update-command-service-command.js";
import {
  resolveUpdatedInstallCommandEnv,
  withOwnedManagedUpdateEnv,
} from "./update-command-service-env.js";
import {
  collectServiceInspectionFailureFacts,
  GatewayServiceUpdateOwnershipError,
  resolvePackageRuntimePreflight,
} from "./update-command-service-plan.js";
import {
  maybeStopManagedServiceBeforeMutableUpdate,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type PreManagedServiceStop,
} from "./update-command-service.js";
import {
  recordPreviousGatewayVerification,
  verifyPreviousGatewayForUpdate,
} from "./update-command-verification.js";

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
  type ProfileValidation = {
    root: string;
    doctorConfigWrites: boolean;
    doctorConfigChanges: UpdateDoctorConfigChange[];
    validatedConfig?: {
      config: UpdateCandidateRehearsal["sourceConfig"];
      hash: UpdateCandidateRehearsal["sourceConfigHash"];
    };
    observedGatewayStartupMs?: number;
    profileContexts: boolean;
    gatewayRestartCompletion: boolean;
    generation: number;
  };
  const profileValidation = new Map<UpdateProfileContext, ProfileValidation>();
  const envFor = (profile: UpdateProfileContext) =>
    profile.ownedManagedUpdateEnv ?? opts.run?.env ?? process.env;
  const nodeFor = (profile: UpdateProfileContext) =>
    profile.packageUpdateNodeRunner ?? params.packageUpdateNodeRunner;
  let admission: Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>> | undefined;
  let gitContextPrepared = false;
  let admittedTargetSchemaVersions = params.packageTargetSchemaVersions;
  let recoveryEnv: NodeJS.ProcessEnv | undefined;
  let packageTransaction: PackageUpdateTransaction | undefined;
  let candidateSchemaVersions: OpenClawSchemaVersions | undefined;
  let previousSchemaVersions: OpenClawSchemaVersions | undefined;
  let candidateFailureReason: string | undefined;
  let candidateGeneration = 0;
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
    admittedTargetSchemaVersions = versions;
  };
  const prepareProfiles = async () => {
    for (const profile of profiles) {
      profile.preUpdatePluginInstallRecords = await params.prepareMutableUpdate(envFor(profile));
      assertExecutionCurrent();
    }
  };
  const preflightPlugins = async (targetVersion: string | null, selected = profiles) => {
    await recheckSchemas(admittedTargetSchemaVersions);
    const { preflightConfiguredNpmPluginTargets } =
      await import("./update-command-plugin-preflight.js");
    assertExecutionCurrent();
    for (const profile of selected) {
      const warnings = await preflightConfiguredNpmPluginTargets({
        config: profile.configSnapshot.sourceConfig,
        env: envFor(profile),
        targetVersion,
        channel: params.channel,
        timeoutMs: updateStepTimeoutMs,
      });
      assertExecutionCurrent();
      for (const warning of warnings) {
        defaultRuntime[opts.json ? "error" : "log"](warning.message);
      }
    }
    await recheckSchemas(admittedTargetSchemaVersions);
  };
  const runDoctor = async (root: string): Promise<UpdateStepResult | null> => {
    const steps: UpdateStepResult[] = [];
    for (const profile of profiles) {
      const validation = profileValidation.get(profile)!;
      assertExecutionCurrent();
      const step = await runPackageUpdateDoctor({
        root,
        managedServiceEnv: envFor(profile),
        timeoutMs: updateStepTimeoutMs,
        invocationCwd: params.invocationCwd,
        nodeRunner: nodeFor(profile),
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
        const root = profileValidation.get(profile)!.root;
        if (
          profile === profiles[0] &&
          !profile.preManagedServiceStop &&
          opts.run?.completionOwner === "gateway-restart" &&
          (await isCurrentForegroundUpdateHandoffProcess({
            root,
            runId: opts.run.runId,
            env: envFor(profile),
          }))
        ) {
          assertExecutionCurrent();
          continue;
        }
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
            env: envFor(profile),
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
                nodeRunner: currentCoreResult ? nodeFor(profile) : params.packageUpdateNodeRunner,
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
  let mutationStarted = false;
  const prepareProfileRuntime = async (
    profile: UpdateProfileContext,
    root: string,
    assertCurrent?: () => void,
  ) => {
    const before = profile.preManagedServiceStop;
    const runtime = await withOwnedManagedUpdateEnv(envFor(profile), () =>
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
  const validateProfile = async (
    profile: UpdateProfileContext,
    root: string,
    allowRepair: boolean,
  ) => {
    const state = profileValidation.get(profile)!;
    assertExecutionCurrent();
    const env = envFor(profile);
    if (opts.run) {
      recordUpdateRunPhase(opts.run.runId, "validating", undefined, { env: opts.run.env });
    }
    const validate = async (
      signal?: AbortSignal,
      rehearsal?: UpdateCandidateRehearsal,
      assertCurrent?: () => void,
    ) => {
      signal?.throwIfAborted();
      try {
        await prepareProfileRuntime(profile, root, assertCurrent);
        if (params.updateInstallKind === "package") {
          // The staged manifest owns schema support, including artifacts without registry metadata.
          await recheckSchemas(
            parsePackageOpenClawSchemaVersions(
              await tryReadJson<unknown>(path.join(root, "package.json")),
            ) ?? admittedTargetSchemaVersions,
          );
          signal?.throwIfAborted();
          assertCurrent?.();
        }
      } catch (error) {
        if (error instanceof UpdatePreMutationError) {
          candidateFailureReason = error.reason;
        }
        throw error;
      }
      if (
        params.shouldRestart &&
        opts.run &&
        profile.preManagedServiceStop?.serviceUpdateVerdict?.kind === "owned"
      ) {
        const executor = opts.run.executorFence;
        if (!executor) {
          throw new UpdatePreMutationError(
            "target-native-unsupported",
            "Native candidate admission requires its original update executor.",
          );
        }
        const supported = await isUpdatedInstallGatewayExecutorSupported({
          root,
          env: resolveUpdatedInstallCommandEnv({
            processEnv: env,
            invocationCwd: params.invocationCwd,
          }),
          executor,
          timeoutMs: updateStepTimeoutMs,
          nodeRunner: nodeFor(profile),
          signal,
        });
        assertExecutionCurrent();
        if (!supported) {
          candidateFailureReason = "target-native-unsupported";
          throw new UpdatePreMutationError(
            candidateFailureReason,
            "Target runtime cannot fence update-owned native commands; refusing before Gateway stop or package activation.",
          );
        }
      }
      const snapshot = rehearsal
        ? { config: rehearsal.sourceConfig, hash: rehearsal.sourceConfigHash }
        : (state.validatedConfig ??
          (await readUpdateCandidateSource(env, params.legacyConfigPlan)));
      const validation = await validateUpdateCandidateCanary({
        root,
        config: snapshot.config,
        stateDir: resolveStateDir(env),
        env,
        signal,
        rehearsal,
        assertCurrent: () => {
          assertExecutionCurrent();
          assertCurrent?.();
        },
        nodeRunner: nodeFor(profile),
        timeoutMs: params.timeoutMs,
        onStep: (step) => params.progress?.onStepComplete?.({ ...step, index: 0, total: 0 }),
      });
      assertExecutionCurrent();
      state.doctorConfigChanges.push(...(validation.doctorConfigChanges ?? []));
      if (validation.status === "ok") {
        state.validatedConfig = snapshot;
        candidateSchemaVersions = validation.candidateSchemaVersions;
        state.profileContexts = validation.profileContexts;
        state.gatewayRestartCompletion = validation.gatewayRestartCompletion;
        state.generation = candidateGeneration;
        state.doctorConfigWrites = validation.doctorConfigWrites === true;
        state.observedGatewayStartupMs = validation.steps.find(
          (step) => step.name === "candidate gateway canary" && step.exitCode === 0,
        )?.durationMs;
      }
      return validation;
    };
    let validation = await validate();
    if (validation.status === "error") {
      candidateFailureReason = validation.reason;
      if (!allowRepair) {
        return validation.steps;
      }
      candidateGeneration += 1;
      const repair = await runUpdateCommandRepair({
        root: params.root,
        candidateRoot: root,
        env,
        run: opts.run,
        phase: "validating",
        nodeRunner: nodeFor(profile),
        result: {
          status: "error",
          mode,
          root,
          reason: validation.reason,
          before: { version: await readPackageVersion(params.root) },
          after: { version: await readPackageVersion(root) },
          steps: validation.steps,
          durationMs: validation.durationMs,
        },
        validate: async (signal, assertCurrent, rehearsal) => {
          const repairValidation = await validate(signal, rehearsal, assertCurrent);
          return {
            ok: repairValidation.status === "ok",
            score: repairValidation.steps.filter((step) => step.exitCode === 0).length,
            summary:
              repairValidation.status === "ok"
                ? "Candidate validation passed."
                : repairValidation.logTail.join("\n"),
          };
        },
      });
      if (repair.status !== "repaired") {
        if (repair.reason === "requester-revoked") {
          candidateFailureReason = repair.reason;
        }
        return validation.steps;
      }
      candidateFailureReason = undefined;
      // Repair's disposable state is gone; only surviving candidate changes may authorize activation.
      validation = await validate();
      candidateFailureReason = validation.status === "error" ? validation.reason : undefined;
    }
    if (
      validation.status === "ok" &&
      !state.doctorConfigWrites &&
      state.doctorConfigChanges.length
    ) {
      const warning = createUpdateDoctorConfigWarningStep(root, state.doctorConfigChanges);
      validation.steps.push(warning);
      params.progress?.onStepComplete?.({ ...warning, index: 0, total: 0 });
    }
    return validation.steps;
  };
  const validateCandidate = async (root: string) => {
    try {
      if (stagedPluginAdmission) {
        await recheckSchemas(
          parsePackageOpenClawSchemaVersions(
            await tryReadJson<unknown>(path.join(root, "package.json")),
          ) ?? admittedTargetSchemaVersions,
        );
        await preflightPlugins(await readPackageVersion(root));
        await prepareProfiles();
      }
    } catch (error) {
      if (error instanceof UpdatePreMutationError) {
        candidateFailureReason = error.reason;
      }
      throw error;
    }
    const steps: UpdateStepResult[] = [];
    const appendValidation = async (profile: UpdateProfileContext, allowRepair: boolean) => {
      const validated = await validateProfile(profile, root, allowRepair);
      steps.push(...validated);
      return (
        !candidateFailureReason && validated.every((step) => step.exitCode === 0 || step.advisory)
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
        profileValidation.get(profile)!.generation !== candidateGeneration &&
        !(await appendValidation(profile, false))
      ) {
        return steps;
      }
    }
    return steps;
  };
  const captureProfileSchemas = async (profile: UpdateProfileContext) => {
    const state = profileValidation.get(profile)!;
    const env = envFor(profile);
    profile.schemaVersions = candidateSchemaVersions
      ? await readUpdateStateSchemaVersions({
          stateDir: resolveStateDir(env),
          config: state.validatedConfig?.config ?? profile.configSnapshot.config,
          env,
          timeoutMs: updateStepTimeoutMs,
          nodeRunner: nodeFor(profile),
        })
      : undefined;
    assertExecutionCurrent();
    const candidate = candidateSchemaVersions;
    const missingCompletionOwner =
      opts.run?.completionOwner === "gateway-restart" && !state.gatewayRestartCompletion;
    if (candidate && ((profiles.length > 1 && !state.profileContexts) || missingCompletionOwner)) {
      const sharedPath = resolveOpenClawStateSqlitePath(env);
      const schemaTransition = profile.schemaVersions?.some((entry) => {
        const version = resolveUpdateStateContentVersion(entry);
        return (
          version !== null && version !== candidate[entry.path === sharedPath ? "state" : "agent"]
        );
      });
      if (schemaTransition) {
        throw new UpdatePreMutationError(
          "target-native-unsupported",
          missingCompletionOwner
            ? "Target runtime cannot preserve the foreground Gateway's completion owner after state migration; refusing activation."
            : "Target runtime cannot finalize migrated state for every profile sharing this installation; refusing activation.",
        );
      }
    }
  };
  const beforeActivate = async () => {
    assertExecutionCurrent();
    await recheckSchemas(admittedTargetSchemaVersions);
    previousSchemaVersions = parsePackageOpenClawSchemaVersions(
      await tryReadJson<unknown>(path.join(params.root, "package.json")),
    );
    assertExecutionCurrent();
    let activationTimeoutMs = 0;
    for (const profile of profiles) {
      const state = profileValidation.get(profile)!;
      const env = envFor(profile);
      const snapshot = await readUpdateCandidateSource(env, params.legacyConfigPlan);
      assertExecutionCurrent();
      if (
        state.validatedConfig?.hash !== undefined &&
        snapshot.hash !== state.validatedConfig.hash
      ) {
        throw new UpdatePreMutationError(
          "invalid-config",
          "Config changed during candidate validation; rerun the update before activating.",
        );
      }
      await captureProfileSchemas(profile);
      profile.previousVerified = false;
      if (
        profile.preManagedServiceStop?.running &&
        profile.preManagedServiceStop.serviceUpdateVerdict?.kind === "owned"
      ) {
        profile.previousVerified = await verifyPreviousGatewayForUpdate({
          root: state.root,
          config: snapshot.config,
          env,
          opts,
          timeoutMs: params.timeoutMs,
          observedStartupMs: state.observedGatewayStartupMs,
          assertCurrent: assertExecutionCurrent,
        });
        assertExecutionCurrent();
        if (profile === profiles[0]) {
          recordPreviousGatewayVerification(opts.run, profile.previousVerified);
        }
      }
      activationTimeoutMs += await resolveUpdateFinalizationTimeoutMs(updateStepTimeoutMs, {
        env,
        databases: profile.schemaVersions,
        observedStartupMs: state.observedGatewayStartupMs,
        pluginCount: Object.keys(snapshot.config.plugins?.entries ?? {}).length,
        nodeRunner: nodeFor(profile),
      });
      assertExecutionCurrent();
    }
    // Candidate and readiness work can outlive any inspected service/config generation.
    await recheckSchemas(admittedTargetSchemaVersions);
    assertExecutionCurrent();
    if (opts.run?.completionOwner === "gateway-restart") {
      await parkForegroundUpdateHandoff({ root: params.root, run: opts.run });
      assertExecutionCurrent();
    }
    await params.prepareMutableUpdate(envFor(profiles[0]!), activationTimeoutMs);
    assertExecutionCurrent();
    if (opts.run) {
      recordUpdateRunPhase(opts.run.runId, "activating", undefined, { env: opts.run.env });
    }
    await stopManagedServices("prepare");
    await recheckSchemas(admittedTargetSchemaVersions);
    for (const profile of profiles) {
      await captureProfileSchemas(profile);
    }
    assertExecutionCurrent();
    for (const profile of profiles) {
      profile.preManagedServiceStop?.windowsTaskAutoStartRecovery?.beginMutation();
    }
    mutationStarted = true;
    params.onActivation?.();
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
    const env = envFor(origin);
    await prepareProfileRuntime(origin, current.root ?? params.root);
    await preflightPlugins(currentCoreResult.after!.version ?? null, [origin]);
    await stopManagedServices("inspect", [origin]);
    const budget = (
      await Promise.all(
        profiles.map((profile) =>
          resolveUpdateFinalizationTimeoutMs(updateStepTimeoutMs, {
            env: envFor(profile),
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
        profileValidation.set(profiles[index]!, {
          root,
          doctorConfigWrites: false,
          doctorConfigChanges: [],
          profileContexts: false,
          gatewayRestartCompletion: false,
          generation: -1,
        }),
      );
      params.recoveryState.triageTarget.env = envFor(profiles[0]!);
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
        beforeActivate,
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
        getManagedServiceEnvs: () => profiles.map(envFor),
        getSnapshotSource: async () => {
          const env = envFor(profiles[0]!);
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
              failed.stderrTail ?? "Candidate validation failed.",
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
          admittedTargetSchemaVersions = target.schemaVersions;
          await beforeActivate();
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

  if (candidateFailureReason && result.status === "error") {
    result.reason = candidateFailureReason;
  }
  return {
    ...(currentCoreResult ? { coreAlreadyCurrent: true } : {}),
    result,
    failure,
    mutationStarted,
    profiles,
    recoveryEnv,
    packageTransaction,
    candidateSchemaVersions,
    previousSchemaVersions,
  };
}
