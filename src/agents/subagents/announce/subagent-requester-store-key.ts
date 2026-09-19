/**
 * Subagent requester store-key normalization.
 *
 * Converts raw requester session keys into the canonical registry key shape.
 */
import { canonicalizeMainSessionAlias } from "../../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveSessionAgentId } from "../../agent-scope.js";

/** Resolve the canonical store key for a subagent requester session. */
export function resolveRequesterStoreKey(
  cfg: OpenClawConfig,
  requesterSessionKey: string,
  explicitAgentId?: string,
): string {
  const raw = (requesterSessionKey ?? "").trim();
  if (!raw) {
    return raw;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: raw,
    config: cfg,
    agentId: explicitAgentId,
  });
  return canonicalizeMainSessionAlias({ cfg, agentId, sessionKey: raw });
}
