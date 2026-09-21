import type { AllowAlwaysPersistenceDecision } from "./exec-approvals-contracts.js";
// Resolves exec approval requirements and approval-decision availability.
import {
  normalizeExecAsk,
  type ExecApprovalDecision,
  type ExecApprovalUnavailableDecision,
  type ExecAsk,
  type ExecSecurity,
} from "./exec-approvals-core.js";
import type { ExecAuthorizationPlan } from "./exec-authorization-plan.js";
import { hasArgumentShellExpansionSource } from "./exec-authorization-render.js";
import { parseExecArgvToken } from "./exec-command-resolution.js";
import { resolveEnvironmentValue } from "./process-env.js";

export function requiresExecApproval(params: {
  ask: ExecAsk;
  security: ExecSecurity;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  durableApprovalSatisfied?: boolean;
}): boolean {
  if (params.ask === "always") {
    return true;
  }
  if (params.durableApprovalSatisfied === true) {
    return false;
  }
  return (
    params.ask === "on-miss" &&
    params.security === "allowlist" &&
    (!params.analysisOk || !params.allowlistSatisfied)
  );
}

function normalizeCommandName(value: string | undefined): string {
  return (value ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

function textMentionsSecurityAuditSuppressions(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("security.audit.suppressions") ||
    /["']?security["']?[\s\S]{0,200}["']?audit["']?[\s\S]{0,200}["']?suppressions["']?/.test(
      normalized,
    )
  );
}

function isReadOnlySecurityAuditSuppressionInspection(argv: string[]): boolean {
  const command = normalizeCommandName(argv[0]);
  let offset = command === "pnpm" && argv[1] === "openclaw" ? 1 : 0;
  if (normalizeCommandName(argv[offset]) !== "openclaw") {
    return false;
  }
  offset += 1;
  while (offset < argv.length) {
    const arg = argv[offset];
    if (["--dev", "--no-color"].includes(arg ?? "")) {
      offset += 1;
      continue;
    }
    if (["--profile", "--container", "--log-level"].includes(arg ?? "")) {
      offset += 2;
      continue;
    }
    if (
      arg?.startsWith("--profile=") ||
      arg?.startsWith("--container=") ||
      arg?.startsWith("--log-level=")
    ) {
      offset += 1;
      continue;
    }
    break;
  }
  return (
    argv[offset] === "config" && ["get", "schema", "validate"].includes(argv[offset + 1] ?? "")
  );
}

// These are inspection semantics, not an exec allowlist. Unknown options stay
// approval-gated; in particular rg can launch programs via --pre/--hostname-bin
// or decompression. Do not infer read-only behavior from an executable grant.
const INSPECTION_OPTIONS: Readonly<Record<string, { boolean: string; value: string }>> = {
  rg: {
    boolean:
      "-n -N -l -L -i -s -S -F -w -x -v -c -q -o -H -I -a -U -u -uu -uuu --hidden --files --no-ignore --no-ignore-vcs --fixed-strings --line-number --files-with-matches --files-without-match --count --only-matching --no-heading --heading --json --no-config --no-messages --follow",
    value:
      "-e -f -g -t -T -m -A -B -C --regexp --file --glob --iglob --type --type-not --max-count --after-context --before-context --context --max-depth --encoding --color --sort --sortr",
  },
  grep: {
    boolean:
      "-E -F -G -P -i -v -w -x -z -c -l -L -n -h -H -o -q -s -r -R -a -I --extended-regexp --fixed-strings --ignore-case --invert-match --word-regexp --line-regexp --count --files-with-matches --files-without-match --line-number --no-filename --with-filename --only-matching --quiet --silent --no-messages --recursive --dereference-recursive",
    value:
      "-e -f -m -A -B -C --regexp --file --max-count --after-context --before-context --context --include --exclude --exclude-dir --binary-files --color --colour",
  },
  cat: {
    boolean:
      "-A -b -e -E -n -s -t -T -u -v --show-all --number-nonblank --show-ends --number --squeeze-blank --show-tabs --show-nonprinting",
    value: "",
  },
  head: { boolean: "-q -v --quiet --silent --verbose", value: "-n -c --lines --bytes" },
  tail: { boolean: "-q -v --quiet --silent --verbose", value: "-n -c --lines --bytes" },
  wc: { boolean: "-c -m -l -w -L --bytes --chars --lines --words --max-line-length", value: "" },
};

function isInspectionArgv(argv: string[], env?: NodeJS.ProcessEnv): boolean {
  if (isReadOnlySecurityAuditSuppressionInspection(argv)) {
    return true;
  }
  const command = normalizeCommandName(argv[0]);
  if (command === "sed") {
    // Only a print-only script followed by filenames, never -e/-f/-i or scripts
    // that can write files or launch commands.
    return (
      argv[1] === "-n" &&
      /^(\d+|\$)(,(\d+|\$))?p$/.test(argv[2] ?? "") &&
      argv.slice(3).every((arg) => !arg.startsWith("-"))
    );
  }
  const options = Object.hasOwn(INSPECTION_OPTIONS, command)
    ? INSPECTION_OPTIONS[command]
    : undefined;
  if (!options) {
    return false;
  }
  const booleanFlags = new Set(options.boolean.split(" "));
  const valueFlags = new Set(options.value.split(" "));
  let noRipgrepConfig = false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = parseExecArgvToken(argv[i] ?? "");
    if (token.kind === "terminator") {
      break;
    }
    if (token.kind !== "option") {
      continue;
    }
    if (token.style === "long") {
      if (valueFlags.has(token.flag)) {
        if (token.inlineValue === undefined && ++i >= argv.length) {
          return false;
        }
      } else if (!booleanFlags.has(token.flag) || token.inlineValue !== undefined) {
        return false;
      } else if (token.flag === "--no-config") {
        noRipgrepConfig = true;
      }
      continue;
    }
    for (const [index, flag] of token.flags.entries()) {
      if (valueFlags.has(flag)) {
        if (index === token.flags.length - 1 && ++i >= argv.length) {
          return false;
        }
        break;
      }
      if (!booleanFlags.has(flag)) {
        return false;
      }
    }
  }
  return (
    command !== "rg" ||
    noRipgrepConfig ||
    !(
      resolveEnvironmentValue(env, "RIPGREP_CONFIG_PATH") ??
      resolveEnvironmentValue(process.env, "RIPGREP_CONFIG_PATH")
    )
  );
}

