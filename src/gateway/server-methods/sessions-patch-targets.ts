import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveGatewaySessionStoreTargetWithStore } from "../session-utils-store-lookup.js";
import { invalidSessionPatchOutcome } from "./sessions-patch-errors.js";
import type { MutationTarget } from "./sessions-patch-types.js";

/** Share target discovery across the batch before any writer is admitted. */
export function prepareSessionPatchTargets(
  cfg: OpenClawConfig,
  targets: readonly MutationTarget[],
) {
  const targetDiscoveryCache = new Map();
  const preflightTargets = targets.map((input) => {
    const key = input.key.trim();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, key, input.agentId);
    return {
      input,
      key,
      requestedAgent,
      resolved: requestedAgent.ok
        ? resolveGatewaySessionStoreTargetWithStore({
            cfg,
            key,
            agentId: requestedAgent.agentId,
            exactRead: true,
            targetDiscoveryCache,
          })
        : undefined,
    };
  });
  const logicalTargets = new Set<string>();
  for (const { resolved } of preflightTargets) {
    if (!resolved) {
      continue;
    }
    const logicalId = `${resolved.storePath}\0${resolved.canonicalKey}`;
    if (logicalTargets.has(logicalId)) {
      return invalidSessionPatchOutcome("Duplicate target.");
    }
    logicalTargets.add(logicalId);
  }
  return { ok: true as const, targets: preflightTargets };
}
