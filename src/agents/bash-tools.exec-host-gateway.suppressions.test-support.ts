import { expect, it } from "vitest";
import { evaluateShellAllowlistWithAuthorization as evaluateRealShellAllowlist } from "../infra/exec-approvals-allowlist.js";
import { requiresExecApproval as realRequiresExecApproval } from "../infra/exec-approvals-policy.js";
import type { GatewaySuppressionTestHarness } from "./bash-tools.exec-host-gateway.test.js";

/** Reuses the gateway suite fixture and real parser at the suppression boundary. */
export function registerGatewaySuppressionTests(harness: GatewaySuppressionTestHarness) {
  const {
    evaluateShellAllowlistWithAuthorizationMock,
    requiresExecApprovalMock,
    resolveExecHostApprovalContextMock,
    hasDurableExecApprovalMock,
    createAndRegisterDefaultExecApprovalRequestMock,
    defaultExecAutoReviewerMock,
    runGatewayAllowlist,
  } = harness;
  it("requires approval for security audit suppression edits unless yolo mode is active", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command: "openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.deniedResult?.details.status).toBe("failed");
  });

  it("keeps security audit suppression edits off the auto-review path", async () => {
    const warnings: string[] = [];
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command: "openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "on-miss",
      autoReview: true,
      warnings,
    });

    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(warnings[0]).toContain("explicit approval");
    expect(result.deniedResult?.details.status).toBe("failed");
  });

  it("does not require approval for security audit suppression edits in yolo mode", async () => {
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "off",
      askFallback: "deny",
    });

    await runGatewayAllowlist({
      command: "openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "off",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    "rg 'security.audit.suppressions' src",
    "grep -R 'security.audit.suppressions' src",
    "cat docs/security.audit.suppressions.md",
    "rg -n 'security.audit.suppressions' src | head -n 10",
  ])("does not request suppression approval for a parsed read: %s", async (command) => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue(
      await evaluateRealShellAllowlist({ command, allowlist: [], safeBins: new Set() }),
    );
    requiresExecApprovalMock.mockImplementation(realRequiresExecApproval);
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    const warnings: string[] = [];
    const result = await runGatewayAllowlist({
      command,
      security: "full",
      ask: "on-miss",
      warnings,
    });

    expect(warnings).not.toContainEqual(expect.stringContaining("suppression changes"));
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expect(result.deniedResult).toBeUndefined();
  });

  it.each([
    "rg security.audit.suppressions src; openclaw config set security.audit.suppressions '[]'",
    "rg security.audit.suppressions src | tee openclaw.json",
    "rg --pre ./write-config security.audit.suppressions src",
    "openclaw config get security.audit.suppressions; touch output",
  ])("requires explicit approval for a parsed suppression write: %s", async (command) => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue(
      await evaluateRealShellAllowlist({ command, allowlist: [], safeBins: new Set() }),
    );
    requiresExecApprovalMock.mockImplementation(realRequiresExecApproval);
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    const result = await runGatewayAllowlist({
      command,
      security: "full",
      ask: "on-miss",
      autoReview: true,
    });

    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ requiresAutoReviewHumanApproval: true }),
    );
    expect(result.deniedResult?.details.status).toBe("failed");
  });

  it("does not execute a suppression search redirected into a config file", async () => {
    const command = "rg security.audit.suppressions src > openclaw.json";
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue(
      await evaluateRealShellAllowlist({ command, allowlist: [], safeBins: new Set() }),
    );
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });
    const result = await runGatewayAllowlist({
      command,
      security: "full",
      ask: "on-miss",
      autoReview: true,
    });

    expect(defaultExecAutoReviewerMock).not.toHaveBeenCalled();
    expect(result.deniedResult?.details.status).toBe("failed");
    expect(result.deniedResult?.content[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("approval cannot safely bind this command"),
      }),
    );
  });

  it.each([
    { security: "allowlist", ask: "on-miss" },
    { security: "full", ask: "always" },
  ] as const)(
    "preserves ordinary $security/$ask approval for a suppression read",
    async ({ security, ask }) => {
      const command = "rg security.audit.suppressions src";
      evaluateShellAllowlistWithAuthorizationMock.mockReturnValue(
        await evaluateRealShellAllowlist({ command, allowlist: [], safeBins: new Set() }),
      );
      hasDurableExecApprovalMock.mockReturnValue(false);
      requiresExecApprovalMock.mockImplementation(realRequiresExecApproval);
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: security,
        hostAsk: ask,
        askFallback: "deny",
      });
      const warnings: string[] = [];
      const result = await runGatewayAllowlist({ command, security, ask, warnings });

      expect(warnings).not.toContainEqual(expect.stringContaining("suppression changes"));
      expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
      expect(result.deniedResult?.details.status).toBe("failed");
    },
  );

  it("does not require suppression edit approval for read-only suppression inspection", async () => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue(
      await evaluateRealShellAllowlist({
        command: "openclaw config get security.audit.suppressions",
        allowlist: [],
        safeBins: new Set(),
      }),
    );
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    await runGatewayAllowlist({
      command: "openclaw config get security.audit.suppressions",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
  });

  it("does not require suppression edit approval for profile-scoped read-only inspection", async () => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue(
      await evaluateRealShellAllowlist({
        command: "openclaw --profile rescue config get security.audit.suppressions",
        allowlist: [],
        safeBins: new Set(),
      }),
    );
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    await runGatewayAllowlist({
      command: "openclaw --profile rescue config get security.audit.suppressions",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
  });

  it("requires suppression edit approval when a mutating segment follows read-only inspection", async () => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: true,
      segments: [
        { resolution: null, argv: ["openclaw", "config", "get", "security.audit.suppressions"] },
        {
          resolution: null,
          argv: ["openclaw", "config", "set", "security.audit.suppressions", "[]"],
        },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command:
        "openclaw config get security.audit.suppressions; openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.deniedResult?.details.status).toBe("failed");
  });

  it("requires suppression edit approval when allowlist analysis only returns a read-only prefix", async () => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        { resolution: null, argv: ["openclaw", "config", "get", "security.audit.suppressions"] },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command:
        "openclaw config get security.audit.suppressions; openclaw config set security.audit.suppressions '[]'",
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.deniedResult?.details.status).toBe("failed");
  });

  it("requires suppression edit approval when a heredoc patch follows read-only inspection", async () => {
    evaluateShellAllowlistWithAuthorizationMock.mockReturnValue({
      allowlistMatches: [],
      analysisOk: true,
      allowlistSatisfied: false,
      segments: [
        {
          raw: "openclaw config get security.audit.suppressions",
          resolution: null,
          argv: ["openclaw", "config", "get", "security.audit.suppressions"],
        },
        {
          raw: "openclaw config patch --stdin <<'EOF'",
          resolution: null,
          argv: ["openclaw", "config", "patch", "--stdin"],
        },
      ],
      segmentAllowlistEntries: [],
    });
    resolveExecHostApprovalContextMock.mockReturnValue({
      approvals: { allowlist: [], file: { version: 1, agents: {} } },
      hostSecurity: "full",
      hostAsk: "on-miss",
      askFallback: "deny",
    });

    const result = await runGatewayAllowlist({
      command: `openclaw config get security.audit.suppressions; openclaw config patch --stdin <<'EOF'
{"security":{"audit":{"suppressions":[]}}}
EOF`,
      security: "full",
      ask: "on-miss",
    });

    expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(1);
    expect(result.deniedResult?.details.status).toBe("failed");
  });
}
