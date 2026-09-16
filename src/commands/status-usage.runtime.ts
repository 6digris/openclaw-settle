// Optional status usage owns its credential and provider dependencies.
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { resolveAgentHarnessPolicy } from "../agents/harness/policy.js";
import { resolveModelAuthLabel } from "../agents/model-auth-label.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../agents/openai-routing.js";
import type { OpenClawConfig } from "../config/types.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import {
  buildCodexSyntheticUsageAuth,
  mergeUsageSummaries,
  shouldUseCodexSyntheticUsageForRuntime,
  resolveUsageCredentialType,
} from "../status/codex-synthetic-usage.js";

const providerUsageLoader = createLazyImportLoader(() => import("../infra/provider-usage.js"));

function shouldUseConfiguredCodexSyntheticUsage(params: {
  config: OpenClawConfig;
  agentDir: string;
}): boolean {
  const configuredDefault = resolveDefaultModelForAgent({
    cfg: params.config,
    allowPluginNormalization: false,
  });
  const policy = resolveAgentHarnessPolicy({
    config: params.config,
    provider: configuredDefault.provider,
    modelId: configuredDefault.model,
  });
  if (
    !shouldUseCodexSyntheticUsageForRuntime({
      provider: configuredDefault.provider,
      effectiveHarness: policy.runtime,
    })
  ) {
    return false;
  }
  const authLabel = resolveModelAuthLabel({
    provider: configuredDefault.provider,
    acceptedProviderIds: listOpenAIAuthProfileProvidersForAgentRuntime({
      provider: configuredDefault.provider,
      harnessRuntime: policy.runtime,
      config: params.config,
    }),
    cfg: params.config,
    agentDir: params.agentDir,
    includeExternalProfiles: false,
  });
  return resolveUsageCredentialType(authLabel) !== "api_key";
}

export type StatusUsageSummaryOptions = {
  config: OpenClawConfig;
  timeoutMs?: number;
  agentDir?: string;
};

/** Loads provider usage for status output, defaulting to the config's default agent directory. */
export async function resolveStatusUsageSummary(params: StatusUsageSummaryOptions) {
  const { loadProviderUsageSummary } = await providerUsageLoader.load();
  const agentDir = params.agentDir ?? resolveDefaultAgentDir(params.config);
  const usage = await loadProviderUsageSummary({
    timeoutMs: params.timeoutMs,
    config: params.config,
    agentDir,
  });
  if (!shouldUseConfiguredCodexSyntheticUsage({ config: params.config, agentDir })) {
    return usage;
  }
  const codexUsage = await loadProviderUsageSummary({
    timeoutMs: params.timeoutMs,
    providers: ["openai"],
    auth: [buildCodexSyntheticUsageAuth()],
    config: params.config,
    agentDir,
  });
  return mergeUsageSummaries(usage, codexUsage);
}

/** Exposes the lazily loaded provider-usage module for callers that need its helpers. */
export async function loadStatusProviderUsageModule() {
  return await providerUsageLoader.load();
}
