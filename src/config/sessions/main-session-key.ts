import { buildAgentMainSessionKey } from "../../routing/session-key.js";
import type { SessionScope } from "./types.js";

/** Resolves the configured main session identity for one agent and session scope. */
export function resolveCanonicalMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
  sessionScope?: SessionScope;
}): string {
  return buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: params.sessionScope === "global" ? "global" : params.mainKey,
  });
}
