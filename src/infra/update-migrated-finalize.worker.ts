import fs from "node:fs/promises";
import path from "node:path";
import { finishUpdateRun } from "../cli/daemon-cli.js";
import { retainCliProcessJobUntilExit, withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import type { UpdateCommandOptions } from "../cli/update-cli/shared.js";
import {
  withDelegatedUpdateCommandExecutor,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import type { UpdateProfileContext } from "../cli/update-cli/update-command-finish-types.js";
import type {
  LegacyMigratedUpdateFinalizationInput,
  UpdateDoctorInput,
  MigratedUpdateFinalizationInput,
  MigratedUpdateFinalizationResult,
} from "../cli/update-cli/update-command-migrated-types.js";
import { finishUpdate } from "../cli/update-cli/update-command-post-update.js";
import {
  formatUpdateFinalizationError,
  UpdateCommandFailure,
} from "../cli/update-cli/update-command-result.js";
import { createWindowsTaskAutoStartGuard } from "../cli/update-cli/update-command-service-maintenance.js";
import { withUpdateCommandTerminalResult } from "../cli/update-cli/update-command-terminal.js";
import {
  completeWindowsTaskAutoStartRecoveries,
  createWindowsTaskAutoStartRecovery,
} from "../cli/update-cli/update-command-windows-task.js";
import { routeLogsToStderr } from "../logging/console.js";
import { defaultRuntime } from "../runtime.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveEnvironmentValue } from "./process-env.js";
import {
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  recordUpdateDoctorConfigWriteRefusal,
  writeUpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";
import { resolveUpdateFinalizationTimeoutMs } from "./update-finalization-budget.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";
import {
  createManagedUpdateRequesterAuthority,
  UpdateRequesterRevokedError,
} from "./update-requester-authority.js";
import { adoptUpdateRun, getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";
import {
  isUpdateGatewayReadinessPending,
  getUpdateGatewayVerification,
} from "./update-run-step.js";

function normalizeFinalizationInput(
  input: MigratedUpdateFinalizationInput | LegacyMigratedUpdateFinalizationInput,
): MigratedUpdateFinalizationInput {
  const { params } = input;
  if ("profiles" in params) {
    return { ...input, params };
  }
  // The published singleton belongs to this boundary; finalization has one
  // grouped owner regardless of which installed driver supplied the handoff.
  const windowsTaskAutoStartSuspended =
    "windowsTaskAutoStartSuspended" in input ? input.windowsTaskAutoStartSuspended : undefined;
  const {
    preManagedServiceStop,
    ownedManagedUpdateEnv,
    configSnapshot,
    requestedChannel,
    storedChannel,
    preUpdatePluginInstallRecords,
    schemaVersions,
    previousVerified,
    activationConfig,
    serviceRuntimeRefreshRequired,
    ...shared
  } = params;
  return {
    executor: input.executor,
    recoveryHandoff: input.recoveryHandoff,
    bufferedSteps: input.bufferedSteps,
    resultPath: input.resultPath,
    params: {
      ...shared,
      profiles: [
        {
          preManagedServiceStop,
          ownedManagedUpdateEnv,
          configSnapshot,
          requestedChannel,
          storedChannel,
          preUpdatePluginInstallRecords,
          schemaVersions,
          previousVerified,
          activationConfig,
          packageUpdateNodeRunner: params.packageUpdateNodeRunner,
          serviceRuntimeRefreshRequired,
          ...(windowsTaskAutoStartSuspended ? { windowsTaskAutoStartSuspended } : {}),
        },
      ],
    },
  };
}

async function finalizeMigratedUpdate(): Promise<void> {
  // Validation imports this whole candidate graph before activation. The helper
  // also needs the stable recovery barrel's writer after an actual schema bump.
  if (process.argv[2] === "--check") {
    routeLogsToStderr();
    if (typeof finishUpdateRun !== "function") {
      throw new Error("Candidate recovery writer is unavailable.");
    }
    process.stdout.write(
      JSON.stringify({
        executorDelegation: "pid-start-v1",
        doctorConfigWrites: "pid-start-v1",
        profileContexts: true,
        gatewayRestartCompletion: true,
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      }),
    );
    return;
  }
  // The normal CLI bootstrap retains this native Job. This executable worker
  // bypasses that bootstrap, so install the same kill-on-close owner before input.
  // POSIX callers own the detached process group and join its kernel extinction.
  await withCliProcessScope(retainCliProcessJobUntilExit);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (process.argv[2] === "--doctor") {
    // SAFETY: The typed parent sends this private input only after binding this child.
    return await runDelegatedDoctor(JSON.parse(text) as UpdateDoctorInput);
  }
  const input = normalizeFinalizationInput(
    // SAFETY: Only the typed parent continuation serializes this private input.
    JSON.parse(text) as MigratedUpdateFinalizationInput | LegacyMigratedUpdateFinalizationInput,
  );
  if (input.params.opts.json) {
    // The installed updater forwards this worker's stdout verbatim. Keep diagnostics
    // on stderr through terminal-history reads and the process's database cleanup.
    routeLogsToStderr();
  }
  if (input.recoveryHandoff) {
    throw new Error(
      "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
    );
  }
  if (!input.params.profiles.length) {
    throw new Error("Migrated finalization requires an admitted profile.");
  }
  const activationTimeoutMs =
    input.params.opts.run?.activationTimeoutMs ??
    (
      await Promise.all(
        input.params.profiles.map((profile) =>
          resolveUpdateFinalizationTimeoutMs(input.params.updateStepTimeoutMs, {
            env: profile.ownedManagedUpdateEnv ?? input.params.opts.run?.env,
            databases: profile.schemaVersions,
            pluginCount: Object.keys(profile.preUpdatePluginInstallRecords).length,
            nodeRunner: input.params.packageUpdateNodeRunner,
          }),
        ),
      )
    ).reduce((total, budget) => total + budget, 0);
  const finalized = await withUpdateCommandTerminalResult(async (registerRun) => {
    if (input.executor) {
      return await withDelegatedUpdateCommandExecutor(
        input.executor,
        input.params.opts.run?.runId ?? "",
        input.params.result.root ?? input.params.root,
        async (fence) => finalizeInput(input, fence, registerRun),
        {
          activationTimeoutMs,
        },
      );
    }
    // The shipped v2026.9.3 producer overrides these selectors for worker
    // scratch, but retains its pre-override environment in the private input.
    // Restore only this one-shot worker's selectors before resolving the normal
    // installation lease domain; scratch-local ownership cannot exclude updates.
    const admissionEnv =
      input.params.profiles[0]?.ownedManagedUpdateEnv ?? input.params.opts.run?.env;
    if (!admissionEnv) {
      throw new Error("Grantless finalization requires its captured update environment.");
    }
    // v2026.9.3 update-command-migrated.ts:149–195 sends this grantless handoff.
    // Its captured meta.root is the lease key; activation can retarget that path.
    // Only the same installation borrows the waiting parent's lease.
    const meta = input.params.controlPlaneUpdateSentinelMeta;
    const runId = input.params.opts.run?.runId ?? "";
    const scratch = path.dirname(input.resultPath);
    const legacyManagedParent =
      input.params.result.before?.version === "2026.9.3" &&
      admissionEnv.OPENCLAW_UPDATE_RUN_HANDOFF === "1" &&
      admissionEnv.OPENCLAW_UPDATE_RUN_ID === runId &&
      meta?.runId === runId &&
      meta.handoffId &&
      meta.root &&
      meta.root === resolveUpdateInstallRoot(input.params.result.root ?? input.params.root) &&
      path.basename(scratch).startsWith("openclaw-update-migrated-") &&
      path.basename(input.resultPath) === "result.json" &&
      ["TMPDIR", "TMP", "TEMP"].every(
        (name) => resolveEnvironmentValue(process.env, name) === scratch,
      )
        ? { runId, handoffId: meta.handoffId, root: meta.root }
        : undefined;
    for (const name of ["TMPDIR", "TMP", "TEMP"] as const) {
      const value = resolveEnvironmentValue(admissionEnv, name);
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    return await withUpdateCommandExecutor(
      runId,
      async (executor) => {
        const fence = await executor.enter(input.params.result.root ?? input.params.root, {
          activationTimeoutMs,
        });
        return await finalizeInput(input, fence, registerRun);
      },
      legacyManagedParent ? { legacyManagedParent } : undefined,
    );
  }, input.params.opts);
  const terminal = getUpdateRun(finalized.run.runId, { env: finalized.run.env });
  const gatewayRestartPending =
    finalized.run.completionOwner === "gateway-restart" &&
    finalized.run.gatewayRestartRequired === true &&
    finalized.result.status === "ok" &&
    terminal?.status === "running" &&
    terminal.phase === "restarting";
  if (!terminal || (terminal.status === "running" && !gatewayRestartPending)) {
    throw new Error("Candidate finalization left the update run nonterminal.");
  }
  const response: MigratedUpdateFinalizationResult = {
    result: finalized.result,
    exitCode: finalized.exitCode,
    ...(gatewayRestartPending
      ? { restartRunId: terminal.runId }
      : { terminalRunId: terminal.runId }),
    executorDelegation: "pid-start-v1",
    automaticTriage: finalized.automaticTriage,
  };
  // Private response publication follows executor settlement and terminal history.
  await fs.writeFile(input.resultPath, JSON.stringify(response), { mode: 0o600 });
}

async function runDelegatedDoctor(input: UpdateDoctorInput): Promise<void> {
  const resultPath = process.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]?.trim();
  if (!resultPath || !input.executor) {
    throw new Error("Update Doctor requires its delegated executor and result path.");
  }
  await withDelegatedUpdateCommandExecutor(
    input.executor,
    input.runId,
    input.root,
    async (fence) => {
      const requester = input.requester
        ? await createManagedUpdateRequesterAuthority(input.requester)
        : undefined;
      const assertCurrent = () => {
        try {
          fence.assertCurrent();
          if (requester?.isCurrent() === false) {
            throw new UpdateRequesterRevokedError();
          }
        } catch (error) {
          recordUpdateDoctorConfigWriteRefusal({
            reason:
              error instanceof UpdateRequesterRevokedError ? error.code : "authority-check-failed",
            message: formatUpdateFinalizationError(error),
            keys: [],
          });
          throw error;
        }
      };
      try {
        assertCurrent();
      } catch (error) {
        if (!(error instanceof UpdateRequesterRevokedError)) {
          throw error;
        }
        fence.assertCurrent();
        await writeUpdatePostInstallDoctorResult({
          resultPath,
          result: {
            status: "error",
            configWriteRefusal: { reason: error.code, message: error.message, keys: [] },
          },
        });
        process.exitCode = 1;
        return;
      }
      const { runDoctorHealthFlow } = await import("../flows/doctor-health.js");
      assertCurrent();
      await runDoctorHealthFlow(
        {
          ...defaultRuntime,
          exit: (code) => {
            process.exitCode = code;
          },
        },
        { repair: input.repair, nonInteractive: true },
        { inputHash: input.configInputHash, assertCurrent },
      );
    },
  );
}

async function finalizeInput(
  input: MigratedUpdateFinalizationInput,
  executorFence: UpdateRecoveryFence,
  registerRun: (run: NonNullable<UpdateCommandOptions["run"]>) => void,
) {
  const transferredRun = input.params.opts.run;
  if (
    !transferredRun ||
    "executorFence" in transferredRun ||
    (!input.recoveryHandoff &&
      input.params.rollbackBlockedReason !== "state-migrated-no-rollback" &&
      input.params.rollbackBlockedReason !== "rollback-state-unverified")
  ) {
    throw new Error("Candidate finalization requires its migrated update run.");
  }
  const { requesterAuthority: descriptor, ...runIdentity } = transferredRun;
  executorFence?.assertCurrent();
  adoptUpdateRun(runIdentity.runId, { env: runIdentity.env });
  // Parent closures cannot cross JSON. Only the fresh installed runtime rebinds
  // the captured requester to the same current installation policy.
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    ...runIdentity,
    ...(executorFence ? { executorFence } : {}),
    ...(descriptor
      ? {
          requesterAuthority: await createManagedUpdateRequesterAuthority(
            descriptor.requester,
            runIdentity.env,
          ),
        }
      : {}),
  };
  executorFence.assertCurrent();
  registerRun(run);
  for (const step of input.bufferedSteps) {
    executorFence?.assertCurrent();
    recordUpdateRunStep(run.runId, step, { env: run.env });
  }
  if (
    input.params.profiles.some(
      (profile) =>
        profile.windowsTaskAutoStartSuspended && !profile.preManagedServiceStop?.serviceEnv,
    )
  ) {
    throw new Error("Transferred Windows task suspension is missing its stopped service owner.");
  }
  const profiles: UpdateProfileContext[] = input.params.profiles.map(
    ({ windowsTaskAutoStartSuspended, ...profile }) => {
      const stopped = profile.preManagedServiceStop;
      const windowsTaskAutoStartRecovery =
        windowsTaskAutoStartSuspended && stopped?.serviceEnv
          ? createWindowsTaskAutoStartRecovery({
              serviceEnv: stopped.serviceEnv,
              updateRun: run,
              alreadySuspended: true,
              assertCurrentService: createWindowsTaskAutoStartGuard({
                root: input.params.result.root ?? input.params.root,
                before: stopped,
                timeoutMs: input.params.updateStepTimeoutMs,
              }),
              assertCurrent: () => {
                run.executorFence?.assertCurrent();
                if (getUpdateRun(run.runId, { env: run.env })?.status !== "running") {
                  throw new Error("Update run no longer owns Windows task activation.");
                }
              },
            })
          : undefined;
      return {
        ...profile,
        ...(stopped ? { preManagedServiceStop: { ...stopped, windowsTaskAutoStartRecovery } } : {}),
      };
    },
  );
  let result: MigratedUpdateFinalizationResult["result"] | undefined;
  let exitCode = 0;
  let automaticTriage: MigratedUpdateFinalizationResult["automaticTriage"];
  try {
    result = await finishUpdate({
      ...input.params,
      profiles,
      result: { ...input.params.result, runId: run.runId },
      opts: { ...input.params.opts, run },
    });
  } catch (error) {
    if (!(error instanceof UpdateCommandFailure)) {
      throw error;
    }
    result = error.result;
    exitCode = error.exitCode;
    automaticTriage = error.automaticTriage;
  } finally {
    await completeWindowsTaskAutoStartRecoveries(
      profiles.map((profile) => profile.preManagedServiceStop?.windowsTaskAutoStartRecovery),
      (index) =>
        result?.status === "ok" ||
        (result !== undefined &&
          ((result.status !== "error" && isUpdateGatewayReadinessPending(result)) ||
            (profiles.length === 1
              ? isUpdateGatewayReadinessPending(result)
              : getUpdateGatewayVerification(result, index + 1)?.exitCode === 0))),
    );
  }
  executorFence.assertCurrent();
  return { run, result, exitCode, automaticTriage };
}

void (async () => {
  try {
    await finalizeMigratedUpdate();
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
})().catch((error: unknown) => {
  process.stderr.write(`${formatUpdateFinalizationError(error)}\n`);
  process.exitCode = 1;
});
