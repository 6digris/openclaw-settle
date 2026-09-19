import type { insertOperatorApproval } from "./operator-approval-store.js";

type NewOperatorApproval = Parameters<typeof insertOperatorApproval>[0]["approval"];

export function approval(
  id: string,
  overrides: Partial<NewOperatorApproval> = {},
): NewOperatorApproval {
  const kind = overrides.kind ?? overrides.presentation?.kind ?? "exec";
  const presentation: NewOperatorApproval["presentation"] =
    overrides.presentation ??
    (kind === "exec"
      ? {
          kind: "exec" as const,
          commandText: `echo ${id}`,
          commandPreview: `echo ${id}`,
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        }
      : {
          kind: "plugin" as const,
          title: "Approve plugin action",
          description: `Allow the plugin action for ${id}.`,
          severity: "warning" as const,
          pluginId: "test-plugin",
          toolName: "test-tool",
          agentId: "main",
          allowedDecisions: ["allow-once", "allow-always", "deny"],
        });
  return {
    id,
    kind,
    presentation,
    requester: {
      deviceId: "request-device",
      clientId: "request-client",
      deviceTokenAuth: true,
    },
    reviewerDeviceIds: ["reviewer-b", "reviewer-a", "reviewer-b"],
    source: {
      agentId: "main",
      sessionKey: "agent:main:child",
      sessionId: "session-1",
      runId: "run-1",
      toolCallId: "tool-call-1",
      toolName: "exec",
    },
    audienceSessionKeys: ["agent:main:child", "agent:main:parent"],
    runtimeEpoch: "runtime-a",
    createdAtMs: 1_000,
    expiresAtMs: 10_000,
    ...overrides,
  };
}
