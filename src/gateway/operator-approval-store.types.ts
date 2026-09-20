import type { ApprovalPresentation } from "../../packages/gateway-protocol/src/schema/approvals.js";

export type OperatorApprovalKind = "exec" | "plugin" | "system-agent";
export type OperatorApprovalStatus = "pending" | "allowed" | "denied" | "expired" | "cancelled";
export type OperatorApprovalDecision = "allow-once" | "allow-always" | "deny";
export type OperatorApprovalTerminalReason =
  | "user"
  | "timeout"
  | "malformed-verdict"
  | "no-route"
  | "run-aborted"
  | "gateway-restart"
  | "storage-corrupt";
export type OperatorApprovalResolverKind = "device" | "channel" | "runtime" | "system";
export type OperatorApprovalRequester = {
  deviceId: string | null;
  clientId: string | null;
  deviceTokenAuth: boolean;
};

export type OperatorApprovalSource = {
  agentId: string | null;
  sessionKey: string | null;
  sessionId: string | null;
  runId: string | null;
  toolCallId: string | null;
  toolName: string | null;
};

export type OperatorApprovalResolver = {
  kind: OperatorApprovalResolverKind;
  id: string | null;
};

export type OperatorApprovalRecord = {
  id: string;
  resolutionRef: string;
  kind: OperatorApprovalKind;
  status: OperatorApprovalStatus;
  presentation: ApprovalPresentation;
  requester: OperatorApprovalRequester;
  reviewerDeviceIds: string[];
  source: OperatorApprovalSource;
  audienceSessionKeys: string[];
  runtimeEpoch: string;
  createdAtMs: number;
  expiresAtMs: number;
  updatedAtMs: number;
  decision: OperatorApprovalDecision | null;
  terminalReason: OperatorApprovalTerminalReason | null;
  resolvedAtMs: number | null;
  resolver: OperatorApprovalResolver | null;
  consumedAtMs: number | null;
  consumedBy: string | null;
};

export type GetOperatorApprovalResult =
  | { outcome: "found"; record: OperatorApprovalRecord }
  | { outcome: "not-found" }
  | { outcome: "corrupt"; id?: string };

export type ResolveOperatorApprovalResult =
  | { outcome: "resolved"; record: OperatorApprovalRecord }
  | { outcome: "expired"; record: OperatorApprovalRecord }
  | {
      outcome: "already-resolved";
      retry: "same" | "conflict";
      record: OperatorApprovalRecord;
    }
  | { outcome: "decision-not-allowed"; record: OperatorApprovalRecord }
  | { outcome: "not-found" }
  | { outcome: "corrupt" };

export type ForceDenyOperatorApprovalResult =
  | { outcome: "denied"; record: OperatorApprovalRecord }
  | { outcome: "expired"; record: OperatorApprovalRecord }
  | { outcome: "not-due"; record: OperatorApprovalRecord }
  | { outcome: "already-terminal"; record: OperatorApprovalRecord }
  | { outcome: "not-found" }
  | { outcome: "corrupt" };

export type GetOperatorApprovalInput = {
  id: string;
  allowTransportRef?: boolean;
  nowMs?: number;
};

export type ListTerminalOperatorApprovalsInput = {
  cursor?: string;
  limit?: number;
  kind?: OperatorApprovalKind;
  nowMs?: number;
};

export type ListTerminalOperatorApprovalsResult = {
  records: OperatorApprovalRecord[];
  nextCursor?: string;
};