function isInspectionPlan(params: {
  command: string;
  env?: NodeJS.ProcessEnv;
  authorizationPlan?: ExecAuthorizationPlan;
}): boolean {
  const plan = params.authorizationPlan;
  if (!plan?.ok || plan.originalCommand !== params.command || plan.groups.length === 0) {
    return false;
  }
  return plan.groups.every(
    (group) =>
      group.candidates.length > 0 &&
      group.candidates.every(
        (candidate) =>
          candidate.trustMode === "executable" &&
          // A print-only sed script is inline eval, but not a suppression edit.
          // The caller still enforces its independent strict-inline-eval policy.
          candidate.reasons.every((reason) => reason === "inline-eval") &&
          ((plan.dialect === "argv" && candidate.transport.kind === "direct") ||
            !hasArgumentShellExpansionSource(candidate)) &&
          isInspectionArgv(
            candidate.sourceSegment.sourceArgv ?? candidate.sourceSegment.argv,
            params.env,
          ),
      ),
  );
}

export function commandRequiresSecurityAuditSuppressionApproval(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  segments: Array<{ argv: string[]; raw?: string }>;
  authorizationPlan?: ExecAuthorizationPlan;
}): boolean {
  const mentionsSuppressions =
    textMentionsSecurityAuditSuppressions(params.command) ||
    params.segments.some((segment) =>
      textMentionsSecurityAuditSuppressions(`${segment.raw ?? ""} ${segment.argv.join(" ")}`),
    );
  // Diagnostic segments can be partial, and a read may feed a write in another
  // segment. Only the complete, command-bound authorization plan can exempt an
  // inspection. Failed/opaque plans retain the conservative explicit-review gate.
  return mentionsSuppressions && !isInspectionPlan(params);
}

