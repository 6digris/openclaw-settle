import type { TriageFailureContext } from "../../commands/triage-prompt.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveManagedServiceUpdateFailureExitCode } from "../../infra/update-control-plane-sentinel.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import {
  normalizeControlPlaneUpdateResult,
  isUpdateGatewayReadinessPending,
  getUpdateGatewayVerification,
} from "../../infra/update-run-step.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { UPDATE_ACTIVATION_TIMEOUT_REASON } from "../../shared/update-outcome.js";
import type { FinishUpdateParams, UpdateProfileContext } from "./update-command-finish-types.js";
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
import {
  createWindowsTaskAutoStartGuard,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
} from "./update-command-service-maintenance.js";
import { maybeRestartServiceAfterFailedMutableUpdate } from "./update-command-service-recovery.js";
import { recordFailedUpdateGatewayState } from "./update-command-service.js";
import {
  deferUpdateCommandTerminalResult,
  recordUpdatePackageCompletion,
  publishUpdateCommandTerminalResult,
  resolveSettledUpdateCommandResult,
} from "./update-command-terminal.js";
import { completeWindowsTaskAutoStartRecoveries } from "./update-command-windows-task.js";

/** Owns one update's recovery, Windows custody, and terminal publication. */
export function createUpdateFinalization(params: FinishUpdateParams, assertCurrent: () => void) {
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
  const createFailure = (
    result: UpdateRunResult,
    detail?: string,
    options?: ErrorOptions,
    exitCode = resolveManagedServiceUpdateFailureExitCode(result),
  ) =>
    new UpdateCommandFailure(result, exitCode, detail, {
      ...options,
      automaticTriage: state.triageAllowed
        ? resolveAutomaticUpdateTriage(result, detail, {
            ...originParams(),
            gateway: state.gateway,
          })
        : undefined,
    });
  let rollbackAttempted = false;
  const windowsPreservation = new Map<UpdateProfileContext, boolean>();
  const preserveProfileWindows = (profile: UpdateProfileContext, result: UpdateRunResult) => {
    const preserved = windowsPreservation.get(profile);
    if (preserved !== undefined) {
      return preserved;
    }
    if (params.profiles.length === 1) {
      return isUpdateGatewayReadinessPending(result);
    }
    const receipt = getUpdateGatewayVerification(result, params.profiles.indexOf(profile) + 1);
    return (
      receipt?.exitCode === 0 &&
      (!rollbackAttempted || receipt.name.endsWith(": rollback gateway verification"))
    );
  };
  const resumeWindowsAutoStart = async (result: UpdateRunResult, onlyPreserved = false) => {
    for (const profile of params.profiles) {
      if (onlyPreserved && !preserveProfileWindows(profile, result)) {
        continue;
      }
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
    result: UpdateRunResult = state.pendingResult,
  ) => {
    await completeWindowsTaskAutoStartRecoveries(
      params.profiles.map((profile) => profile.preManagedServiceStop?.windowsTaskAutoStartRecovery),
      (index) => success || preserveProfileWindows(params.profiles[index]!, result),
      assertCurrent,
    );
  };
  let rolledBack = false;
  let completedDowntimeMs: number | undefined = params.coreAlreadyCurrent ? 0 : undefined;
  const initialPendingRestartAtMs =
    origin.preManagedServiceStop?.stoppedAtMs ??
    params.controlPlaneUpdateSentinelMeta?.serviceStoppedAtMs;
  // Health resets replace ledger verification. Keep completed outages here
  // until final reporting, including a separately verified rollback.
  const recordVerifiedDowntime = (verifiedAtMs: number) => {
    if (state.pendingRestartAtMs !== undefined) {
      completedDowntimeMs =
        (completedDowntimeMs ?? 0) + Math.max(0, verifiedAtMs - state.pendingRestartAtMs);
      state.pendingRestartAtMs = undefined;
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

  const state: {
    gateway: TriageFailureContext["gateway"];
    triageAllowed: boolean;
    postVerificationRepairAttempted: boolean;
    pendingRestartAtMs: number | undefined;
    pendingResult: UpdateRunResult;
  } = {
    gateway: "preserve",
    triageAllowed: true,
    postVerificationRepairAttempted: false,
    pendingRestartAtMs: initialPendingRestartAtMs,
    pendingResult: params.result,
  };
  let pendingNotify = true;
  const publishFinalResult = async (failure?: unknown): Promise<UpdateRunResult> => {
    const settled = await resolveSettledUpdateCommandResult(params, state.pendingResult, failure);
    const result = completedResult(settled.result);
    result.recovery = settled.settlementFailed ? undefined : result.recovery;
    const reportDowntime = !settled.settlementFailed && state.pendingRestartAtMs === undefined;
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
      state.triageAllowed = false;
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
      state.pendingRestartAtMs ??= origin.preManagedServiceStop?.stoppedAtMs;
      if (rollback.verifiedAtMs !== undefined) {
        recordVerifiedDowntime(rollback.verifiedAtMs);
      }
      recoverService = false;
    }
    if (isUpdateGatewayReadinessPending(result)) {
      state.triageAllowed = false;
      return { result, recoverService: false };
    }
    if (
      result.status === "error" &&
      params.rollbackBlockedReason &&
      !state.postVerificationRepairAttempted
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
      state.postVerificationRepairAttempted = true;
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
    state.pendingResult = finalResult;
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
          state.gateway = "verify-running";
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
    state.pendingResult = completedResult(cleanupFailure?.result ?? finalResult);
    const reportedResult = deferredTerminal ? state.pendingResult : await publishFinalResult();
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
      throw createFailure(reportedResult, detail, { cause });
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
  return {
    state,
    origin,
    nodeFor,
    notifyOrigin,
    markOriginFailure,
    createFailure,
    windowsPreservation,
    recordVerifiedDowntime,
    recoverFailedResult,
    reportResult,
    restoreWindowsAutoStart,
  };
}
