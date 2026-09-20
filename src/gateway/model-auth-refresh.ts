import { reloadSharedAuthStoreOwnership } from "../agents/auth-profiles/path-resolve.js";
import { prepareModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import { preparedModelRuntimeConfigsMatch } from "../agents/prepared-model-runtime.owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { refreshActiveProviderAuthRuntimeSnapshot } from "../secrets/runtime.js";
import {
  modelAuthAgentScopeError,
  resolveModelAuthAgentScope,
} from "./server-methods/model-auth-agent-scope.js";
import { clearModelAuthStatusUsageCache } from "./server-methods/models-auth-status-usage-cache.js";

export async function refreshModelAuthStateAfterMutation(
  getRuntimeConfig: () => OpenClawConfig,
  agentId: string,
): Promise<void> {
  // The first CLI login can move the shared store after this Gateway pinned its owner.
  reloadSharedAuthStoreOwnership();
  clearModelAuthStatusUsageCache();
  await refreshActiveProviderAuthRuntimeSnapshot();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const config = getRuntimeConfig();
    const scope = resolveModelAuthAgentScope(config, agentId);
    if (!scope.ok) {
      throw new Error(modelAuthAgentScopeError(scope).message);
    }
    // A credential mutation can also commit config references. If hot reload replaces the
    // runtime config while this generation is preparing, join the replacement before returning.
    const prepared = await prepareModelRuntimeSnapshot({
      config,
      agentId,
      agentDir: scope.agentDir,
    });
    if (preparedModelRuntimeConfigsMatch(prepared.config, getRuntimeConfig())) {
      return;
    }
  }
  throw new Error("Gateway config kept changing while refreshing model authentication");
}
