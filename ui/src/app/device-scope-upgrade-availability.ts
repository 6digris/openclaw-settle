import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import { isGatewayMethodAdvertised } from "../lib/gateway-methods.ts";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";
import { hasOperatorAdminAccess, hasOperatorReadAccess } from "./operator-access.ts";

export type ScopeUpgradeState =
  | { phase: "hidden" }
  | { phase: "guidance" }
  | { phase: "available" }
  | { phase: "requesting" }
  | { phase: "pending"; requestId: string }
  | { phase: "rejected"; requestId: string; expired: boolean }
  | { phase: "error"; message: string; retryable: boolean };

export function readScopeUpgradeAvailability(
  snapshot: ApplicationGatewaySnapshot,
): ScopeUpgradeState {
  const auth = snapshot.hello?.auth;
  if (
    snapshot.phase !== "connected" ||
    auth?.scopes === undefined ||
    hasOperatorAdminAccess(auth) ||
    (!hasOperatorReadAccess(auth) &&
      roleScopesAllow({
        role: auth.role,
        requestedScopes: ["operator.sessions.read"],
        allowedScopes: auth.scopes,
      }))
  ) {
    return { phase: "hidden" };
  }
  return isGatewayMethodAdvertised(snapshot, "device.scopes.requestUpgrade") === true &&
    isGatewayMethodAdvertised(snapshot, "device.scopes.waitUpgrade") === true &&
    snapshot.client?.scopeUpgradeReady === true
    ? { phase: "available" }
    : { phase: "guidance" };
}
