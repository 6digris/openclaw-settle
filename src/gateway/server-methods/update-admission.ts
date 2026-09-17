import { UpdatePreMutationError } from "../../cli/update-cli/shared.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createUpdateErrorFact } from "../../infra/update-failure-facts.js";
import {
  createFreeBsdPkgOwnershipInspection,
  FreeBsdPkgOwnershipError,
} from "../../infra/update-freebsd-pkg-ownership.js";
import { getUpdateRun, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { summarizeUpdateStepFailure, type UpdateRunRecord } from "../../infra/update-run-record.js";
import { resolveUpdateInstallSurface } from "../../infra/update-runner-install-surface.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { initializeGatewayUpdateStatus } from "../../infra/update-startup.js";

export async function resolveGatewayUpdateAdmission(timeoutMs?: number) {
  const { root, status } = await initializeGatewayUpdateStatus();
  // Status discovery is read-only; admit ownership before campaign adoption
  // or a managed handoff can select and launch an updater.
  await createFreeBsdPkgOwnershipInspection(timeoutMs).assertUnowned(root);
  const installSurface = await resolveUpdateInstallSurface({
    root,
    installKind: status.installKind,
    timeoutMs,
  });
  return { status, installSurface };
}

export function recordHandoffFailure(
  runId: string,
  error: unknown,
  previous: UpdateRunResult,
): UpdateRunResult {
  const { reason, failureFacts } =
    error instanceof UpdatePreMutationError
      ? error
      : new UpdatePreMutationError("managed-service-handoff-failed", formatErrorMessage(error));
  const step = {
    name: "requested",
    command: "",
    cwd: previous.root ?? "",
    durationMs: 0,
    exitCode: null,
    failureFacts,
  };
  recordUpdateRunStep(runId, {
    step: step.name,
    status: "failed",
    exitCode: step.exitCode,
    detail: summarizeUpdateStepFailure(step),
    reason,
    failureFacts,
  });
  return { ...previous, status: "error", reason, steps: [...previous.steps, step] };
}

export function createUnexpectedUpdateFailureResult(
  run: UpdateRunRecord,
  previous: UpdateRunResult,
  error: unknown,
): UpdateRunResult {
  const current = getUpdateRun(run.runId) ?? run;
  const activeStep = current.steps.findLast((step) => step.status === "in_progress");
  const name = activeStep?.step ?? current.phase;
  const reason = error instanceof FreeBsdPkgOwnershipError ? error.reason : "unexpected-error";
  const step = {
    name,
    command: "",
    cwd: previous.root ?? "",
    durationMs: Date.now() - (activeStep?.startedAtMs ?? current.createdAtMs),
    exitCode: 1,
    failureFacts: [createUpdateErrorFact(name, error)],
  };
  recordUpdateRunStep(run.runId, {
    step: name,
    status: "failed",
    exitCode: step.exitCode,
    detail: summarizeUpdateStepFailure(step),
    reason,
    failureFacts: step.failureFacts,
  });
  return {
    ...previous,
    status: "error",
    reason,
    before: previous.before ?? current.before,
    after: previous.after ?? current.after,
    steps: [...previous.steps, step],
    durationMs: Date.now() - current.createdAtMs,
  };
}
