/**
 * Subagent spawn-depth lookup helpers.
 *
 * Reads persisted session store state to recover spawn depth and parent lineage across restarts.
 */
import { canonicalizeMainSessionAlias } from "../../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { parseAgentSessionKey } from "../../../sessions/session-key-utils.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import {
  getSubagentDepthFromEntryLookup,
  type SessionDepthEntry,
} from "./subagent-depth-policy.js";
import {
  asSessionCapabilityLookup,
  createSubagentSessionStore,
  type SessionCapabilityLookup,
  type SessionCapabilityStore,
} from "./subagent-session-store.js";

function resolveSessionLookupKey(
  rawKey: string,
  cfg?: OpenClawConfig,
  explicitAgentId?: string,
): string {
  if (!cfg || parseAgentSessionKey(rawKey)) {
    return rawKey;
  }
  const agentId = resolveSessionAgentId({
    sessionKey: rawKey,
    config: cfg,
    agentId: explicitAgentId,
  });
  return canonicalizeMainSessionAlias({ cfg, agentId, sessionKey: rawKey });
}

function resolveEntryForSessionKey(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  store?: SessionCapabilityLookup;
  cache: Map<string, SessionCapabilityLookup>;
  agentId?: string;
}): SessionDepthEntry | undefined {
  const key = resolveSessionLookupKey(params.sessionKey, params.cfg, params.agentId);
  const agentId =
    parseAgentSessionKey(key)?.agentId ?? params.agentId ?? params.store?.scope?.agentId;
  if (params.store) {
    const entry =
      params.store.get(key) ??
      (agentId ? params.store.getById(params.sessionKey, agentId) : undefined);
    if (entry || !params.cfg) {
      return entry;
    }
  }
  if (!params.cfg || !agentId) {
    return undefined;
  }
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  // A fixed path still exposes an agent-scoped logical view. Reusing another
  // agent's snapshot can erase cross-agent lineage or adopt the wrong row.
  const cacheKey = `${storePath}\0${normalizeAgentId(agentId)}`;
  let store = params.cache.get(cacheKey);
  if (!store) {
    store = createSubagentSessionStore(storePath, agentId);
    params.cache.set(cacheKey, store);
  }
  return store.get(key) ?? store.getById(params.sessionKey, agentId);
}

export function getSubagentDepthFromSessionStore(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
    agentId?: string;
  },
): number {
  const cache = new Map<string, SessionCapabilityLookup>();
  const store = opts?.store ? asSessionCapabilityLookup(opts.store) : undefined;
  if (store?.scope) {
    cache.set(`${store.scope.storePath}\0${normalizeAgentId(store.scope.agentId)}`, store);
  }
  return getSubagentDepthFromEntryLookup(sessionKey, (key) =>
    resolveEntryForSessionKey({
      sessionKey: key,
      cfg: opts?.cfg,
      store,
      cache,
      agentId: opts?.agentId,
    }),
  );
}
