import { expect, it } from "vitest";
import { evaluateShellAllowlistWithAuthorization as evaluateRealShellAllowlist } from "../infra/exec-approvals-allowlist.js";
import { commandRequiresSecurityAuditSuppressionApproval as realSuppressionApproval } from "../infra/exec-approvals-policy.js";
import type {
  NodeSuppressionTestHarness,
  MockAllowlistResult,
} from "./bash-tools.exec-host-node.test.js";

/** Reuses the remote-node fixture without booting another Gateway. */
export function registerNodeSuppressionTests(harness: NodeSuppressionTestHarness) {
  const {
    parsePreparedSystemRunPayloadMock,
    evaluateShellAllowlistMock,
    commandRequiresSecurityAuditSuppressionApprovalMock,
    requiresExecApprovalMock,
    resolveExecHostApprovalContextMock,
    createAndRegisterDefaultExecApprovalRequestMock,
    executeNodeHostCommand,
    createNodeHostRequest,
    expectSystemRunInvoke,
    createAllowlistOnMissContext,
  } = harness;
  it.each([
    { command: "rg security.audit.suppressions src", approval: false },
    { command: "rg security.audit.suppressions src | head -n 10", approval: false },
    { command: "rg security.audit.suppressions src | tee openclaw.json", approval: true },
  ])(
    "uses the real suppression policy before node dispatch: $command",
    async ({ command, approval }) => {
      const wrapperCommand = `/bin/sh -lc "${command}"`;
      parsePreparedSystemRunPayloadMock.mockReturnValue({
        plan: {
          argv: ["/bin/sh", "-lc", command],
          cwd: "/tmp/work",
          commandText: wrapperCommand,
          commandPreview: command,
          agentId: "prepared-agent",
          sessionKey: "prepared-session",
        },
        execPolicy: { security: "full", ask: "on-miss" },
      });
      const evaluations = new Map<string, MockAllowlistResult>();
      for (const text of [command, wrapperCommand]) {
        evaluations.set(
          text,
          await evaluateRealShellAllowlist({ command: text, allowlist: [], safeBins: new Set() }),
        );
      }
      evaluateShellAllowlistMock.mockImplementation((params) => {
        const result = evaluations.get(params?.command ?? "");
        if (!result) {
          throw new Error("Unexpected command analysis");
        }
        return result;
      });
      commandRequiresSecurityAuditSuppressionApprovalMock.mockImplementation(
        realSuppressionApproval,
      );
      requiresExecApprovalMock.mockReturnValue(false);
      resolveExecHostApprovalContextMock.mockReturnValue({
        approvals: { allowlist: [], file: { version: 1, agents: {} } },
        hostSecurity: "full",
        hostAsk: "on-miss",
        askFallback: "deny",
      });

      await executeNodeHostCommand(
        createNodeHostRequest({ command, security: "full", ask: "on-miss" }),
      );

      expect(createAndRegisterDefaultExecApprovalRequestMock).toHaveBeenCalledTimes(
        approval ? 1 : 0,
      );
      expect(commandRequiresSecurityAuditSuppressionApprovalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command,
          authorizationPlan: evaluations.get(command)?.authorizationPlan,
        }),
      );
    },
  );

  it("does not treat read-only suppression inspections as wrapper writes", async () => {
    const wrapperPlan = {
      argv: ["/bin/sh", "-lc", "openclaw config get security.audit.suppressions"],
      cwd: "/tmp/work",
      commandText: `/bin/sh -lc "openclaw config get security.audit.suppressions"`,
      commandPreview: "openclaw config get security.audit.suppressions",
      agentId: "prepared-agent",
      sessionKey: "prepared-session",
    };
    parsePreparedSystemRunPayloadMock.mockReturnValue({
      plan: wrapperPlan,
      execPolicy: { security: "full", ask: "off" },
    });
    evaluateShellAllowlistMock.mockImplementation((params?: { command?: string }) => {
      const command = params?.command ?? "";
      return {
        allowlistMatches: [],
        analysisOk: true,
        allowlistSatisfied: true,
        segments: [
          command.startsWith("/bin/sh")
            ? {
                resolution: null,
                argv: ["/bin/sh", "-lc", "openclaw config get security.audit.suppressions"],
                raw: `/bin/sh -lc "openclaw config get security.audit.suppressions"`,
              }
            : {
                resolution: null,
                argv: ["openclaw", "config", "get", "security.audit.suppressions"],
                raw: "openclaw config get security.audit.suppressions",
              },
        ],
        segmentAllowlistEntries: [],
      };
    });
    commandRequiresSecurityAuditSuppressionApprovalMock.mockImplementation(
      (params?: { command?: string }) => params?.command?.startsWith("/bin/sh") === true,
    );
    requiresExecApprovalMock.mockReturnValue(false);
    resolveExecHostApprovalContextMock.mockReturnValue(createAllowlistOnMissContext());

    const result = await executeNodeHostCommand(
      createNodeHostRequest({
        command: "openclaw config get security.audit.suppressions",
        security: "allowlist",
        ask: "on-miss",
        autoReview: true,
      }),
    );

    expect(result.details?.status).toBe("completed");
    expect(createAndRegisterDefaultExecApprovalRequestMock).not.toHaveBeenCalled();
    expectSystemRunInvoke({ invokeDeadlineMs: 35_000, invokeWaitMs: 40_000, runTimeoutMs: 30_000 });
  });
}
