// Exercise catalog projection before the actual provider and embedded runtime policy.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderPlugin } from "../../plugins/provider-plugin.types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { prepareContextWindowCaches } from "../context-cache-projection.js";
import { resolveModelContextTokenProjectionFromCache } from "../context-resolution.js";
import { resolveEmbeddedRuntimeModelPolicy } from "../embedded-agent-runner/run/setup.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";

const manifest = JSON.parse(
  readFileSync(new URL("../../../extensions/openai/openclaw.plugin.json", import.meta.url), "utf8"),
) as { modelCatalog: { providers: { openai: ModelProviderConfig } } };
const catalog = manifest.modelCatalog.providers.openai;
const modelId = "gpt-6-astra";
const source = catalog.models.find((model) => model.id === modelId)!;
let provider: ProviderPlugin;

beforeAll(async () => {
  const api = await loadBundledPluginFacade<{ buildOpenAIProvider: () => ProviderPlugin }>({
    pluginId: "openai",
    artifactBasename: "api.js",
  });
  provider = api.buildOpenAIProvider();
});

describe("registry to provider context budgets", () => {
  it.each([
    { name: "catalog default" },
    { name: "larger explicit input cap", contextTokens: 922_000 },
    { name: "smaller explicit input cap", contextTokens: 64_000 },
    { name: "input cap clamped to native capacity", contextTokens: 2_000_000 },
    { name: "session-selected window", selected: "small", expected: 40_000 },
    { name: "caller budget", callerBudget: 32_000, expected: 32_000 },
  ])("preserves active input through $name", async (fixture) => {
    const cfg: OpenClawConfig = fixture.contextTokens
      ? {
          models: {
            providers: {
              openai: {
                ...catalog,
                models: [{ ...source, contextTokens: fixture.contextTokens }],
              },
            },
          },
        }
      : {};
    const definition = {
      ...source,
      contextWindows: [{ id: "small", label: "Small", contextWindow: 40_000 }],
    };
    const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:models.json", {
      config: cfg,
      modelsJsonContents: null,
      pluginCatalogs: [],
      includePluginCatalogs: false,
      staticProviderConfigs: { openai: { ...catalog, models: [definition] } },
    });
    expect(registry.getError()).toBeUndefined();
    const row = registry.find("openai", modelId)!;
    expect.soft(row.contextTokens).toBe(fixture.contextTokens ?? source.contextTokens);
    expect(row.contextWindow).toBe(source.contextWindow);

    // The exact-row resolver must consume real registry output, not a hand-built row.
    const context = {
      provider: "openai",
      modelId,
      config: cfg,
      agentRuntimeId: "openclaw",
      providerConfig: { api: "openai-responses" as const, baseUrl: catalog.baseUrl, models: [] },
      modelRegistry: registry,
    };
    const resolved = provider.resolveDynamicModel?.(context);
    if (!resolved) {
      throw new Error("Expected the exact registry model");
    }
    const normalized =
      provider.normalizeResolvedModel?.({ ...context, model: resolved }) ?? resolved;
    expect.soft(normalized.contextTokens).toBe(fixture.contextTokens ?? source.contextTokens);
    expect(normalized.contextWindow).toBe(source.contextWindow);

    const caches = await prepareContextWindowCaches({
      config: cfg,
      modelCatalog: {
        entries: [normalized],
        staticEntries: [{ ...source, provider: "openai" }],
      },
    });
    const preflight = resolveModelContextTokenProjectionFromCache(
      {
        cfg,
        provider: "openai",
        model: modelId,
        modelContextTokens: normalized.contextTokens,
        modelContextWindow: normalized.contextWindow,
      },
      (key) => caches.configuredTokenCache.get(key!) ?? caches.discoveredTokenCache.get(key!),
      (key) => caches.contextWindowCache.get(key!),
    );
    const modelBudget = Math.min(
      fixture.contextTokens ?? source.contextTokens!,
      source.contextWindow!,
    );
    expect(preflight.contextTokens).toBe(modelBudget);

    // This is the budget forwarded by setup to context assembly and durable turns.
    const runtime = resolveEmbeddedRuntimeModelPolicy({
      cfg,
      provider: "openai",
      modelId,
      runtimeModel: normalized,
      nativeModelOwned: false,
      contextWindow: fixture.selected,
      contextTokenBudget: fixture.callerBudget,
    });
    const expected = fixture.expected ?? modelBudget;
    expect(runtime.contextTokenBudget).toBe(expected);
    expect(runtime.contextWindowInfo?.tokens).toBe(expected);
    expect(runtime.effectiveModel.contextWindow).toBe(expected);
    expect(normalized.contextWindow).toBe(source.contextWindow);
  });
});
