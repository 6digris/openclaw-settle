/**
 * Subagent spawn ownership resolver.
 *
 * Resolves which session controls spawn state, thread binding, and completion delivery.
 */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import { resolveInternalSessionKey } from "../../tools/sessions-helpers.js";

/** Normalizes requester/completion owner aliases into internal and display session keys. */
export function resolveSubagentSpawnOwnership(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentSessionKey?: string;
  completionOwnerKey?: string;
}) {
  const agentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: params.agentSessionKey,
    agentId: params.agentId,
  });
  const controllerSessionKey = resolveInternalSessionKey({
    key: params.agentSessionKey ?? "main",
    agentId,
    cfg: params.cfg,
  });
  const completionOwnerKey = params.completionOwnerKey?.trim();
  const completionRequesterSessionKey = completionOwnerKey
    ? resolveInternalSessionKey({
        key: completionOwnerKey,
        agentId,
        cfg: params.cfg,
      })
    : controllerSessionKey;
  return {
    controllerSessionKey,
    completionRequesterSessionKey,
    completionRequesterDisplayKey: completionRequesterSessionKey,
  };
}
