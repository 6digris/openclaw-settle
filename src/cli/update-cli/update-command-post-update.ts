import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { buildControlPlaneUpdateRestartHealthPendingResult } from "../../infra/update-control-plane-sentinel.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { verifyPackageUpdateRecovery } from "../../infra/update-global.js";
import { parkForegroundUpdateHandoff } from "../../infra/update-managed-service-handoff.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { retainUpdateProfileVerification } from "../../infra/update-run-step.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { classifyUpdateOutcome } from "../../shared/update-outcome.js";
import { inspectGatewayRestart } from "../daemon-cli/restart-health.js";
import { listenerOwnedByRuntimePid } from "../daemon-cli/restart-port-ownership.js";
import { UpdatePreMutationError } from "./shared.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { createUpdateFinalization } from "./update-command-finalization-state.js";
import type { FinishUpdateParams, UpdateProfileContext } from "./update-command-finish-types.js";
import { retireStandaloneGitWrapper } from "./update-command-git.js";
import { appendPluginUpdateWarnings } from "./update-command-plugins-internals.js";
import {
  assertUpdateCommandPackageFinalization,
  createUpdateCommandFinalizationFence,
} from "./update-command-recovery.js";
import { repairUpdateService } from "./update-command-repair-service.js";
import { prepareUpdateRestart } from "./update-command-restart-context.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";
import { UpdateServiceLoadBoundaryError } from "./update-command-service-load.js";
import {
  GatewayServiceUpdateOwnershipError,
  resolvePackageRuntimePreflight,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import {
  maybeRestartService,
  maybeStopManagedServiceBeforeMutableUpdate,
  tryInstallShellCompletion,
} from "./update-command-service.js";

export type { FinishUpdateParams } from "./update-command-finish-types.js";

export async function finishUpdate(
  params: FinishUpdateParams,
  commonRuntimeEnv?: NodeJS.ProcessEnv,
): Promise<UpdateRunResult> {
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
  const {
    state: finalizationState,
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
  } = createUpdateFinalization(params, assertCurrent);

  const onProfileVerified = (profile: UpdateProfileContext) => (atMs: number) => {
    windowsPreservation.set(profile, true);
    if (profile === origin) {
      recordVerifiedDowntime(atMs);
    }
  };
  const retainProfileReceipt = (
    profile: UpdateProfileContext,
    result: UpdateRunResult,
    before: UpdateRunResult["steps"],
  ) => {
    if (params.profiles.length > 1) {
      retainUpdateProfileVerification(result, params.profiles.indexOf(profile) + 1, before);
    }
  };

  try {
    if (params.result.status === "error" || params.result.recovery?.serviceRestartSafe === false) {
      const reported = await reportResult(
        { ...params.result, status: "error" },
        params.result.recovery?.serviceRestartSafe === true,
      );
      throw createFailure(reported, params.failure?.detail, params.failure);
    }

    if (params.result.status === "skipped" && !params.coreAlreadyCurrent) {
      const reported = await reportResult(
        params.result,
        params.result.recovery?.serviceRestartSafe === true,
      );
      throw createFailure(
        reported,
        undefined,
        undefined,
        classifyUpdateOutcome(reported) === "failed" ? undefined : 0,
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
        profile.preManagedServiceStop !== undefined &&
        profile.preManagedServiceStop.running !== false &&
        (!params.coreAlreadyCurrent ||
          (profile.preManagedServiceStop.running === true &&
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
        entry.profile.serviceRuntimeRefreshRequired ||=
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
              finalizationState.pendingRestartAtMs ??= state.stoppedAtMs;
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
      finalizationState.pendingResult = resultWithPostUpdate;
      entry.snapshot = convergence.postUpdateConfigSnapshot;
      recordProfileStep(entry.profile, "convergence", resultWithPostUpdate.status !== "error");
      if (resultWithPostUpdate.status === "error") {
        finalizationState.triageAllowed = !convergence.cancelled;
        const reported = await reportResult(resultWithPostUpdate);
        throw createFailure(reported, convergence.detail);
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
        const runtimeEnv = commonRuntimeEnv ?? { ...process.env };
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
            runtimeEnv,
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
        throw createFailure(reported, message, { cause: error });
      }
    };
    const restarting: ((typeof profiles)[number] & {
      restart: Awaited<ReturnType<typeof prepareUpdateRestart>>;
    })[] = [];
    for (const entry of [...profiles.slice(1), profiles[0]!]) {
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
        const before = entry.profile.preManagedServiceStop;
        if (!entry.shouldRestart || !before) {
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
            expectedService: before,
            recoveryStop: before,
            onVerified: onProfileVerified(entry.profile),
          }),
        );
        assertCurrent();
        retainProfileReceipt(entry.profile, result, beforeVerification);
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
          onVerified: onProfileVerified(entry.profile),
        }),
      );
      assertCurrent();
      retainProfileReceipt(entry.profile, resultWithPostUpdate, beforeVerification);
      if (restarted === "readiness-pending") {
        windowsPreservation.set(entry.profile, true);
      } else if (restarted !== "ok") {
        windowsPreservation.set(entry.profile, false);
      }
      finalizationState.pendingResult = resultWithPostUpdate;
      recordProfileStep(
        entry.profile,
        restarted === "readiness-pending" ? "readiness pending" : "verification",
        restarted === "ok" || restarted === "readiness-pending",
      );
      if (restarted === "ok" || restarted === "readiness-pending") {
        continue;
      }
      finalizationState.triageAllowed = context.serviceMutationAllowed;
      if (
        restarted === "restart-health-failed" &&
        entry.shouldRestart &&
        context.serviceMutationAllowed &&
        !context.skipLegacyServiceRestart &&
        entry.profile === origin
      ) {
        finalizationState.gateway = "verify-running";
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
          !finalizationState.postVerificationRepairAttempted
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
      throw createFailure(reported);
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
        throw createFailure(reported, retirement.error, undefined, 1);
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
        ? await (finalizationState.pendingResult.mode === "git"
            ? readCurrentGitUpdateRecovery(
                finalizationState.pendingResult.root ?? params.root,
                params.updateStepTimeoutMs,
              )
            : verifyPackageUpdateRecovery(finalizationState.pendingResult.root ?? params.root))
        : undefined;
    assertCurrent();
    const reported = await reportResult(
      {
        ...finalizationState.pendingResult,
        status: "error",
        reason: error instanceof UpdatePreMutationError ? error.reason : "post-update-failed",
        ...(recovery ? { recovery } : {}),
        steps: [
          ...finalizationState.pendingResult.steps,
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
    throw createFailure(reported, message, {
      cause: error,
    });
  }
}
