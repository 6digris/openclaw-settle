// Private thread-configuration projections for the bundled Codex plugin.
// Workspace preparation and MCP metadata remain separate from live run resources.
import { pinExecToolTarget } from "../agents/exec-tool-target-pinning.js";
import type { ExtraSystemPromptSource } from "../agents/extra-system-prompt.js";
import type { AgentHarnessHostCapabilities } from "../agents/harness/host-capability-types.js";
import {
  resolveAgentHarnessScheduledToolProjectionCapability,
  resolveAgentHarnessTtsProvenanceTransferCapability,
  type AgentHarnessScheduledToolProjectionFactory,
  type AgentHarnessTtsProvenanceTransfer,
} from "../agents/harness/host-private-capabilities.js";
import type { AgentHarnessAttemptParamsV2 } from "../agents/harness/types.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../agents/tool-fs-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronToolsAllowCaptureRef,
} from "../agents/tools/cron-tool.types.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";

export { pinExecToolTarget };
export { resolveBootstrapFilesForPreparation } from "../agents/bootstrap-files.js";
export { loadCodexBundleMcpApprovalConfig } from "../agents/codex-mcp-config.js";
export {
  formatMcpCodexApprovalRemedy,
  requiresMcpCodexToolApproval,
  resolveProjectedMcpCodexToolApprovalMode,
} from "../agents/mcp-codex-tool-approval.js";
export type CodexScheduledToolProjectionFactory = AgentHarnessScheduledToolProjectionFactory;
export type CodexTtsProvenanceTransfer = AgentHarnessTtsProvenanceTransfer;

/** Keep temporary sources alive for the complete native run. */
export async function withCodexExtraSystemPromptScope<T>(
  run: () => Promise<T>,
  runId: string,
): Promise<T> {
  const { withExtraSystemPromptScope } = await import("../agents/extra-system-prompt.js");
  return await withExtraSystemPromptScope(run, runId);
}

/** Prepare the original only after the bundled harness resolves its actual reader. */
export async function prepareCodexExtraSystemPrompt(
  owner: Pick<
    AgentHarnessAttemptParamsV2,
    "extraSystemPrompt" | "hostCapabilities" | "config" | "agentId"
  >,
  options: {
    contextTokenBudget?: number;
    source: ExtraSystemPromptSource;
    readAvailable: boolean;
    policyAgentId?: string;
  },
) {
  owner.hostCapabilities.assertActive();
  const { prepareExtraSystemPrompt, resolveExtraSystemPromptSource } =
    await import("../agents/extra-system-prompt.js");
  owner.hostCapabilities.assertActive();
  const prepared = await prepareExtraSystemPrompt(owner, {
    contextTokenBudget: options.contextTokenBudget,
    ...resolveExtraSystemPromptSource(options.source),
    readAvailable:
      options.readAvailable &&
      !resolveEffectiveToolFsWorkspaceOnly({
        cfg: owner.config,
        agentId: options.policyAgentId ?? owner.agentId,
      }),
  });
  owner.hostCapabilities.assertActive();
  return prepared;
}

// Native mode pins shell_tool after managed-policy preflight; the pinned registry has no disabled shells.
// A shell-disabled custom model invalidates read/exec inference; Codex exposes no shell_type fact.
// Write, patch, and process remain unobserved model/sandbox capabilities and are never inferred.
const CODEX_NATIVE_CRON_CREATOR_AUTHORITY = ["read", "exec"] as const;

/** Resolve the private scheduled-tool projection issuer for the Codex harness owner. */
export function resolveCodexScheduledToolProjectionFactory(
  hostCapabilities: AgentHarnessHostCapabilities,
): CodexScheduledToolProjectionFactory | undefined {
  return resolveAgentHarnessScheduledToolProjectionCapability({
    hostCapabilities,
    ownerPluginId: "codex",
  });
}

/** Resolve private TTS delivery transfer for the bundled Codex harness owner. */
export function resolveCodexTtsProvenanceTransfer(
  hostCapabilities: AgentHarnessHostCapabilities,
): CodexTtsProvenanceTransfer | undefined {
  return resolveAgentHarnessTtsProvenanceTransferCapability({
    hostCapabilities,
    ownerPluginId: "codex",
  });
}

export {
  buildCodexUserMcpServersThreadConfigPatchForRuntime,
  buildCodexUserMcpServersThreadConfigPatchForRun,
  resolveCodexMcpToolOverridesForAgent,
} from "../agents/cli-runner/bundle-mcp-codex.js";
export {
  runWithCronCreatorAuthorityCapabilityResolver,
  runWithCronCreatorAuthorityResolver,
} from "../agents/cron-creator-authority-context.js";

/** Materialize static configured MCP under the Codex harness authority envelope. */
export async function materializeStaticMcpToolsForHarnessRun(
  params: Parameters<
    typeof import("../agents/agent-bundle-mcp-harness.js").materializeStaticMcpToolsForHarnessRunCore
  >[0],
) {
  const { materializeStaticMcpToolsForHarnessRunCore: materialize } =
    await import("../agents/agent-bundle-mcp-harness.js");
  return materialize(params);
}

/** Capture the final Codex dynamic-tool surface for cron creator authority. */
export async function captureFinalCodexCronCreatorToolAllowlist(
  target: CronCreatorToolAllowlistEntry[],
  captureRef: CronToolsAllowCaptureRef,
  tools: readonly AnyAgentTool[],
  options: { nativeToolSurfaceEnabled?: boolean } = {},
) {
  const { captureFinalEffectiveCronCreatorToolAllowlist: capture } =
    await import("../agents/tools/cron-tool.js");
  return capture(target, captureRef, tools, (tool) => getPluginToolMeta(tool), {
    canonicalToolNames: options.nativeToolSurfaceEnabled
      ? CODEX_NATIVE_CRON_CREATOR_AUTHORITY
      : undefined,
  });
}
