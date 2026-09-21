/**
 * Focused runtime SDK subpath for native harness tool-surface routing.
 *
 * Keep tool-search and code-mode dependencies out of the lightweight harness
 * lifecycle facade used during plugin startup.
 */
import {
  createAgentHarnessToolSurfaceRuntimeCore,
  type AgentHarnessToolSurfaceRuntime as CoreAgentHarnessToolSurfaceRuntime,
} from "../agents/harness/tool-surface-bridge.js";

export {
  normalizeAcceptedSessionSpawnResult,
  type AcceptedSessionSpawn,
} from "../agents/accepted-session-spawn.js";
export {
  isAsyncStartedToolResult,
  readAsyncStartedTaskIds,
} from "../agents/embedded-agent-tool-results.js";
export { extractMessagingToolSourceReplyPayload } from "../agents/embedded-agent-messaging-extraction.js";
export { collectMessagingMediaUrlsFromRecord } from "../agents/embedded-agent-tool-media.js";
export { getCoreTtsToolResultMediaUrls } from "../agents/tools/tts-tool-result-provenance.js";
export { consumeTrustedToolNoStartError } from "../agents/tool-result-error.js";
export {
  recordAgentHarnessMessagingDelivery,
  recordAgentHarnessToolResultTelemetry,
  collectAgentHarnessMessagingMediaUrls,
  type AgentHarnessToolResultTelemetry,
  recordAgentHarnessToolResultMedia,
  type AgentHarnessMessagingDeliveryFacts,
  type AgentHarnessToolMediaFacts,
} from "../agents/harness/tool-result-facts.js";
export { runAgentHarnessToolInvocation } from "../agents/harness/tool-invocation.js";
export { runWithToolExecutionValidation } from "../agents/agent-tools.execution-validation.js";
export {
  createAgentHarnessToolExecutionRegistry,
  createAgentHarnessToolExecutionBoundaryRegistry,
  type AgentHarnessToolExecutionSnapshot,
} from "../agents/harness/tool-execution.js";
export {
  acknowledgeInternalToolResult,
  copyInternalToolResultState,
} from "../agents/runtime/internal-hooks.js";

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<typeof import("./agent-harness.js").createOpenClawCodingTools>[0]
>;

export type AgentHarnessToolSurfaceRuntime = Omit<
  CoreAgentHarnessToolSurfaceRuntime,
  "toolSearchCatalogExecutor" | "toolSearchCatalogRef"
> & {
  toolSearchCatalogExecutor: OpenClawCodingToolsOptions["toolSearchCatalogExecutor"];
  toolSearchCatalogRef: OpenClawCodingToolsOptions["toolSearchCatalogRef"];
};

export type AgentHarnessToolSurfaceRuntimeParams = Omit<
  Parameters<typeof createAgentHarnessToolSurfaceRuntimeCore>[0],
  "executeTool" | "disableToolSearch"
> & {
  executeTool: NonNullable<OpenClawCodingToolsOptions["toolSearchCatalogExecutor"]>;
};

export function createAgentHarnessToolSurfaceRuntime(
  params: AgentHarnessToolSurfaceRuntimeParams,
): AgentHarnessToolSurfaceRuntime {
  return createAgentHarnessToolSurfaceRuntimeCore(params);
}
