import { describe, expect, it, vi } from "vitest";
import { evaluateShellAllowlistWithAuthorization } from "./exec-approvals-allowlist.js";
import { commandRequiresSecurityAuditSuppressionApproval } from "./exec-approvals-policy.js";
import { analyzeArgvCommand } from "./exec-argv-analysis.js";
import { planExecAuthorization } from "./exec-authorization-plan.js";

async function requiresApproval(
  command: string,
  env: NodeJS.ProcessEnv = { RIPGREP_CONFIG_PATH: "" },
) {
  const analysis = await evaluateShellAllowlistWithAuthorization({
    command,
    env,
    allowlist: [],
    safeBins: new Set(),
    platform: "linux",
  });
  return commandRequiresSecurityAuditSuppressionApproval({ command, env, ...analysis });
}

describe("security audit suppression exec approval", () => {
  it.each([
    "rg 'security.audit.suppressions' src",
    "rg -nF --glob '*.ts' security.audit.suppressions src",
    "rg -n -e security.audit.suppressions src | head -n 10",
    "rg --regexp=security.audit.suppressions --max-count=1 src",
    "rg -m1 security.audit.suppressions src",
    "rg -- security.audit.suppressions --pre",
    "grep -Rn security.audit.suppressions src",
    "grep --regexp security.audit.suppressions --include '*.ts' src",
    "cat docs/security.audit.suppressions.md",
    "head -n 20 docs/security.audit.suppressions.md",
    "tail -n10 docs/security.audit.suppressions.md",
    "wc -l docs/security.audit.suppressions.md",
    "sed -n '1,120p' docs/security.audit.suppressions.md",
    "cat docs/security.audit.suppressions.md && grep -n suppressions src/config.ts",
    "openclaw config get security.audit.suppressions",
    "openclaw --profile rescue config get security.audit.suppressions --json",
    "pnpm openclaw config schema security.audit.suppressions",
    "sh -c 'rg security.audit.suppressions src'",
    "rg 'security audit suppressions' src",
  ])("does not turn an inspection into a suppression edit: %s", async (command) => {
    expect(await requiresApproval(command)).toBe(false);
  });

  it.each([
    "openclaw config set security.audit.suppressions '[]'",
    "openclaw config unset security.audit.suppressions",
    "openclaw config set security '{audit:{suppressions:[]}}'",
    "rg security.audit.suppressions src; openclaw config set security.audit.suppressions '[]'",
    "rg security.audit.suppressions src && touch output",
    "rg security.audit.suppressions src || touch output",
    "rg security.audit.suppressions src\ntouch output",
    "rg security.audit.suppressions src > openclaw.json",
    "rg security.audit.suppressions src >> openclaw.json",
    "rg security.audit.suppressions src | tee openclaw.json",
    "cat security.audit.suppressions.json | openclaw config set --batch-file -",
    "openclaw config get security.audit.suppressions > openclaw.json",
    "openclaw config get security.audit.suppressions; touch output",
    "sed -i 's/security.audit.suppressions/replacement/' openclaw.json",
    "sed -n '1p' -f security.audit.suppressions",
    "sed -n 'w security.audit.suppressions' openclaw.json",
    "rg --pre ./write-config security.audit.suppressions src",
    "rg --pre=./write-config security.audit.suppressions src",
    "rg --hostname-bin ./write-config security.audit.suppressions src",
    "rg --search-zip security.audit.suppressions src",
    "rg -nz security.audit.suppressions src",
    "rg --unknown-option security.audit.suppressions src",
    "constructor security.audit.suppressions",
    "rg security.audit.suppressions *",
    "rg security.audit.suppressions $(touch output)",
    "rg security.audit.suppressions <(touch output)",
    "RIPGREP_CONFIG_PATH=local-config rg security.audit.suppressions src",
    "sh -c 'rg security.audit.suppressions src; touch output'",
    "sh -lc 'rg security.audit.suppressions src'",
    `python3 -c 'write("security.audit.suppressions")'`,
    "openclaw config get security.audit.suppressions; cat > openclaw.json <<'EOF'\n{security:{audit:{suppressions:[]}}}\nEOF",
  ])("keeps writes, mixed commands, and uncertain inspections gated: %s", async (command) => {
    expect(await requiresApproval(command)).toBe(true);
  });

  it("does not treat config-supplied ripgrep programs as plain searches", async () => {
    const env = { RIPGREP_CONFIG_PATH: "local-config" };
    expect(await requiresApproval("rg security.audit.suppressions src", env)).toBe(true);
    expect(await requiresApproval("rg --no-config security.audit.suppressions src", env)).toBe(
      false,
    );
    expect(await requiresApproval("rg -e --no-config security.audit.suppressions src", env)).toBe(
      true,
    );
    expect(await requiresApproval("rg -- security.audit.suppressions --no-config", env)).toBe(true);
  });

  it.each(["win32", "linux"] as const)(
    "uses child-process environment key semantics for direct argv on %s",
    async (platform) => {
      const commands = await Promise.all(
        [false, true].map(async (noConfig) => {
          const argv = [
            "rg",
            ...(noConfig ? ["--no-config"] : []),
            "security.audit.suppressions",
            "src",
          ];
          const command = argv.join(" ");
          const analysis = analyzeArgvCommand({ argv, platform });
          const authorizationPlan = await planExecAuthorization({ analysis, command, platform });
          return { command, segments: analysis.segments, authorizationPlan, noConfig };
        }),
      );
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      vi.stubEnv("RIPGREP_CONFIG_PATH", "");
      try {
        for (const { noConfig, ...command } of commands) {
          expect(
            commandRequiresSecurityAuditSuppressionApproval({
              ...command,
              env: { Ripgrep_Config_Path: "local-config" },
            }),
          ).toBe(platform === "win32" && !noConfig);
          // Node keeps the lexicographically first Windows alias, including an
          // explicitly empty value; do not mistake the later alias for authority.
          expect(
            commandRequiresSecurityAuditSuppressionApproval({
              ...command,
              env: { RIPGREP_CONFIG_PATH: "", Ripgrep_Config_Path: "local-config" },
            }),
          ).toBe(false);
        }
      } finally {
        platformSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("requires a complete plan bound to this exact command, not diagnostic segments", async () => {
    const command = "rg security.audit.suppressions src";
    const analysis = await evaluateShellAllowlistWithAuthorization({
      command,
      allowlist: [],
      safeBins: new Set(),
      platform: "linux",
    });
    expect(
      commandRequiresSecurityAuditSuppressionApproval({ command, segments: analysis.segments }),
    ).toBe(true);
    expect(
      commandRequiresSecurityAuditSuppressionApproval({
        ...analysis,
        command: command + "; touch output",
      }),
    ).toBe(true);
  });

  it("leaves unrelated commands to ordinary execution policy", async () => {
    expect(await requiresApproval("touch output")).toBe(false);
  });
});