export function minSecurity(a: ExecSecurity, b: ExecSecurity): ExecSecurity {
  const order: Record<ExecSecurity, number> = { deny: 0, allowlist: 1, full: 2 };
  return order[a] <= order[b] ? a : b;
}

export function maxAsk(a: ExecAsk, b: ExecAsk): ExecAsk {
  const order: Record<ExecAsk, number> = { off: 0, "on-miss": 1, always: 2 };
  return order[a] >= order[b] ? a : b;
}

export const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];
export const OPTIONAL_EXEC_APPROVAL_DECISIONS = [
  "allow-always",
] as const satisfies readonly ExecApprovalDecision[];
const OPTIONAL_EXEC_APPROVAL_DECISION_SET: ReadonlySet<string> = new Set(
  OPTIONAL_EXEC_APPROVAL_DECISIONS,
);

function isOptionalExecApprovalDecision(
  decision: string,
): decision is ExecApprovalUnavailableDecision {
  return OPTIONAL_EXEC_APPROVAL_DECISION_SET.has(decision);
}

function collectExecApprovalUnavailableDecisionSet(
  decisions?: readonly string[] | readonly ExecApprovalUnavailableDecision[] | null,
): ReadonlySet<ExecApprovalUnavailableDecision> {
  const unavailable = new Set<ExecApprovalUnavailableDecision>();
  if (!Array.isArray(decisions)) {
    return unavailable;
  }
  for (const decision of decisions) {
    if (isOptionalExecApprovalDecision(decision)) {
      unavailable.add(decision);
    }
  }
  return unavailable;
}

export function normalizeExecApprovalUnavailableDecisions(
  decisions?: readonly string[] | readonly ExecApprovalUnavailableDecision[] | null,
): readonly ExecApprovalUnavailableDecision[] {
  const unavailable = collectExecApprovalUnavailableDecisionSet(decisions);
  return OPTIONAL_EXEC_APPROVAL_DECISIONS.filter((decision) => unavailable.has(decision));
}

export function resolveExecApprovalAllowedDecisions(params?: {
  ask?: string | null;
  allowAlwaysPersistence?: AllowAlwaysPersistenceDecision | null;
}): readonly ExecApprovalDecision[] {
  const ask = normalizeExecAsk(params?.ask);
  if (ask === "always" || params?.allowAlwaysPersistence?.kind === "one-shot") {
    return ["allow-once", "deny"];
  }
  return DEFAULT_EXEC_APPROVAL_DECISIONS;
}

export function resolveExecApprovalUnavailableDecisions(params?: {
  ask?: string | null;
  allowAlwaysPersistence?: AllowAlwaysPersistenceDecision | null;
}): readonly ExecApprovalUnavailableDecision[] {
  const allowed = new Set(resolveExecApprovalAllowedDecisions(params));
  return OPTIONAL_EXEC_APPROVAL_DECISIONS.filter((decision) => !allowed.has(decision));
}

export function resolveExecApprovalRequestAllowedDecisions(params?: {
  ask?: string | null;
  unavailableDecisions?: readonly ExecApprovalUnavailableDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const policyDecisions = resolveExecApprovalAllowedDecisions({ ask: params?.ask });
  const unavailableDecisions = collectExecApprovalUnavailableDecisionSet(
    params?.unavailableDecisions,
  );
  if (unavailableDecisions.size === 0) {
    return policyDecisions;
  }
  return policyDecisions.filter(
    (decision) => !isOptionalExecApprovalDecision(decision) || !unavailableDecisions.has(decision),
  );
}

export function isExecApprovalDecisionAllowed(params: {
  decision: ExecApprovalDecision;
  ask?: string | null;
}): boolean {
  return resolveExecApprovalAllowedDecisions({ ask: params.ask }).includes(params.decision);
}
