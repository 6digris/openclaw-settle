import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatUpdateDoctorConfigChange } from "./update-doctor-config.js";
import { UPDATE_RUN_DIAGNOSTIC_LIMIT, UPDATE_RUN_TEXT_LIMIT } from "./update-run-limits.js";
import { summarizeUpdateStepFailure, type UpdateRunStep } from "./update-run-record.js";
import type { UpdateRunResult, UpdateStepResult } from "./update-runner-types.js";
import type { UpdateSnapshotCapacity } from "./update-snapshot-capacity.js";

type ResultStep = Pick<
  UpdateStepResult,
  | "name"
  | "exitCode"
  | "advisory"
  | "warnings"
  | "termination"
  | "stdoutTail"
  | "stderrTail"
  | "failureFacts"
  | "configChanges"
  | "configWriteRefusal"
  | "snapshotCapacity"
>;

export function normalizeControlPlaneUpdateResult(result: UpdateRunResult): UpdateRunResult {
  return (result.status === "ok" ||
    (result.status === "skipped" && result.reason === "already-current")) &&
    isUpdateGatewayReadinessPending(result)
    ? { ...result, status: "skipped", reason: "gateway-readiness-unverified" }
    : result;
}

export function isUpdateGatewayReadinessPending(result: UpdateRunResult): boolean {
  const step = result.steps.findLast(
    (entry) =>
      entry.name === "gateway verification" || entry.name === "rollback gateway verification",
  );
  const profiles = new Map<string, UpdateStepResult>();
  for (const entry of result.steps) {
    const profile = /^profile ([1-9]\d*): (rollback )?gateway verification$/u.exec(entry.name)?.[1];
    if (profile) profiles.set(profile, entry);
  }
  return [step, ...profiles.values()].some(
    (entry) =>
      entry?.termination === "timeout" && entry.advisory?.kind === "recoverable-maintenance",
  );
}

/** Keep each profile's latest receipt when the next native verification replaces the generic row. */
export function retainUpdateProfileVerification(
  result: UpdateRunResult,
  profileNumber: number,
  beforeSteps?: readonly UpdateStepResult[],
): void {
  const step = result.steps.findLast(
    (entry) =>
      entry.name === "gateway verification" || entry.name === "rollback gateway verification",
  );
  if (!step || beforeSteps?.includes(step)) return;
  const receipt = { ...step, name: `profile ${profileNumber}: ${step.name}` };
  const index = result.steps.findIndex((entry) => entry.name === receipt.name);
  if (index < 0) result.steps.push(receipt);
  else result.steps[index] = receipt;
}

export function getUpdateProfileVerification(
  result: UpdateRunResult,
  profileNumber: number,
): UpdateStepResult | undefined {
  return result.steps.findLast(
    (step) =>
      step.name === `profile ${profileNumber}: gateway verification` ||
      step.name === `profile ${profileNumber}: rollback gateway verification`,
  );
}

/** Warning rows preserve producer-classified advisories in the existing diagnostic ledger. */
export function updateRunStepsFromResultStep(step: ResultStep): UpdateRunStep[] {
  const text = (value: string) => truncateUtf16Safe(value, UPDATE_RUN_TEXT_LIMIT);
  const refusal = step.configWriteRefusal;
  const configWriteRefusal = refusal
    ? {
        reason: text(refusal.reason),
        message: text(refusal.message),
        keys: refusal.keys.slice(0, UPDATE_RUN_DIAGNOSTIC_LIMIT).map(text),
      }
    : undefined;
  const capacity = step.snapshotCapacity;
  const snapshotCapacity = capacity
    ? {
        ...capacity,
        candidates: capacity.candidates.slice(0, 3).map((candidate) => {
          const copied: UpdateSnapshotCapacity["candidates"][number] = {
            kind: candidate.kind,
            availableBytes: candidate.availableBytes,
            directory: text(candidate.directory),
          };
          if (candidate.allocationError) {
            copied.allocationError = text(candidate.allocationError);
          }
          return copied;
        }),
        selection: capacity.selection
          ? { ...capacity.selection, directory: text(capacity.selection.directory) }
          : null,
      }
    : undefined;
  const warnings = step.warnings?.length
    ? step.warnings
    : step.advisory
      ? [step.advisory.message]
      : [];
  return [
    {
      step: text(step.name),
      status: step.exitCode === 0 || step.advisory ? "completed" : "failed",
      exitCode: step.exitCode,
      ...(step.failureFacts?.length && !step.advisory
        ? { failureFacts: step.failureFacts.slice(0, 5) }
        : {}),
      ...(configWriteRefusal ? { configWriteRefusal } : {}),
      ...(snapshotCapacity ? { snapshotCapacity } : {}),
      ...(step.exitCode !== 0
        ? { detail: text(step.advisory?.message ?? summarizeUpdateStepFailure(step)) }
        : {}),
    },
    ...warnings.slice(0, UPDATE_RUN_DIAGNOSTIC_LIMIT).map((detail, index) => ({
      step: text(`warning:${step.name}${index === 0 ? "" : `:${index + 1}`}`),
      status: "completed" as const,
      detail: text(detail),
    })),
    ...(step.configChanges ?? []).slice(0, UPDATE_RUN_DIAGNOSTIC_LIMIT).map((change, index) => {
      const configChange =
        change.kind === "key"
          ? { kind: change.kind, key: text(change.key) }
          : { kind: change.kind, message: text(change.message) };
      return {
        step: text(`doctor-config:${step.name}:${index}`),
        status: "completed" as const,
        detail: text(formatUpdateDoctorConfigChange(configChange)),
        configChange,
      };
    }),
  ];
}

export function updateRunWarningMessages(steps: readonly UpdateRunStep[]): string[] {
  return steps.flatMap((step) =>
    step.status === "completed" && step.step.startsWith("warning:") && step.detail
      ? [step.detail]
      : [],
  );
}
