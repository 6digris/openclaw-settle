import type { OperatorScope } from "../../../src/gateway/operator-scopes.js";
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import { resolveBaseSessionMutationRequiredScope } from "../../../src/shared/session-method-scopes-base.js";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";
import { hasOperatorWriteAccess } from "../app/operator-access.ts";
import { t } from "../i18n/index.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";

type SessionMethodOperatorScope = OperatorScope;
type SessionAccessRow = Pick<GatewaySessionRow, "sharingRole">;

export type SessionMethodAccess =
  | { allowed: true; requiredScope: SessionMethodOperatorScope }
  | {
      allowed: false;
      requiredScope: SessionMethodOperatorScope;
      reason: string;
      cause: "disconnected" | "method-unavailable" | "missing-scope" | "session-view-only";
    };

export type SessionMethodAccessRequest = {
  method: string;
  params?: unknown;
  requiredScope?: SessionMethodOperatorScope;
  session?: SessionAccessRow;
};

export function sessionAccessRowForBatch(rows: readonly SessionAccessRow[]) {
  return (
    rows.find((row) => row.sharingRole === "viewer") ??
    rows.find((row) => row.sharingRole !== "owner" && row.sharingRole !== "admin") ??
    rows[0]
  );
}

function sessionMethodAccessReason(
  cause: Exclude<SessionMethodAccess, { allowed: true }>["cause"],
  requiredScope: SessionMethodOperatorScope,
): string {
  if (cause === "disconnected") {
    return t("sessionsView.actionRequiresConnection");
  }
  if (cause === "method-unavailable") {
    return t("sessionsView.actionUnavailable");
  }
  if (cause === "session-view-only") {
    return t("chat.sessionSharing.readOnlyNotice");
  }
  return t(
    requiredScope === "operator.admin"
      ? "sessionsView.actionRequiresAdmin"
      : requiredScope === "operator.write"
        ? "sessionsView.actionRequiresWrite"
        : requiredScope === "operator.sessions.write"
          ? "sessionsView.actionRequiresSessionWrite"
          : requiredScope === "operator.sessions.read"
            ? "sessionsView.actionRequiresSessionRead"
            : "sessionsView.actionRequiresRead",
  );
}

/**
 * Uses the Gateway method policy and its projected session role, plus connection
 * and advertised-method state. Dynamic placement scopes stay with their caller.
 */
export function readSessionMethodAccess(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> | null | undefined,
  request: SessionMethodAccessRequest,
): SessionMethodAccess {
  const requiredScope =
    resolveBaseSessionMutationRequiredScope(request.method, request.params) ??
    request.requiredScope;
  if (!requiredScope) {
    throw new Error(`Missing required scope for session mutation method: ${request.method}`);
  }
  if (snapshot?.phase !== "connected" || !snapshot.client) {
    return {
      allowed: false,
      requiredScope,
      reason: sessionMethodAccessReason("disconnected", requiredScope),
      cause: "disconnected",
    };
  }
  if (isGatewayMethodAdvertised(snapshot, request.method) !== true) {
    return {
      allowed: false,
      requiredScope,
      reason: sessionMethodAccessReason("method-unavailable", requiredScope),
      cause: "method-unavailable",
    };
  }
  const auth = snapshot.hello?.auth;
  if (
    auth &&
    Array.isArray(auth.scopes) &&
    roleScopesAllow({
      role: auth.role,
      requestedScopes: [requiredScope],
      allowedScopes: auth.scopes,
    })
  ) {
    const requireOwner =
      requiredScope === "operator.sessions.write" && !hasOperatorWriteAccess(auth);
    const role = request.session?.sharingRole;
    if (
      (requireOwner && role !== "owner" && role !== "admin") ||
      (role === "viewer" &&
        requiredScope !== "operator.read" &&
        requiredScope !== "operator.sessions.read")
    ) {
      return {
        allowed: false,
        requiredScope,
        reason: requireOwner
          ? t("sessionsView.actionRequiresOwnership")
          : sessionMethodAccessReason("session-view-only", requiredScope),
        cause: "session-view-only",
      };
    }
    return { allowed: true, requiredScope };
  }
  return {
    allowed: false,
    requiredScope,
    reason: sessionMethodAccessReason("missing-scope", requiredScope),
    cause: "missing-scope",
  };
}
