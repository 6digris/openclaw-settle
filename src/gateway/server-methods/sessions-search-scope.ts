import {
  ErrorCodes,
  errorShape,
  type SessionsSearchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { isConfiguredSessionStoreAgentId } from "../../config/sessions.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveRequestedSessionAgentId,
  resolveRequestedSessionListScope,
} from "../session-request-agent.js";
import { resolveSessionStoreKey } from "../session-store-key.js";

export function resolveSessionSearchScope(cfg: OpenClawConfig, params: SessionsSearchParams) {
  const selected = resolveRequestedSessionListScope(
    cfg,
    params.scope ?? { agentId: params.agentId },
  );
  if (!selected.ok) {
    return selected;
  }
  if (params.scope !== undefined) {
    return { ...selected, kind: "projected" as const };
  }
  const requestedAgentId = selected.scope.agentId;
  const resolvedSessionKeys: Array<{ sessionKey: string; agentId: string }> | undefined =
    params.sessionKeys ? [] : undefined;
  for (const sessionKey of params.sessionKeys ?? []) {
    const requestedAgent =
      requestedAgentId &&
      !isConfiguredSessionStoreAgentId(cfg, requestedAgentId) &&
      resolvePersistedSessionStoreOwnerForKey(cfg, sessionKey).kind === "none"
        ? ({ ok: true, agentId: requestedAgentId } as const)
        : resolveRequestedSessionAgentId(cfg, sessionKey, requestedAgentId);
    if (!requestedAgent.ok) {
      return { ok: false as const, error: requestedAgent.error };
    }
    resolvedSessionKeys?.push({
      sessionKey: resolveSessionStoreKey({
        cfg,
        storeAgentId: requestedAgent.agentId,
        sessionKey,
      }),
      agentId: requestedAgent.agentId,
    });
  }
  const sessionKeys = resolvedSessionKeys?.map((resolved) => resolved.sessionKey);
  const agentIds = new Set(resolvedSessionKeys?.map((resolved) => resolved.agentId));
  if (
    agentIds.size > 1 ||
    (requestedAgentId && [...agentIds].some((agentId) => agentId !== requestedAgentId))
  ) {
    return {
      ok: false as const,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "sessions.search supports one agent per call"),
    };
  }
  let agentId = requestedAgentId ?? agentIds.values().next().value;
  if (!agentId) {
    const fallbackAgent = resolveRequestedSessionAgentId(cfg, "main");
    if (!fallbackAgent.ok) {
      return { ok: false as const, error: fallbackAgent.error };
    }
    agentId = fallbackAgent.agentId;
  }
  return {
    ok: true as const,
    kind: "agent" as const,
    agentId,
    configured: isConfiguredSessionStoreAgentId(cfg, agentId),
    requestedAgentId,
    sessionKeys,
  };
}
