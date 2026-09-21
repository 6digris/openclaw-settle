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
      cause: "disconnected" | "method-unavailable" | "missing-scope" | "session-not-owned";
    };

export type SessionMethodAccessRequest = {
  method: string;
  params?: unknown;
  requiredScope?: SessionMethodOperatorScope;
  session?: SessionAccessRow;
};

export function sessionAccessRowForBatch(rows: readonly SessionAccessRow[]) {
  return rows.find((row) => row.sharingRole !== "owner" && row.sharingRole !== "admin") ?? rows[0];
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
    throw new Error(`Missing session method scope: ${request.method}`);
  }
  let cause: Exclude<SessionMethodAccess, { allowed: true }>["cause"] = "missing-scope";
  if (snapshot?.phase !== "connected" || !snapshot.client) {
    cause = "disconnected";
  } else if (isGatewayMethodAdvertised(snapshot, request.method) !== true) {
    cause = "method-unavailable";
  } else {
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
      const role = request.session?.sharingRole;
      if (
        requiredScope !== "operator.sessions.write" ||
        hasOperatorWriteAccess(auth) ||
        role === "owner" ||
        role === "admin"
      ) {
        return { allowed: true, requiredScope };
      }
      cause = "session-not-owned";
    }
  }
  return {
    allowed: false,
    requiredScope,
    reason: t(
      cause === "disconnected"
        ? "sessionsView.actionRequiresConnection"
        : cause === "method-unavailable"
          ? "sessionsView.actionUnavailable"
          : cause === "session-not-owned"
            ? "sessionsView.actionRequiresOwnership"
            : "sessionsView.actionRequiresScope",
      { scope: requiredScope },
    ),
    cause,
  };
}
