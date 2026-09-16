import type { TriageFailureContext } from "../../commands/triage-prompt.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
import {
  buildControlPlaneUpdateRestartHealthPendingResult,
  resolveManagedServiceUpdateFailureExitCode,
} from "../../infra/update-control-plane-sentinel.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { verifyPackageUpdateRecovery } from "../../infra/update-global.js";
import { parkForegroundUpdateHandoff } from "../../infra/update-managed-service-handoff.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import {
  normalizeControlPlaneUpdateResult,
  isUpdateGatewayReadinessPending,
  retainUpdateProfileVerification,
  getUpdateProfileVerification,
} from "../../infra/update-run-step.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import {
  classifyUpdateOutcome,
  UPDATE_ACTIVATION_TIMEOUT_REASON,
} from "../../shared/update-outcome.js";
import { inspectGatewayRestart } from "../daemon-cli/restart-health.js";
import { listenerOwnedByRuntimePid } from "../daemon-cli/restart-port-ownership.js";
import { UpdatePreMutationError } from "./shared.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import type { FinishUpdateParams, UpdateProfileContext } from "./update-command-finish-types.js";
import { retireStandaloneGitWrapper } from "./update-command-git.js";
import { appendPluginUpdateWarnings } from "./update-command-plugins-internals.js";
import {
  assertUpdateCommandPackageFinalization,
  createUpdateCommandFinalizationFence,
} from "./update-command-recovery.js";
import { repairUpdateService } from "./update-command-repair-service.js";
import { prepareUpdateRestart } from "./update-command-restart-context.js";
import {
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  UpdateCommandFailure,
  UpdateCommandPendingRecoveryFailure,
  resolveAutomaticUpdateTriage,
  recordUpdateResultNextAction,
  writeControlPlaneUpdateRestartSentinelBestEffort,
} from "./update-command-result.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import { UpdateServiceLoadBoundaryError } from "./update-command-service-load.js";
import { createWindowsTaskAutoStartGuard } from "./update-command-service-maintenance.js";
import {
  GatewayServiceUpdateOwnershipError,
  resolvePackageRuntimePreflight,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import {
  recordFailedUpdateGatewayState,
  maybeRestartService,
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  tryInstallShellCompletion,
} from "./update-command-service.js";
import {
  deferUpdateCommandTerminalResult,
  recordUpdatePackageCompletion,
  publishUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
} from "./update-command-terminal.js";
import { completeWindowsTaskAutoStartRecoveries } from "./update-command-windows-task.js";

export type { FinishUpdateParams } from "./update-command-finish-types.js";

export async function finishUpdate(params: FinishUpdateParams): Promise<UpdateRunResult> {
  if (params.serviceLoadBoundary && process.platform !== "linux") {
    throw new Error("Deferred native service loading is not supported on this platform.");
  }
  const assertCurrent = createUpdateCommandFinalizationFence(params);
  const parkForegroundOrigin = async () => {
    if (
      params.opts.run?.completionOwner === "gateway-restart" &&
      !params.opts.run.gatewayRestartRequired
    ) {
      await parkForegroundUpdateHandoff({ root: params.root, run: params.opts.run });
      assertCurrent();
    }
  };
  assertCurrent();
  await assertUpdateCommandPackageFinalization(params);
  assertCurrent();
  const origin = params.profiles[0];
  if (!origin) {
    throw new Error("Update finalization has no admitted profile.");
  }
  // The origin owns the scalar verification facts and restart notification.
  // Start it last so neither can report success before its siblings verify.
  const originWasStopped = origin.preManagedServiceStop?.running === false;
  const activationOrder = [...params.profiles.slice(1), origin];
  const nodeFor = (profile: UpdateProfileContext) =>
    profile.packageUpdateNodeRunner ??
    profile.preManagedServiceStop?.serviceNodeRunner ??
    params.packageUpdateNodeRunner;
  const originParams = () => ({ ...params, ...origin, packageUpdateNodeRunner: nodeFor(origin) });
  const sentinelOptions = {
    meta: params.controlPlaneUpdateSentinelMeta,
    jsonMode: Boolean(params.opts.json),
    env: params.opts.run?.env ?? origin.ownedManagedUpdateEnv,
  };
  const notifyOrigin = (result: UpdateRunResult) =>
    writeControlPlaneUpdateRestartSentinelBestEffort({ ...sentinelOptions, result });
  const markOriginFailure = (reason: string) =>
    markControlPlaneUpdateRestartSentinelFailureBestEffort({ ...sentinelOptions, reason });
  let gateway: TriageFailureContext["gateway"] = "preserve";
  let triageAllowed = true;
  const createFailure = (
    result: UpdateRunResult,
    exitCode = 1,
    detail?: string,
    options?: ErrorOptions,
  ) =>
    new UpdateCommandFailure(result, exitCode, detail, {
      ...options,
      automaticTriage: triageAllowed
        ? resolveAutomaticUpdateTriage(result, detail, { ...originParams(), gateway })
        : undefined,
    });
  let rollbackAttempted = false;
  let postVerificationRepairAttempted = false;
  const windowsPreservation = new Map<UpdateProfileContext, boolean>();
  const preserveProfileWindows = (profile: UpdateProfileContext, result: UpdateRunResult) => {
    const preserved = windowsPreservation.get(profile);
    if (preserved !== undefined) return preserved;
    if (params.profiles.length === 1) return isUpdateGatewayReadinessPending(result);
    const receipt = getUpdateProfileVerification(result, params.profiles.indexOf(profile) + 1);
    return (
      receipt?.exitCode === 0 &&
      (!rollbackAttempted || receipt.name.endsWith(": rollback gateway verification"))
    );
  };
  const resumeWindowsAutoStart = async (result: UpdateRunResult, onlyPreserved = false) => {
    for (const profile of params.profiles) {
      if (onlyPreserved && !preserveProfileWindows(profile, result)) continue;
      assertCurrent();
      const stopped = profile.preManagedServiceStop;
      await withOwnedManagedUpdateEnv(profile.ownedManagedUpdateEnv, () =>
        maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
          stopped,
          true,
          stopped
            ? createWindowsTaskAutoStartGuard({
                root: result.root ?? params.root,
                before: stopped,
                timeoutMs: params.updateStepTimeoutMs,
              })
            : undefined,
          assertCurrent,
        ),
      );
      assertCurrent();
    }
  };
  const completeWindowsAutoStart = async (
    success: boolean,
    result: UpdateRunResult = pendingResult,
  ) => {
    await completeWindowsTaskAutoStartRecoveries(
      params.profiles.map((profile) => profile.preManagedServiceStop?.windowsTaskAutoStartRecovery),
      (index) => success || preserveProfileWindows(params.profiles[index]!, result),
      assertCurrent,
    );
  };
  let rolledBack = false;
  let completedDowntimeMs: number | undefined = params.coreAlreadyCurrent ? 0 : undefined;
  let pendingRestartAtMs =
    origin.preManagedServiceStop?.stoppedAtMs ??
    params.controlPlaneUpdateSentinelMeta?.serviceStoppedAtMs;
  // Health resets replace ledger verification. Keep completed outages here
  // until final reporting, including a separately verified rollback.
  const recordVerifiedDowntime = (verifiedAtMs: number) => {
    if (pendingRestartAtMs !== undefined) {
      completedDowntimeMs =
        (completedDowntimeMs ?? 0) + Math.max(0, verifiedAtMs - pendingRestartAtMs);
      pendingRestartAtMs = undefined;
    }
  };
  // Finalization owns the complete outcome, including recovery, restart, and completion work.
  const completedResult = (result: UpdateRunResult): UpdateRunResult =>
    normalizeControlPlaneUpdateResult({
      ...result,
      ...(result.status === "error" &&
      result.reason !== UPDATE_ACTIVATION_TIMEOUT_REASON &&
      params.rollbackBlockedReason
        ? { reason: params.rollbackBlockedReason }
        : {}),
      durationMs: Math.max(0, Date.now() - params.startedAt),
    });
  const recordNextAction = (result: UpdateRunResult) => {
    assertCurrent();
    return recordUpdateResultNextAction(originParams(), result);
  };
  // Restart can let the new Gateway finish the row before CLI finalization resumes.
  // Store the next action before that handoff, and refresh it if recovery changes the outcome.
  recordNextAction(params.result);

  let pendingResult = params.result;
  let pendingNotify = true;
  const publishFinalResult = async (failure?: unknown): Promise<UpdateRunResult> => {
    const settled = await resolveSettledUpdateCommandResult(params, pendingResult, failure);
    const result = completedResult(settled.result);
    result.recovery = settled.settlementFailed ? undefined : result.recovery;
    const reportDowntime = !settled.settlementFailed && pendingRestartAtMs === undefined;
    if (pendingNotify) {
      await notifyOrigin(result);
    }
    return publishUpdateCommandTerminalResult(originParams(), result, {
      rolledBack: rolledBack && !settled.settlementFailed,
      downtimeMs: reportDowntime ? completedDowntimeMs : undefined,
    });
  };
  const deferredTerminal = deferUpdateCommandTerminalResult(params.opts.run, publishFinalResult);
  const recoverFailedResult = async (
    initialResult: UpdateRunResult,
    initialRecoverService: boolean,
    repair?: (result: UpdateRunResult) => Promise<UpdateRunResult>,
  ) => {
    assertCurrent();
    let result = initialResult;
    let recoverService = initialRecoverService;
    if (isUpdateGatewayReadinessPending(result)) {
      triageAllowed = false;
      return { result, recoverService: false };
    }
    if (
      result.status === "error" &&
      (params.packageTransaction || params.rollbackBlockedReason) &&
      !rollbackAttempted
    ) {
      rollbackAttempted = true;
      windowsPreservation.clear();
      const rollback = await rollbackFailedUpdate({
        result,
        previousRoot: params.root,
        packageTransaction: params.packageTransaction,
        rollbackBlockedReason: params.rollbackBlockedReason,
        candidateSchemaVersions: params.candidateSchemaVersions,
        previousSchemaVersions: params.previousSchemaVersions,
        profiles: params.profiles,
        opts: params.opts,
        timeoutMs: params.updateStepTimeoutMs,
        nodeRunner: params.packageUpdateNodeRunner,
        invocationCwd: params.invocationCwd,
      });
      assertCurrent();
      if (rollback.pendingRecoveryReason) {
        throw new UpdateCommandPendingRecoveryFailure(
          rollback.result,
          rollback.pendingRecoveryReason,
        );
      }
      result = rollback.result;
      rolledBack = rollback.rolledBack;
      pendingRestartAtMs ??= origin.preManagedServiceStop?.stoppedAtMs;
      if (rollback.verifiedAtMs !== undefined) {
        recordVerifiedDowntime(rollback.verifiedAtMs);
      }
      recoverService = false;
    }
    if (isUpdateGatewayReadinessPending(result)) {
      triageAllowed = false;
      return { result, recoverService: false };
    }
    if (
      result.status === "error" &&
      params.rollbackBlockedReason &&
      !postVerificationRepairAttempted
    ) {
      result = { ...result, reason: params.rollbackBlockedReason };
      recoverService = false;
    } else if (
      result.status === "error" &&
      params.result.status === "ok" &&
      !params.packageTransaction &&
      params.opts.run
    ) {
      recordUpdateRunStep(
        params.opts.run.runId,
        {
          step: "package rollback",
          status: "skipped",
          endedAtMs: Date.now(),
          detail:
            "No retained previous package transaction is available; automatic package restoration was not attempted.",
        },
        { env: params.opts.run.env },
      );
    }
    if (result.status === "error" && !rolledBack && repair) {
      postVerificationRepairAttempted = true;
      const previousRestored = result.recovery?.packageRollbackVerified === true;
      result = await repair(result);
      if (previousRestored && result.status === "ok") {
        // Restored bytes still failed the requested update; pending readiness is not verified rollback.
        rolledBack = !isUpdateGatewayReadinessPending(result);
        result = { ...result, status: "error", reason: initialResult.reason };
      }
      recoverService = false;
    }
    return { result, recoverService };
  };
  const reportResult = async (
    initialResult: UpdateRunResult,
    initialRecoverService = false,
    initialRestoreFailure?: { cause: unknown },
    notify = true,
  ): Promise<UpdateRunResult> => {
    assertCurrent();
    const { result, recoverService } = await recoverFailedResult(
      initialResult,
      initialRecoverService,
    );
    assertCurrent();
    let restoreFailure = initialRestoreFailure;
    const finalResult = completedResult({
      ...result,
      ...(result.status === "error" && !recoverService && !rolledBack
        ? {
            recovery:
              result.recovery?.serviceRestartSafe === false ||
              result.recovery?.packageRollbackVerified
                ? result.recovery
                : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
          }
        : {}),
    });
    pendingResult = finalResult;
    pendingNotify = notify;
    if (!restoreFailure) {
      try {
        if (
          !rolledBack &&
          ((finalResult.status === "error" && !recoverService) ||
            (finalResult.status !== "ok" &&
              !isUpdateGatewayReadinessPending(finalResult) &&
              finalResult.recovery?.serviceRestartSafe !== true))
        ) {
          await resumeWindowsAutoStart(finalResult, true);
          await completeWindowsAutoStart(false, finalResult);
        } else {
          await resumeWindowsAutoStart(finalResult);
        }
      } catch (cause) {
        restoreFailure = { cause };
      }
    }
    if (restoreFailure) {
      rolledBack = false;
      try {
        await completeWindowsAutoStart(false);
      } catch (cause) {
        restoreFailure = {
          cause: new AggregateError(
            [restoreFailure.cause, cause],
            `Windows task restoration and compensation failed: ${formatErrorMessage(restoreFailure.cause)}; ${formatErrorMessage(cause)}`,
          ),
        };
      }
      defaultRuntime.error(
        `Failed to restore Windows Scheduled Task autostart: ${String(restoreFailure.cause)}`,
      );
      finalResult.status = "error";
      finalResult.reason =
        result.status === "error" ? result.reason : "windows-task-autostart-restore-failed";
      finalResult.recovery = { serviceRestartSafe: false, reason: "runtime-verification-failed" };
      finalResult.steps = [
        ...finalResult.steps,
        {
          name: "Windows task autostart recovery",
          command: "openclaw update",
          cwd: finalResult.root ?? params.root,
          durationMs: 0,
          exitCode: 1,
          stderrTail: formatErrorMessage(restoreFailure.cause),
        },
      ];
    }
    assertCurrent();
    if (finalResult.status === "error" && !rolledBack && origin.preManagedServiceStop?.stopped) {
      await recordFailedUpdateGatewayState(
        params.opts.run,
        origin.preManagedServiceStop?.serviceEnv ?? process.env,
      );
    }
    recordNextAction(finalResult);
    if (notify && recoverService) {
      pendingNotify = false;
      await notifyOrigin(finalResult);
    }
    // The recovering Gateway reads this notification at startup. Persist once
    // before restarting; rewriting a consumed sentinel could deliver it twice.
    if (recoverService && finalResult.recovery?.serviceRestartSafe === true) {
      const recovery = finalResult.recovery;
      let restarted = false;
      let failed = false;
      for (const profile of activationOrder) {
        assertCurrent();
        const service = await withOwnedManagedUpdateEnv(profile.ownedManagedUpdateEnv, () =>
          maybeRestartServiceAfterFailedMutableUpdate({
            recovery,
            updateRun: params.opts.run,
            preManagedServiceStop: profile.preManagedServiceStop,
            jsonMode: Boolean(params.opts.json),
            nodeRunner: nodeFor(profile),
            timeoutMs: params.updateStepTimeoutMs,
            invocationCwd: params.invocationCwd,
          }),
        );
        assertCurrent();
        restarted ||= service !== undefined;
        failed ||= service === "failed";
        if (service !== undefined) {
          windowsPreservation.set(profile, service === "healthy");
        }
        if (service === "healthy" && params.shouldRestart && profile === origin) {
          gateway = "verify-running";
          recordVerifiedDowntime(Date.now());
        }
      }
      if (failed) {
        finalResult.status = "error";
        finalResult.recovery = { ...recovery, service: "failed" };
        try {
          await completeWindowsAutoStart(false);
        } catch (cause) {
          return await reportResult(finalResult, false, { cause }, false);
        }
      } else if (restarted) {
        finalResult.recovery = { ...recovery, service: "healthy" };
      }
    }
    await completeWindowsAutoStart(
      rolledBack ||
        (finalResult.status !== "error" && isUpdateGatewayReadinessPending(finalResult)) ||
        finalResult.status === "ok" ||
        (recoverService &&
          finalResult.recovery?.serviceRestartSafe === true &&
          finalResult.recovery.service === "healthy"),
      finalResult,
    );
    assertCurrent();
    if (originWasStopped && params.profiles.length > 1) {
      await recordFailedUpdateGatewayState(
        params.opts.run,
        origin.ownedManagedUpdateEnv ?? origin.preManagedServiceStop?.serviceEnv ?? process.env,
      );
      assertCurrent();
    }
    const cleanupFailure = await recordUpdatePackageCompletion(params, finalResult, assertCurrent);
    assertCurrent();
    pendingResult = completedResult(cleanupFailure?.result ?? finalResult);
    const reportedResult = deferredTerminal ? pendingResult : await publishFinalResult();
    if (cleanupFailure) {
      const { detail } = cleanupFailure;
      throw new UpdateCommandFailure(reportedResult, 1, detail, { cause: cleanupFailure });
    }
    if (restoreFailure) {
      // Persist the unsafe outcome before unwinding. Keep both failures for
      // recovery diagnostics, with the failed compensation as the primary cause.
      const priorDetail = [result.reason, params.failure?.detail].filter(Boolean).join(": ");
      const detail =
        `${priorDetail ? `${priorDetail}; ` : ""}Windows Scheduled Task autostart recovery failed: ` +
        formatErrorMessage(restoreFailure.cause);
      const cause = params.failure
        ? new AggregateError([params.failure.cause, restoreFailure.cause], detail, {
            cause: restoreFailure.cause,
          })
        : restoreFailure.cause;
      throw createFailure(
        reportedResult,
        resolveManagedServiceUpdateFailureExitCode(reportedResult),
        detail,
        { cause },
      );
    }
    return reportedResult;
  };
  const restoreWindowsAutoStart = async (result: UpdateRunResult) => {
    try {
      await resumeWindowsAutoStart(result);
    } catch (cause) {
      // The attempted restore already failed; reporting must not attempt it again.
      await reportResult(result, false, { cause });
    }
  };

  try {
    if (params.result.status === "error" || params.result.recovery?.serviceRestartSafe === false) {
      const reported = await reportResult(
        { ...params.result, status: "error" },
        params.result.recovery?.serviceRestartSafe === true,
      );
      throw createFailure(
        reported,
        resolveManagedServiceUpdateFailureExitCode(reported),
        params.failure?.detail,
        params.failure,
      );
    }

    if (params.result.status === "skipped" && !params.coreAlreadyCurrent) {
      const reported = await reportResult(
        params.result,
        params.result.recovery?.serviceRestartSafe === true,
      );
      throw createFailure(
        reported,
        classifyUpdateOutcome(reported) === "failed"
          ? resolveManagedServiceUpdateFailureExitCode(reported)
          : 0,
      );
    }

    const postUpdateRoot = params.result.root ?? params.root;
    let resultWithPostUpdate = params.result;
    const profiles: {
      profile: UpdateProfileContext;
      shouldRestart: boolean;
      snapshot?: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
    }[] = params.profiles.map((profile) => ({
      profile,
      shouldRestart:
        params.shouldRestart &&
        profile.preManagedServiceStop?.running !== false &&
        (!params.coreAlreadyCurrent ||
          (profile.preManagedServiceStop?.running === true &&
            profile.preManagedServiceStop.serviceUpdateVerdict?.kind === "owned")),
    }));
    const parkProfiles = async (selected: readonly (typeof profiles)[number][]) => {
      const parking = selected.filter(
        (entry) => entry.shouldRestart && !entry.profile.preManagedServiceStop?.stopped,
      );
      // Resolve every selected runner before taking any profile offline.
      for (const entry of parking) {
        const before = entry.profile.preManagedServiceStop;
        const runtime = await withOwnedManagedUpdateEnv(entry.profile.ownedManagedUpdateEnv, () =>
          resolvePackageRuntimePreflight({
            installedRoot: postUpdateRoot,
            nodeRunner: nodeFor(entry.profile),
            service: before,
            shouldRestart: true,
            timeoutMs: params.updateStepTimeoutMs,
          }),
        );
        assertCurrent();
        if (!runtime.ok) {
          throw new Error(runtime.error);
        }
        entry.profile.packageUpdateNodeRunner = runtime.value.nodeRunner;
        entry.profile.serviceRuntimeRefreshRequired =
          runtime.value.replacedNodeRunner !== undefined;
      }
      for (const entry of parking) {
        const before = entry.profile.preManagedServiceStop;
        if (!before) {
          throw new Error("Plugin maintenance lost its update service owner.");
        }
        await withOwnedManagedUpdateEnv(entry.profile.ownedManagedUpdateEnv, async () => {
          assertCurrent();
          await before.windowsTaskAutoStartRecovery?.complete(true);
          assertCurrent();
          const rememberStopped = (
            state: NonNullable<UpdateProfileContext["preManagedServiceStop"]>,
          ) => {
            entry.profile.preManagedServiceStop = {
              ...state,
              serviceEnv: entry.profile.ownedManagedUpdateEnv ?? state.serviceEnv,
            };
            if (entry.profile === origin) {
              pendingRestartAtMs ??= state.stoppedAtMs;
            }
          };
          const stopped = await maybeStopManagedServiceBeforeMutableUpdate({
            updateRun: params.opts.run,
            updateInstallKind: resultWithPostUpdate.mode === "git" ? "git" : "package",
            root: postUpdateRoot,
            shouldRestart: true,
            jsonMode: Boolean(params.opts.json),
            expectedService: before,
            phase: "prepare",
            timeoutMs: params.updateStepTimeoutMs,
            assertCurrent,
            onStopped: rememberStopped,
          });
          assertCurrent();
          rememberStopped(stopped);
          if (stopped.blockMessage || !stopped.stopped) {
            throw new Error(
              stopped.blockMessage ?? "Gateway could not be parked for plugin maintenance.",
            );
          }
          stopped.windowsTaskAutoStartRecovery?.beginMutation();
        }).catch((cause: unknown) => {
          if (cause instanceof UpdateCommandFailure || cause instanceof UpdatePreMutationError) {
            throw cause;
          }
          throw new UpdatePreMutationError(
            "managed-service-stop-failed",
            formatErrorMessage(cause),
            { cause },
          );
        });
      }
    };
    const parkForConvergence = async (selected: typeof profiles) => {
      await parkForegroundOrigin();
      await parkProfiles(selected);
    };
    const recordProfileStep = (profile: UpdateProfileContext, phase: string, success: boolean) => {
      assertCurrent();
      if (params.opts.run && params.profiles.length > 1) {
        recordUpdateRunStep(
          params.opts.run.runId,
          {
            step: `profile ${params.profiles.indexOf(profile) + 1}: ${phase}`,
            status: success ? "completed" : "failed",
            endedAtMs: Date.now(),
            detail: profile.configSnapshot.path,
          },
          { env: params.opts.run.env },
        );
      }
    };
    for (const entry of params.coreAlreadyCurrent ? profiles.slice(0, 1) : profiles) {
      const priorPlugins = resultWithPostUpdate.postUpdate?.plugins;
      const convergence = await convergeUpdatePlugins({
        ...params,
        ...entry.profile,
        packageUpdateNodeRunner: nodeFor(entry.profile),
        result: resultWithPostUpdate,
        beforeDoctor: params.coreAlreadyCurrent ? () => parkForConvergence([entry]) : undefined,
        beforeRuntimePublication: params.coreAlreadyCurrent
          ? () => parkForConvergence(profiles)
          : undefined,
        assertCurrent,
      });
      assertCurrent();
      resultWithPostUpdate = convergence.resultWithPostUpdate;
      const plugins = resultWithPostUpdate.postUpdate?.plugins;
      if (priorPlugins && plugins && priorPlugins !== plugins) {
        resultWithPostUpdate = appendPluginUpdateWarnings(
          {
            ...resultWithPostUpdate,
            postUpdate: {
              ...resultWithPostUpdate.postUpdate,
              plugins: {
                ...plugins,
                status:
                  plugins.status === "error" || plugins.status === "warning"
                    ? plugins.status
                    : priorPlugins.status === "warning"
                      ? "warning"
                      : plugins.status,
                changed: priorPlugins.changed || plugins.changed,
                failureFacts: [
                  ...(priorPlugins.failureFacts ?? []),
                  ...(plugins.failureFacts ?? []),
                ],
                sync: {
                  changed: priorPlugins.sync.changed || plugins.sync.changed,
                  switchedToBundled: [
                    ...priorPlugins.sync.switchedToBundled,
                    ...plugins.sync.switchedToBundled,
                  ],
                  switchedToNpm: [
                    ...priorPlugins.sync.switchedToNpm,
                    ...plugins.sync.switchedToNpm,
                  ],
                  warnings: [...priorPlugins.sync.warnings, ...plugins.sync.warnings],
                  errors: [...priorPlugins.sync.errors, ...plugins.sync.errors],
                },
                npm: {
                  changed: priorPlugins.npm.changed || plugins.npm.changed,
                  outcomes: [...priorPlugins.npm.outcomes, ...plugins.npm.outcomes],
                },
                integrityDrifts: [...priorPlugins.integrityDrifts, ...plugins.integrityDrifts],
              },
            },
          },
          priorPlugins.warnings ?? [],
        );
      }
      pendingResult = resultWithPostUpdate;
      entry.snapshot = convergence.postUpdateConfigSnapshot;
      recordProfileStep(entry.profile, "convergence", resultWithPostUpdate.status !== "error");
      if (resultWithPostUpdate.status === "error") {
        triageAllowed = !convergence.cancelled;
        const reported = await reportResult(resultWithPostUpdate);
        throw createFailure(
          reported,
          resolveManagedServiceUpdateFailureExitCode(reported),
          convergence.detail,
        );
      }
    }
    if (params.coreAlreadyCurrent && params.shouldRestart && profiles.length > 1) {
      const expectedVersion =
        resultWithPostUpdate.after?.version ?? (await readPackageVersion(postUpdateRoot));
      const expectedBuildId =
        resultWithPostUpdate.after?.buildId ?? (await readBuiltGatewayBuildId(postUpdateRoot));
      assertCurrent();
      const stale: typeof profiles = [];
      for (const entry of profiles.slice(1)) {
        if (!entry.shouldRestart || entry.profile.preManagedServiceStop?.stopped) {
          continue;
        }
        const env =
          entry.profile.ownedManagedUpdateEnv ??
          entry.profile.preManagedServiceStop?.serviceEnv ??
          params.opts.run?.env ??
          process.env;
        const port = await resolveUpdatedGatewayRestartPort({
          config: entry.profile.configSnapshot.config,
          serviceEnv: env,
        });
        assertCurrent();
        const health = await inspectGatewayRestart({
          service: resolveGatewayService(),
          port,
          env,
          expectedVersion,
          expectedBuildId,
          timeoutMs: params.updateStepTimeoutMs,
        }).catch(() => undefined);
        assertCurrent();
        const pid = health?.runtime.pid;
        // A failed probe or an absent build ID is not evidence of stale code.
        const mismatch =
          health?.versionMismatch?.actual?.trim() || health?.buildIdMismatch?.actual?.trim();
        if (
          health?.runtime.status === "running" &&
          pid !== undefined &&
          mismatch &&
          health.portUsage.listeners.some((listener) =>
            listenerOwnedByRuntimePid({ listener, runtimePid: pid }),
          )
        ) {
          stale.push(entry);
          recordProfileStep(entry.profile, "stale runtime observed", true);
        }
      }
      if (stale.length) {
        await parkProfiles(stale);
        resultWithPostUpdate = { ...resultWithPostUpdate, status: "ok", reason: undefined };
      }
    }
    const prepareProfileRestart = async (entry: (typeof profiles)[number]) => {
      try {
        return await withOwnedManagedUpdateEnv(entry.profile.ownedManagedUpdateEnv, async () => {
          const snapshot =
            entry.snapshot ??
            (await readConfigFileSnapshot({
              observe: false,
              skipPluginValidation: true,
              suppressFutureVersionWarning: true,
            }));
          assertCurrent();
          const restart = await prepareUpdateRestart(
            {
              ...params,
              ...entry.profile,
              shouldRestart: entry.shouldRestart,
              result: resultWithPostUpdate,
            },
            snapshot,
          );
          assertCurrent();
          if (params.coreAlreadyCurrent) {
            restart.restartScriptPath = null;
            if (!entry.profile.serviceRuntimeRefreshRequired) {
              restart.refreshGatewayServiceEnv = false;
            }
          }
          return restart;
        });
      } catch (error) {
        const message =
          error instanceof GatewayServiceUpdateOwnershipError
            ? error.message
            : formatErrorMessage(error);
        defaultRuntime.error(message);
        const reported = await reportResult({
          ...resultWithPostUpdate,
          status: "error",
          reason: "service-revalidation-failed",
          steps: [
            ...resultWithPostUpdate.steps,
            {
              name: "post-update verification",
              command: "openclaw update",
              cwd: postUpdateRoot,
              durationMs: 0,
              exitCode: 1,
              stderrTail: message,
            },
          ],
        });
        throw createFailure(
          reported,
          resolveManagedServiceUpdateFailureExitCode(reported),
          message,
          { cause: error },
        );
      }
    };
    const restarting: ((typeof profiles)[number] & {
      restart: Awaited<ReturnType<typeof prepareUpdateRestart>>;
    })[] = [];
    for (const entry of profiles.toSorted(
      (a, b) => Number(a.profile === origin) - Number(b.profile === origin),
    )) {
      if (!params.coreAlreadyCurrent || entry.profile.preManagedServiceStop?.stopped) {
        restarting.push({ ...entry, restart: await prepareProfileRestart(entry) });
      }
    }
    if (restarting.length) {
      await notifyOrigin(buildControlPlaneUpdateRestartHealthPendingResult(resultWithPostUpdate));
      await restoreWindowsAutoStart(resultWithPostUpdate);
    }
    const repairProfiles = async (initial: UpdateRunResult) => {
      let result = initial;
      for (const entry of restarting) {
        const context = entry.restart;
        if (!entry.shouldRestart) {
          continue;
        }
        if (!context.serviceMutationAllowed || context.skipLegacyServiceRestart) {
          return { ...result, status: "error" as const };
        }
        assertCurrent();
        const beforeVerification = [...result.steps];
        result = await withOwnedManagedUpdateEnv(entry.profile.ownedManagedUpdateEnv, () =>
          repairUpdateService({
            result: {
              ...result,
              status: "error",
              reason: initial.reason,
              recovery: initial.recovery,
            },
            root: postUpdateRoot,
            env:
              entry.profile.ownedManagedUpdateEnv ??
              params.opts.run?.env ??
              context.gatewayServiceEnv ??
              context.serviceStateReadEnv,
            opts: params.opts,
            recordGatewayVerification: entry.profile === origin,
            gatewayPort: context.gatewayPort,
            nodeRunner: nodeFor(entry.profile),
            timeoutMs: params.updateStepTimeoutMs,
            invocationCwd: params.invocationCwd,
            expectedService: entry.profile.preManagedServiceStop ?? {
              serviceManagerUid: context.serviceManagerUid,
              serviceEnv: context.gatewayServiceEnv ?? context.serviceStateReadEnv,
              serviceUpdateVerdict: context.serviceUpdateVerdict,
            },
            recoveryStop: entry.profile.preManagedServiceStop,
            onVerified: (atMs) => {
              windowsPreservation.set(entry.profile, true);
              if (entry.profile === origin) recordVerifiedDowntime(atMs);
            },
          }),
        );
        assertCurrent();
        if (params.profiles.length > 1) {
          retainUpdateProfileVerification(
            result,
            params.profiles.indexOf(entry.profile) + 1,
            beforeVerification,
          );
        }
        // Repair returns ok for verified health or a fresh readiness-pending observation.
        windowsPreservation.set(entry.profile, result.status === "ok");
        recordProfileStep(entry.profile, "repair", result.status === "ok");
        if (result.status !== "ok") {
          return result;
        }
      }
      return result;
    };
    for (const entry of restarting) {
      const context = entry.restart;
      let verificationFailure = "restart-unhealthy";
      assertCurrent();
      const beforeVerification = [...resultWithPostUpdate.steps];
      const restarted = await withOwnedManagedUpdateEnv(entry.profile.ownedManagedUpdateEnv, () =>
        maybeRestartService({
          shouldRestart: entry.shouldRestart && context.serviceMutationAllowed,
          result: resultWithPostUpdate,
          opts: params.opts,
          recordGatewayVerification: entry.profile === origin,
          refreshServiceEnv: context.refreshGatewayServiceEnv,
          serviceLoadBoundary: params.serviceLoadBoundary,
          serviceUpdateVerdict: context.serviceUpdateVerdict,
          serviceManagerUid: context.serviceManagerUid,
          serviceRuntimeRefreshRequired: entry.profile.serviceRuntimeRefreshRequired,
          serviceEnv: context.gatewayServiceEnv,
          serviceInstallEnv: context.gatewayServiceInstallEnv,
          gatewayPort: context.gatewayPort,
          restartScriptPath: context.restartScriptPath,
          invocationCwd: params.invocationCwd,
          nodeRunner: nodeFor(entry.profile),
          skipLegacyServiceRestart: context.skipLegacyServiceRestart,
          requireRunningServiceAfterRestart: entry.profile.preManagedServiceStop?.stopped === true,
          serviceMutationSkipMessage: context.serviceMutationSkipMessage,
          timeoutMs: params.updateStepTimeoutMs,
          onVerificationFailure: (reason) => {
            verificationFailure = reason;
          },
          onPluginWarnings: (warnings) => {
            resultWithPostUpdate = appendPluginUpdateWarnings(resultWithPostUpdate, warnings);
          },
          onVerified: (atMs) => {
            windowsPreservation.set(entry.profile, true);
            if (entry.profile === origin) recordVerifiedDowntime(atMs);
          },
        }),
      );
      assertCurrent();
      if (params.profiles.length > 1) {
        retainUpdateProfileVerification(
          resultWithPostUpdate,
          params.profiles.indexOf(entry.profile) + 1,
          beforeVerification,
        );
      }
      if (restarted === "readiness-pending") windowsPreservation.set(entry.profile, true);
      else if (restarted !== "ok") {
        windowsPreservation.set(entry.profile, false);
      }
      pendingResult = resultWithPostUpdate;
      recordProfileStep(
        entry.profile,
        restarted === "readiness-pending" ? "readiness pending" : "verification",
        restarted === "ok" || restarted === "readiness-pending",
      );
      if (restarted === "ok" || restarted === "readiness-pending") {
        continue;
      }
      triageAllowed = context.serviceMutationAllowed;
      if (
        restarted === "restart-health-failed" &&
        entry.shouldRestart &&
        context.serviceMutationAllowed &&
        !context.skipLegacyServiceRestart &&
        entry.profile === origin
      ) {
        gateway = "verify-running";
      }
      const recovered = await recoverFailedResult(
        {
          ...resultWithPostUpdate,
          status: "error",
          reason: verificationFailure,
          recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        },
        false,
        verificationFailure !== "service-runtime-refresh-failed" &&
          context.serviceMutationAllowed &&
          !context.skipLegacyServiceRestart &&
          !postVerificationRepairAttempted
          ? repairProfiles
          : undefined,
      );
      if (recovered.result.status === "ok") {
        resultWithPostUpdate = recovered.result;
        break;
      }
      // The origin may have consumed its sentinel. Change only its receipt.
      await markOriginFailure(recovered.result.reason ?? verificationFailure);
      const reported = await reportResult(recovered.result, false, undefined, false);
      throw createFailure(reported, resolveManagedServiceUpdateFailureExitCode(reported));
    }
    if (params.coreAlreadyCurrent) {
      return await reportResult(resultWithPostUpdate);
    }
    // Restart and health verification own recovery of the service stopped for this update.
    // Optional completion refresh must run only after that lifecycle boundary settles.
    await tryInstallShellCompletion({
      root: postUpdateRoot,
      jsonMode: Boolean(params.opts.json),
      skipPrompt: Boolean(params.opts.yes),
    });

    if (params.installKindChanged && resultWithPostUpdate.mode !== "git") {
      const retirement = await retireStandaloneGitWrapper({
        previousRoot: params.previousInstallRoot ?? params.root,
        assertCurrent,
      });
      if (retirement.error) {
        defaultRuntime.error(retirement.error);
        await markOriginFailure("wrapper-retirement-failed");
        const reported = await reportResult(
          {
            ...resultWithPostUpdate,
            status: "error",
            reason: "wrapper-retirement-failed",
          },
          false,
          undefined,
          false,
        );
        throw createFailure(reported, 1, retirement.error);
      }
    }

    return await reportResult(resultWithPostUpdate);
  } catch (error) {
    if (error instanceof UpdateCommandFailure || error instanceof UpdateServiceLoadBoundaryError) {
      // Staging may already have changed files. Keep intent/material for fenced reconciliation.
      throw error;
    }
    const message = formatErrorMessage(error);
    defaultRuntime.error(`Post-update verification failed: ${message}`);
    const recovery =
      params.coreAlreadyCurrent && error instanceof UpdatePreMutationError
        ? await (pendingResult.mode === "git"
            ? readCurrentGitUpdateRecovery(
                pendingResult.root ?? params.root,
                params.updateStepTimeoutMs,
              )
            : verifyPackageUpdateRecovery(pendingResult.root ?? params.root))
        : undefined;
    assertCurrent();
    const reported = await reportResult(
      {
        ...pendingResult,
        status: "error",
        reason: error instanceof UpdatePreMutationError ? error.reason : "post-update-failed",
        ...(recovery ? { recovery } : {}),
        steps: [
          ...pendingResult.steps,
          {
            name: "post-update verification",
            command: "openclaw update",
            cwd: params.result.root ?? params.root,
            durationMs: Math.max(0, Date.now() - params.startedAt),
            exitCode: 1,
            stderrTail: message,
          },
        ],
      },
      recovery?.serviceRestartSafe === true,
    );
    throw createFailure(reported, resolveManagedServiceUpdateFailureExitCode(reported), message, {
      cause: error,
    });
  }
}
