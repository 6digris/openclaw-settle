import { canonicalizeSessionKeyForAgent } from "./session-store-key.js";

export function resolveSessionSubscriptionKey(sessionKey: string, agentId: string): string {
  return canonicalizeSessionKeyForAgent(agentId, sessionKey);
}

export function resolveSessionSubscriptionKeys(sessionKey: string, agentId: string): string[] {
  return [resolveSessionSubscriptionKey(sessionKey, agentId)];
}
