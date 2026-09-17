import { formatErrorMessage } from "../../infra/errors.js";
import { UpdateRecoveryRequiredError } from "../../infra/update-run-recovery.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  assertUpdateProfileRecoveryAdmission,
  UpdateCommandRecoveryPendingError,
} from "./update-command-recovery.js";
import {
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
  UpdateCommandPendingRecoveryFailure,
  mergeWindowsTaskRecoveryFailure,
} from "./update-command-result.js";
import { completeUpdateCommandRun, failUpdateCommandRun } from "./update-command-run.js";
import type { UpdateCommandRecoveryState } from "./update-command-service-maintenance.js";
import { hasDeferredUpdateCommandTerminalResult } from "./update-command-terminal.js";
import { completeWindowsTaskAutoStartRecoveries } from "./update-command-windows-task.js";

/** Unwind only legacy updates; pending publication cannot authorize compensation or diagnostics. */
export async function withUpdateCommandRecoveryUnwind(
  opts: UpdateCommandOptions & { run: NonNullable<UpdateCommandOptions["run"]> },
  recoveryState: UpdateCommandRecoveryState,
  operation: () => Promise<void>,
): Promise<void> {
  const run = opts.run;
  const primaryResult = (error: unknown) =>
    error instanceof UpdateCommandFailure
      ? error.result
      : (recoveryState.triageTarget.failureResult ?? {
          status: "error" as const,
          mode: "unknown" as const,
          reason: "update-failed",
          runId: run.runId,
          steps: [],
          durationMs: 0,
        });
  let failure: { error: unknown } | undefined;
  try {
    await operation();
    run.executorFence?.assertCurrent();
  } catch (error) {
    try {
      run.executorFence?.assertCurrent();
    } catch (cause) {
      throw new UpdateCommandPendingRecoveryFailure(
        primaryResult(error),
        formatErrorMessage(cause),
        { cause: new AggregateError([error, cause], "Update executor was lost", { cause: error }) },
      );
    }
    if (
      error instanceof UpdateCommandPendingRecoveryFailure ||
      error instanceof UpdateCommandFinalizedRecoveryFailure
    ) {
      throw error;
    }
    if (
      error instanceof UpdateCommandRecoveryPendingError ||
      error instanceof UpdateRecoveryRequiredError
    ) {
      throw new UpdateCommandPendingRecoveryFailure(
        primaryResult(error),
        formatErrorMessage(error),
        { cause: error },
      );
    }
    failure = { error };
  }
  if (recoveryState.ledgerHandoffOwned && !recoveryState.ledgerHandoffCompleted) {
    let cause = failure?.error ?? new Error("Update finalization has no confirmed outcome.");
    try {
      // Settle the existing guarded suspension without enabling a runtime whose
      // handoff did not finish. The native owner retains its own identity checks.
      await completeWindowsTaskAutoStartRecoveries(
        recoveryState.windowsTaskAutoStartRecoveries ?? [],
        false,
      );
    } catch (error) {
      cause = new AggregateError([cause, error], "Migrated handoff recovery remains pending", {
        cause,
      });
    }
    throw new UpdateCommandPendingRecoveryFailure(
      primaryResult(failure?.error),
      formatErrorMessage(cause),
      { cause },
    );
  }
  if (!recoveryState.ledgerHandoffOwned) {
    // The admitted newer runtime owns canonical history after handoff. The old
    // process must not reopen a database that it may no longer understand.
    try {
      // A lost live context or a successful callback is not fresh-install proof.
      // Reconcile all affected state roots read-only before native compensation.
      await assertUpdateProfileRecoveryAdmission([
        run.env,
        recoveryState.triageTarget.env,
        ...(recoveryState.profiles ?? []).map(
          (profile) => profile.ownedManagedUpdateEnv ?? run.env,
        ),
      ]);
    } catch (error) {
      throw new UpdateCommandPendingRecoveryFailure(
        primaryResult(failure?.error),
        formatErrorMessage(error),
        { cause: error },
      );
    }
  }
  try {
    const failures: unknown[] = [];
    for (const recovery of recoveryState.windowsTaskAutoStartRecoveries ?? []) {
      try {
        await recovery.restore();
        await recovery.complete();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, "Windows task autostart recovery failed");
    }
  } catch (restoreError) {
    let error = restoreError;
    try {
      await completeWindowsTaskAutoStartRecoveries(
        recoveryState.windowsTaskAutoStartRecoveries ?? [],
        false,
      );
    } catch (compensationError) {
      error = new AggregateError(
        [error, compensationError],
        `Windows task autostart recovery failed: ${formatErrorMessage(error)}; ${formatErrorMessage(compensationError)}`,
        { cause: error },
      );
    }
    failure = mergeWindowsTaskRecoveryFailure(failure, error);
  }
  if (failure) {
    if (!recoveryState.ledgerHandoffOwned && !hasDeferredUpdateCommandTerminalResult(run)) {
      if (failure.error instanceof UpdateCommandFailure) {
        completeUpdateCommandRun(failure.error.result, run);
      } else {
        failUpdateCommandRun(failure.error, run);
      }
    }
    throw failure.error;
  }
}
