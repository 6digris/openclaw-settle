// One command adapter around the existing bounded repair engine and Doctor oracle.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { recordAgentCleanupFailure } from "../agents/run-cleanup-timeout.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import type { HealthFinding } from "../flows/health-checks.js";
import {
  installationTargetEnv,
  type InstallationTarget,
} from "../infra/installation-target-context.js";
import type {
  UpdateRepairParams,
  UpdateRepairValidation,
} from "../infra/update-repair-protocol.js";
import { buildUpdateDoctorEnv } from "../infra/update-runner-doctor.js";
import {
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import type { TriageUpdateFailure } from "./triage-update.js";

function triageCollectionError(error: unknown, redaction: SupportRedactionContext): string {
  const message = error instanceof Error ? error.message : String(error);
  return scrubDoctorErrorMessage(redactSupportString(message, redaction));
}

/** Doctor validation is a repair result, never proof that the requested Gateway started. */
export async function runTriageRepair(params: {
  target: InstallationTarget;
  targetEnv: NodeJS.ProcessEnv;
  findings: readonly HealthFinding[];
  updateFailure?: TriageUpdateFailure;
  implicitUpdate?: boolean;
  installRoot: string;
  authority: { assertCurrent: () => void; signal: AbortSignal };
}) {
  const { target, findings, updateFailure, installRoot, authority } = params;
  const targetEnv = {
    ...params.targetEnv,
    ...installationTargetEnv(target),
    ...buildUpdateDoctorEnv({
      allowGatewayServiceRepair: false,
      allowGatewayActivation: false,
      serviceRepairPolicy: "external",
    }),
  };
  const redaction = { env: targetEnv, stateDir: target.stateDir };
  const isCurrent = () => {
    authority.signal.throwIfAborted();
    authority.assertCurrent();
    return true;
  };
  isCurrent();
  const { runUpdateRepairLoop } = await import("../infra/update-repair-agent.js");
  const failedResult =
    updateFailure && "result" in updateFailure ? updateFailure.result : undefined;
  let pending: Promise<UpdateRepairValidation> | undefined;
  const validate = (signal: AbortSignal): Promise<UpdateRepairValidation> => {
    pending = (async () => {
      try {
        const validateDoctor = async () => {
          const { validateTriageDoctor } = await import("./triage-doctor.js");
          return validateTriageDoctor({
            installRoot,
            env: targetEnv,
            signal,
            redaction,
            assertCurrent: isCurrent,
          });
        };
        const { validateTriageUpdateResolution } =
          await import("../infra/update-triage-resolution.js");
        const resolution = await validateTriageUpdateResolution({
          failure: updateFailure,
          implicit: params.implicitUpdate,
          installRoot,
          env: targetEnv,
          signal,
          validateDoctor,
        });
        isCurrent();
        return {
          ...resolution,
          summary: triageCollectionError(resolution.summary, redaction),
          ...(resolution.stopReason
            ? { stopReason: triageCollectionError(resolution.stopReason, redaction) }
            : {}),
        };
      } catch (error) {
        if (isRecord(error) && (error.cleanup === "uncertain" || error.cleanup === "forced")) {
          recordAgentCleanupFailure();
          throw error;
        }
        signal.throwIfAborted();
        const summary = `${updateFailure ? "Update resolution checks" : "Doctor checks"} unavailable: ${triageCollectionError(error, redaction)}${updateFailure ? " Next step: run `openclaw update status --json`, then `openclaw update repair`." : ""}`;
        return {
          ok: false,
          // An unavailable oracle must never appear better than known Doctor errors.
          score: Number.MIN_SAFE_INTEGER,
          summary,
          ...(updateFailure ? { stopReason: summary } : {}),
        };
      }
    })();
    return pending;
  };
  try {
    // The engine runs validation under its deadline before selecting inference.
    // Replace operator intent with that observation before any repair prompt.
    const context: UpdateRepairParams["context"] = {
      ...(updateFailure ?? { error: "Operator requested validation and repair." }),
      phase: "verifying",
      beforeVersion: failedResult?.before?.version ?? undefined,
      symptoms: findings
        .slice(0, 20)
        .map((finding) =>
          redactSupportString(
            `[${finding.severity}] ${finding.checkId}: ${finding.message}`,
            redaction,
            { maxLength: 200 },
          ),
        ),
    };
    return await runUpdateRepairLoop({
      runId: failedResult?.runId,
      target: {
        stateDir: target.stateDir,
        configPath: target.configPath,
        workspaceDir: target.defaultWorkspaceDir,
        installRoot,
      },
      context,
      budget: { maxTurns: 1 },
      signal: authority.signal,
      isCurrent,
      validate: async (signal) => {
        const observed = await validate(signal);
        if (!updateFailure) {
          context.error = observed.summary;
        }
        return observed;
      },
    });
  } finally {
    // The loop cancels promptly; retain exclusion until its read-only child drains.
    await pending?.catch(() => undefined);
  }
}
