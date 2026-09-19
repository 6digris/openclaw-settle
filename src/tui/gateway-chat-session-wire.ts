import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import type { SessionWireHistory } from "../cli/session-target.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import {
  normalizeAgentIdStrict,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import type { TuiSessionList } from "./tui-backend.js";

export function isLegacyPreserveSideRunsError(err: unknown): boolean {
  if (!(err instanceof GatewayClientRequestError) || err.gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  const message = err.message.toLowerCase();
  return message.includes("invalid chat.abort params") && message.includes("preservesideruns");
}

export function isLegacySucceedsParentError(err: unknown): boolean {
  if (!(err instanceof GatewayClientRequestError) || err.gatewayCode !== "INVALID_REQUEST") {
    return false;
  }
  const message = err.message.toLowerCase();
  return message.includes("invalid sessions.create params") && message.includes("succeedsparent");
}

export type HandoffSessionResolveParams = Required<
  Pick<SessionsResolveParams, "key" | "agentId" | "includeGlobal" | "allowMissing">
>;

export type TuiSessionWireHistory = SessionWireHistory & {
  sessionInfo?: TuiSessionList["sessions"][number] & { agentId?: string };
};

export const SESSION_REQUEST_KEY_FIELDS: Record<string, readonly string[]> = {
  "chat.send": ["sessionKey"],
  "chat.abort": ["sessionKey"],
  "chat.history": ["sessionKey"],
  "artifacts.download": ["sessionKey"],
  "assistant.media.get": ["sessionKey"],
  "sessions.describe": ["key"],
  "sessions.resolve": ["key"],
  "sessions.patch": ["key"],
  "sessions.reset": ["key"],
  "sessions.create": ["key", "parentSessionKey"],
};

export function qualifySessionResult<T extends { key?: string; agentId?: string }>(
  result: T,
  requestOwner?: string,
): T {
  if (!result.key || parseAgentSessionKey(result.key)) {
    return result;
  }
  const owner = normalizeAgentIdStrict(result.agentId ?? requestOwner);
  if (!owner.ok) {
    throw new Error("Gateway returned an unqualified session without its owner.");
  }
  return {
    ...result,
    key: toAgentStoreSessionKey({ agentId: owner.value, requestKey: result.key }),
  };
}
