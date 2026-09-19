// Session-store key canonicalization across default agents, main aliases, and legacy keys.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  resolveSessionAgentId,
} from "../agents/agent-scope.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "./session-request-agent.js";

/** Canonicalize an opaque session key into the agent-scoped store namespace. */
export function canonicalizeSessionKeyForAgent(agentId: string, key: string): string {
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(key);
  return normalized.startsWith("agent:")
    ? toAgentStoreSessionKey({ agentId, requestKey: normalized })
    : `agent:${normalizeAgentId(agentId)}:${normalized}`;
}

// Logical unscoped keys must honor the durable fixed-store owner. The physical-store
// compatibility fallback is intentionally not used here because it can name a retired agent.
function resolveLogicalSessionStoreAgentId(cfg: OpenClawConfig, sessionKey: string): string {
  const agentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, sessionKey);
  if (agentId) {
    return agentId;
  }
  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey);
  if (persistedOwner.kind === "retired") {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: `session key "${sessionKey}"`,
      hint: `Its recorded owner "${persistedOwner.agentId}" is no longer configured. Select a configured agent explicitly.`,
    });
  }
  throw new AgentSelectionRequiredError(listAgentIds(cfg), {
    surface: `session key "${sessionKey}"`,
    hint: "Use an agent-prefixed session key or select an agent explicitly.",
  });
}

/** Resolve any incoming session key into the canonical key used in persisted session stores. */
export function resolveSessionStoreKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storeAgentId?: string;
}): string {
  const raw = normalizeOptionalString(params.sessionKey) ?? "";
  if (!raw) {
    return raw;
  }
  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    return normalizeSessionKeyPreservingOpaquePeerIds(raw);
  }

  const agentId = params.storeAgentId
    ? normalizeAgentId(params.storeAgentId)
    : resolveLogicalSessionStoreAgentId(params.cfg, raw);
  return canonicalizeMainSessionAlias({
    cfg: params.cfg,
    agentId,
    sessionKey: raw,
  });
}

/** Resolve ownership before canonicalizing an incoming alias. */
export function resolveSessionStoreAgentId(
  cfg: OpenClawConfig,
  canonicalKey: string,
  explicitAgentId?: string,
): string {
  if (explicitAgentId !== undefined) {
    return resolveSessionAgentId({
      config: cfg,
      sessionKey: canonicalKey,
      agentId: explicitAgentId,
    });
  }
  const parsed = parseAgentSessionKey(canonicalKey);
  return parsed
    ? normalizeAgentId(parsed.agentId)
    : resolveLogicalSessionStoreAgentId(cfg, canonicalKey);
}

/** Preserve raw alias ownership and validate the canonical fixed-store boundary together. */
export function resolveSessionStoreIdentity(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): { agentId: string; canonicalKey: string } {
  const raw = normalizeOptionalString(params.sessionKey) ?? "";
  const agentId = resolveSessionStoreAgentId(params.cfg, raw, params.agentId);
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: raw,
    storeAgentId: agentId,
  });
  return { agentId, canonicalKey };
}

/** Resolve a session key for lookup inside a specific agent's store. */
export function resolveStoredSessionKeyForAgentStore(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string {
  return resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    storeAgentId: params.agentId,
  });
}

/** Resolve the owner agent for a stored session key. */
export function resolveStoredSessionOwnerAgentId(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string {
  const canonicalKey = resolveStoredSessionKeyForAgentStore(params);
  return resolveSessionStoreAgentId(params.cfg, canonicalKey);
}
