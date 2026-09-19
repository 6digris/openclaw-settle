import {
  ErrorCodes,
  type ErrorShape,
  type SessionsListParams,
  errorShape,
} from "../../packages/gateway-protocol/src/index.js";
import {
  AgentSelectionRequiredError,
  listAgentIds,
  tryResolveSoleAgentId,
} from "../agents/agent-scope.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  classifySessionKeyShape,
  normalizeAgentId,
  normalizeAgentIdStrict,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";

type RequestedSessionAgentIdResolution =
  | { ok: true; agentId: string }
  | { ok: false; error: ErrorShape };

function admitRequestedAgent(agentId: string): RequestedSessionAgentIdResolution {
  const refusal = readAgentDatabaseAdmissionRefusal(agentId);
  return refusal
    ? {
        ok: false,
        error: errorShape(ErrorCodes.UNAVAILABLE, `${refusal.reason}\n${refusal.repairHint}`, {
          details: refusal,
        }),
      }
    : { ok: true, agentId };
}

export type SessionEventAgentScope = { agentId: string; sessionKey: string };

/** Bind retained unqualified events to their recorded owner before publication. */
export function resolveSessionEventAgentScope(
  cfg: OpenClawConfig,
  key: string,
  explicitAgentId?: string,
): SessionEventAgentScope | null {
  if (classifySessionKeyShape(key) === "malformed_agent") {
    return null;
  }
  const parsed = parseAgentSessionKey(key.trim());
  const keyAgentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : undefined;
  const explicit = explicitAgentId === undefined ? null : normalizeAgentIdStrict(explicitAgentId);
  if (explicit !== null && !explicit.ok) {
    return null;
  }
  if (explicit?.value && keyAgentId && explicit.value !== keyAgentId) {
    return null;
  }
  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(cfg, key);
  const agentId =
    explicit?.value ??
    keyAgentId ??
    (persistedOwner.kind !== "none" ? persistedOwner.agentId : undefined) ??
    tryResolveSessionCompatibilityOwnerAgentId(cfg, key);
  return agentId
    ? {
        agentId,
        sessionKey: parsed
          ? normalizeSessionKeyPreservingOpaquePeerIds(key)
          : canonicalizeMainSessionAlias({ cfg, sessionKey: key, agentId }),
      }
    : null;
}

/** Resolves only stable implicit ownership for unscoped session rows and active runs. */
export function tryResolveSessionCompatibilityOwnerAgentId(
  cfg: OpenClawConfig,
  key: string | undefined,
): string | undefined {
  if (classifySessionKeyShape(key) === "malformed_agent") {
    return undefined;
  }
  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, key);
  if (persistedStoreOwner.kind === "configured") {
    return persistedStoreOwner.agentId;
  }
  return persistedStoreOwner.kind === "retired"
    ? undefined
    : (tryResolveLegacyCompatibilityAgentId(cfg) ?? tryResolveSoleAgentId(cfg));
}

// An absent key selects an agent before a session exists; a synthetic main key
// would incorrectly admit a fixed global target instead of a fresh child.
export function resolveRequestedSessionAgentId(
  cfg: OpenClawConfig,
  key: string | undefined,
  explicitAgentId?: string,
): RequestedSessionAgentIdResolution {
  if (classifySessionKeyShape(key) === "malformed_agent") {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "Malformed agent session key."),
    };
  }
  const parsed = parseAgentSessionKey(key?.trim());
  const configuredAgentIds = listAgentIds(cfg);
  const normalizedRequest =
    explicitAgentId === undefined ? null : normalizeAgentIdStrict(explicitAgentId);
  if (normalizedRequest && !normalizedRequest.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${explicitAgentId}"`),
    };
  }
  const normalizedRequestedAgentId = normalizedRequest?.value;
  if (normalizedRequestedAgentId && !configuredAgentIds.includes(normalizedRequestedAgentId)) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${explicitAgentId}"`),
    };
  }
  if (parsed?.agentId) {
    const keyAgentId = normalizeAgentId(parsed.agentId);
    if (normalizedRequestedAgentId && keyAgentId !== normalizedRequestedAgentId) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `agent "${explicitAgentId}" does not match session key agent "${keyAgentId}"`,
        ),
      };
    }
    return admitRequestedAgent(keyAgentId);
  }

  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, key);
  if (persistedStoreOwner.kind === "retired") {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `session key belongs to retired agent "${persistedStoreOwner.agentId}"`,
      ),
    };
  }
  if (normalizedRequestedAgentId) {
    if (
      persistedStoreOwner.kind === "configured" &&
      persistedStoreOwner.agentId !== normalizedRequestedAgentId
    ) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `agent "${explicitAgentId}" does not match session key agent "${persistedStoreOwner.agentId}"`,
        ),
      };
    }
    return admitRequestedAgent(normalizedRequestedAgentId);
  }
  const inferredAgentId = tryResolveSessionCompatibilityOwnerAgentId(cfg, key);
  if (inferredAgentId) {
    return admitRequestedAgent(inferredAgentId);
  }
  const selectionError = new AgentSelectionRequiredError(configuredAgentIds, {
    surface: `session key "${key}"`,
    hint: "Pass agentId or use an agent-prefixed session key.",
  });
  return {
    ok: false,
    error: errorShape(ErrorCodes.INVALID_REQUEST, selectionError.message),
  };
}

/** Admit child filters without borrowing their agent for the parent selector. */
export function resolveRequestedSessionListScope<
  T extends Pick<SessionsListParams, "agentId" | "spawnedBy">,
>(cfg: OpenClawConfig, scope: T) {
  const agent = scope.agentId === undefined ? null : normalizeAgentIdStrict(scope.agentId);
  if (agent && !agent.ok) {
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `Unknown agent id "${scope.agentId}"`),
    };
  }
  let spawnedBy = scope.spawnedBy;
  if (spawnedBy !== undefined) {
    const parent = resolveRequestedSessionAgentId(cfg, spawnedBy);
    if (!parent.ok) {
      return parent;
    }
    spawnedBy = canonicalizeMainSessionAlias({
      cfg,
      agentId: parent.agentId,
      sessionKey: spawnedBy,
    });
  }
  return { ok: true as const, scope: { ...scope, agentId: agent?.value, spawnedBy } };
}
