import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { executeGitCommand } from "../infra/git-exec.js";
import { formatCommandOutput, formatCommandResult } from "../process/command-error.js";
import { BACKUP_RUN_ERROR_MAX_LENGTH } from "../state/backup-run-records.contract.js";

const GIT_BACKUP_DIAGNOSTIC_MAX_LENGTH = 500;

function redactGitBackupText(value: string): string {
  return value
    .split("\n")
    .map((line) => redactSensitiveUrlLikeString(line))
    .join("\n");
}

export function sanitizeGitBackupDiagnostic(value: string): string {
  return truncateUtf16Safe(redactGitBackupText(value), GIT_BACKUP_DIAGNOSTIC_MAX_LENGTH);
}

export function formatGitBackupCommandResult(
  command: string,
  result: Awaited<ReturnType<typeof executeGitCommand>>,
): string {
  const redacted = {
    ...result,
    stderr: redactGitBackupText(result.stderr),
    stdout: redactGitBackupText(result.stdout),
  };
  const header = formatCommandResult(command, { ...redacted, stderr: "", stdout: "" });
  const streams = (["stderr", "stdout"] as const).flatMap((stream) => {
    const output = formatCommandOutput(redacted[stream]);
    return output ? [{ stream, output }] : [];
  });
  const fixedLength =
    header.length + streams.reduce((total, { stream }) => total + 1 + `${stream}: `.length, 0);
  if (streams.length === 0 || fixedLength >= BACKUP_RUN_ERROR_MAX_LENGTH) {
    return truncateUtf16Safe(header, BACKUP_RUN_ERROR_MAX_LENGTH);
  }
  const outputBudget = BACKUP_RUN_ERROR_MAX_LENGTH - fixedLength;
  const lengths = streams.map(({ output }) => output.length);
  const first = Math.min(
    lengths[0] ?? 0,
    Math.max(Math.ceil(outputBudget / 2), outputBudget - (lengths[1] ?? 0)),
  );
  const allocations = [first, Math.min(lengths[1] ?? 0, outputBudget - first)];
  const fit = (output: string, maxLength: number): string => {
    if (output.length <= maxLength) {
      return output;
    }
    if (maxLength <= 1) {
      return truncateUtf16Safe("…", maxLength);
    }
    const source = output.startsWith("…\n") ? output.slice(2) : output;
    return `…\n${sliceUtf16Safe(source, Math.max(0, source.length - (maxLength - 2)))}`;
  };
  return [
    header,
    ...streams.map(
      ({ stream, output }, index) => `${stream}: ${fit(output, allocations[index] ?? 0)}`,
    ),
  ].join("\n");
}
