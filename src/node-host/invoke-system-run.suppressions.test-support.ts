import { expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ExecAsk } from "../infra/exec-approvals.js";
import type { ExecAutoReviewer } from "../infra/exec-auto-review.js";
import { formatExecCommand } from "../infra/system-run-command.js";
import type { buildSystemRunApprovalPlan } from "./invoke-system-run-plan.js";
import type { handleSystemRunInvoke } from "./invoke-system-run.js";
import type { InvokeSpies, SystemInvokeFixtureParams } from "./invoke-system-run.test.js";

type InvokeOptions = Parameters<typeof handleSystemRunInvoke>[0];
type LocalParams = Omit<SystemInvokeFixtureParams, "preferMacAppExecHost">;
type SuppressionTestHarness = {
  runLocalSystemInvoke: (params: LocalParams) => Promise<InvokeSpies>;
  runLocalSystemInvokeWithPolicy: (
    security: "full" | "allowlist",
    ask: ExecAsk,
    params: Omit<LocalParams, "security" | "ask">,
  ) => Promise<InvokeSpies>;
  expectInvokeOk: (send: InvokeSpies["sendInvokeResult"], text?: string) => void;
  expectApprovalRequiredDenied: (
    event: InvokeSpies["sendNodeEvent"],
    result: InvokeSpies["sendInvokeResult"],
  ) => void;
  expectInvokeErrorMessage: (send: InvokeSpies["sendInvokeResult"], message: string) => void;
  createFixtureDir: (prefix: string) => string;
  createTempExecutable: (dir: string, name: string) => string;
  createLocalRunResult: (stdout?: string) => Awaited<ReturnType<InvokeOptions["runCommand"]>>;
  buildCwdApprovalPlan: (
    command: string[],
    cwd: string,
  ) => ReturnType<typeof buildSystemRunApprovalPlan>;
  resolveProductionExecSecurity: InvokeOptions["resolveExecSecurity"];
  resolveProductionExecAsk: InvokeOptions["resolveExecAsk"];
};

/** Keeps suppression coverage on the suite-owned isolated state and invocation fixture. */
export function registerSystemRunSuppressionTests(harness: SuppressionTestHarness) {
  const {
    runLocalSystemInvokeWithPolicy,
    expectInvokeOk,
    expectApprovalRequiredDenied,
    createFixtureDir,
    createTempExecutable,
    createLocalRunResult,
    buildCwdApprovalPlan,
    runLocalSystemInvoke,
    resolveProductionExecSecurity,
    resolveProductionExecAsk,
    expectInvokeErrorMessage,
  } = harness;
  it.each([
    ["rg", "security.audit.suppressions", "src"],
    ["rg", "security.audit.suppressions; $(touch output)", "src"],
    ["sh", "-c", "rg 'security.audit.suppressions' src | head -n 10"],
    ["/bin/sh", "-lc", "rg security.audit.suppressions src"],
  ])("allows a suppression inspection through system.run: %j", async (...command) => {
    const invoke = await runLocalSystemInvokeWithPolicy("full", "on-miss", {
      command,
      rawCommand: formatExecCommand(command),
    });

    expect(invoke.runCommand).toHaveBeenCalledTimes(1);
    expectInvokeOk(invoke.sendInvokeResult, "local-ok");
  });

  it.each([
    ["openclaw", "config", "set", "security.audit.suppressions", "[]"],
    ["sh", "-c", "rg security.audit.suppressions src > openclaw.json"],
    ["sh", "-c", "rg security.audit.suppressions src | tee openclaw.json"],
    ["rg", "--pre", "./write-config", "security.audit.suppressions", "src"],
    ["sh", "-c", 'openclaw config set "$1" "[]"', "_", "security.audit.suppressions"],
    ["env", "RIPGREP_CONFIG_PATH=local-config", "sh", "-c", "rg security.audit.suppressions src"],
  ])("keeps suppression mutations gated through system.run: %j", async (...command) => {
    const invoke = await runLocalSystemInvokeWithPolicy("full", "on-miss", { command });

    expect(invoke.runCommand).not.toHaveBeenCalled();
    expectApprovalRequiredDenied(invoke.sendNodeEvent, invoke.sendInvokeResult);
  });

  it.each([
    { security: "allowlist", ask: "on-miss" },
    { security: "full", ask: "always" },
  ] as const)(
    "preserves node $security/$ask policy for suppression reads",
    async ({ security, ask }) => {
      const invoke = await runLocalSystemInvokeWithPolicy(security, ask, {
        command: ["rg", "security.audit.suppressions", "src"],
      });

      expect(invoke.runCommand).not.toHaveBeenCalled();
      expectApprovalRequiredDenied(invoke.sendNodeEvent, invoke.sendInvokeResult);
    },
  );

  it("does not auto-review direct system.run security audit suppression edits", async () => {
    const tmp = createFixtureDir("openclaw-system-run-auto-review-suppression-");
    const executablePath = createTempExecutable(tmp, "openclaw");
    setRuntimeConfigSnapshot({
      tools: {
        exec: {
          mode: "auto",
        },
      },
    });
    try {
      const autoReviewer = vi.fn<ExecAutoReviewer>(() => ({
        decision: "allow-once",
        rationale: "test reviewer would allow it",
        risk: "low",
      }));
      const runCommand = vi.fn(async () => createLocalRunResult("should-not-run"));
      const prepared = buildCwdApprovalPlan(
        [executablePath, "config", "set", "security.audit.suppressions", "[]"],
        tmp,
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) {
        throw new Error(prepared.message);
      }
      const invoke = await runLocalSystemInvoke({
        command: prepared.plan.argv,
        cwd: prepared.plan.cwd ?? tmp,
        systemRunPlan: prepared.plan,
        runCommand,
        resolveExecSecurity: resolveProductionExecSecurity,
        resolveExecAsk: resolveProductionExecAsk,
        autoReviewer,
      });

      expect(autoReviewer).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
      expectInvokeErrorMessage(invoke.sendInvokeResult, "SYSTEM_RUN_DENIED: approval required");
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });
}
