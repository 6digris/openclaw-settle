import { extractErrorCode, formatErrorMessage, readErrorName } from "../../infra/errors.js";
import { createUpdateFailureFact } from "../../infra/update-failure-facts.js";
import type { UpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  finishUpdateRun,
  heartbeatUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { updateRunStepsFromResultStep } from "../../infra/update-run-step.js";
import type { UpdateRunResult, UpdateStepProgress } from "../../infra/update-runner-types.js";

export type GatewayUpdateHandoff =
  | { status: "started"; pid?: number; command: string }
  | { status: "already-running" | "unavailable"; command: string; message: string };

// A later orchestration error must not erase facts already returned by the updater.
export const createGatewayUpdateFailureResult = (
  result: UpdateRunResult,
  error: unknown,
  check: string,
  startedAt: number,
  reason = "unexpected-error",
): UpdateRunResult => ({
  ...result,
  status: "error",
  reason,
  steps: [
    ...result.steps,
    {
      name: check,
      command: "",
      cwd: result.root ?? "",
      durationMs: 0,
      exitCode: null,
      failureFacts: [
        createUpdateFailureFact({
          check,
          code: extractErrorCode(error) ?? (readErrorName(error) || "Error"),
          message: formatErrorMessage(error),
        }),
      ],
    },
  ],
  durationMs: Math.max(result.durationMs, Date.now() - startedAt),
});

export const createGatewayUpdateProgress = (
  runId: string,
  driver: UpdateRunDriver | undefined,
): UpdateStepProgress => ({
  onHeartbeat: () => heartbeatUpdateRun(runId, driver),
  onStepStart: (step) =>
    recordUpdateRunStep(runId, {
      step: step.name,
      status: "in_progress",
      startedAtMs: Date.now(),
    }),
  onStepComplete: (step) => {
    for (const entry of updateRunStepsFromResultStep(step)) {
      recordUpdateRunStep(runId, { ...entry, endedAtMs: Date.now() });
    }
  },
});

export function recordGatewayUpdateResult(
  runId: string,
  result: UpdateRunResult,
  handoff: GatewayUpdateHandoff | null,
  acceptedHandoffStep: UpdateRunResult["steps"][number] | undefined,
): UpdateRunRecord {
  let outcomeRun = recordUpdateRunPhase(
    runId,
    result.status === "ok" ? "restarting" : "requested",
    {
      before: result.before,
      after: result.after,
      ...(handoff && "message" in handoff ? { origin: { nextAction: handoff.message } } : {}),
    },
  );
  for (const step of result.steps) {
    for (const [index, entry] of updateRunStepsFromResultStep(step).entries()) {
      // Only the accepted custody step lacks a child exit; later failures stay failed.
      recordUpdateRunStep(
        runId,
        index === 0 && step === acceptedHandoffStep
          ? { ...entry, status: "completed", detail: undefined }
          : entry,
      );
    }
  }
  // A managed orchestrator or the replacement Gateway owns terminal success;
  // refusals and synchronous failures have no later process to finish the run.
  if (result.status !== "ok" && handoff?.status !== "started") {
    outcomeRun = finishUpdateRun(runId, {
      status: result.status === "skipped" ? "skipped" : "failed",
      reason: result.reason,
      after: result.after,
    });
  }
  return outcomeRun;
}
