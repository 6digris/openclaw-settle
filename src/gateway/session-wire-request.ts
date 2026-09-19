import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  validateSessionsPatchManyParams,
  validateSessionsPreviewParams,
  validateSessionsSearchParams,
} from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../agents/agent-roster.js";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeAgentIdStrict,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  normalizeSessionPreviewKeys,
  sessionRequestTargetFields,
} from "./session-method-policy.js";
import { SessionMutationAuthorizationChangedError } from "./session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import {
  resolveGatewaySessionStoreTargetWithStore,
  type GatewaySessionStoreDiscoveryCache,
} from "./session-utils-store-lookup.js";

/** Published clients used owner-qualified main keys as mutable routing aliases. */
export function legacySessionRequest(
  method: string,
  input: unknown,
  getConfig: () => OpenClawConfig,
): unknown {
  let params = input;
  if (method === "sessions.preview") {
    if (!validateSessionsPreviewParams(params)) {
      return params;
    }
    const keys = normalizeSessionPreviewKeys(params.keys);
    if (!keys.length) {
      return params;
    }
    params = { ...params, keys };
  } else if (
    (method === "sessions.search" && !validateSessionsSearchParams(params)) ||
    (method === "sessions.patchMany" && !validateSessionsPatchManyParams(params))
  ) {
    return params;
  }
  const fields = sessionRequestTargetFields(method);
  if (!isRecord(params) || (fields.length === 0 && method !== "sessions.patchMany")) {
    return params;
  }
  let cfg: OpenClawConfig | undefined;
  const keepExactKeys = new Map<string, boolean>();
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const qualify = (value: unknown, explicitOwner?: unknown): unknown => {
    if (typeof value !== "string") {
      return value;
    }
    const parsed = parseAgentSessionKey(value);
    if (!parsed || parsed.rest === "global" || parsed.rest === "unknown") {
      return value;
    }
    cfg ??= getConfig();
    if (parsed.rest !== "main" && parsed.rest !== normalizeMainKey(cfg.session?.mainKey)) {
      return value;
    }
    if (explicitOwner !== undefined && typeof explicitOwner !== "string") {
      return value;
    }
    const owner =
      typeof explicitOwner === "string" ? normalizeAgentIdStrict(explicitOwner) : undefined;
    if (owner && !owner.ok) {
      return value;
    }
    const requestedAgent = owner?.value;
    if (requestedAgent && requestedAgent !== parsed.agentId) {
      return value;
    }
    let agentId = parsed.agentId;
    if (agentId === "main" && !listAgentIds(cfg).includes("main")) {
      if (!keepExactKeys.has(value)) {
        try {
          const target = resolveGatewaySessionStoreTargetWithStore({
            cfg,
            key: value,
            readOnly: true,
            exactRead: true,
            projection: "list",
            targetDiscoveryCache,
          });
          keepExactKeys.set(value, Boolean(target.store[target.canonicalKey]));
        } catch {
          // Failure cannot prove alias absence. The exact target owner authorizes and diagnoses it.
          keepExactKeys.set(value, true);
        }
      }
      if (keepExactKeys.get(value)) {
        return value;
      }
      agentId = resolveSessionStoreIdentity({ cfg, sessionKey: "main" }).agentId;
    }
    const sessionKey = resolveAgentMainSessionKey({ cfg, agentId });
    if (cfg.session?.scope === "global") {
      const targetOwner = resolveRequestedSessionAgentId(cfg, sessionKey, agentId);
      if (!targetOwner.ok) {
        throw new SessionMutationAuthorizationChangedError(targetOwner.error);
      }
    }
    return sessionKey;
  };
  let result = params;
  const assign = (field: string, value: unknown) => {
    if (result === params) {
      result = { ...params };
    }
    result[field] = value;
  };
  for (const field of fields) {
    const current = params[field];
    const owner =
      field === "parentSessionKey" || field === "spawnedBy" ? undefined : params.agentId;
    const next = Array.isArray(current)
      ? current.map((key) => qualify(key, owner))
      : qualify(current, owner);
    if (next !== current) {
      assign(field, next);
    }
  }
  if (method === "sessions.resolve" && isRecord(params.reference)) {
    const key = qualify(params.reference.key, params.agentId);
    if (key !== params.reference.key) {
      assign("reference", { ...params.reference, key });
    }
  }
  if (method === "sessions.search" && isRecord(params.scope)) {
    const spawnedBy = qualify(params.scope.spawnedBy);
    if (spawnedBy !== params.scope.spawnedBy) {
      assign("scope", { ...params.scope, spawnedBy });
    }
  }
  if (method === "sessions.patchMany" && Array.isArray(params.targets)) {
    const targets = params.targets.map((entry) => {
      if (!isRecord(entry)) {
        return entry;
      }
      const key = qualify(entry.key, entry.agentId);
      return key === entry.key ? entry : Object.assign({}, entry, { key });
    });
    assign("targets", targets);
  }
  return result;
}
