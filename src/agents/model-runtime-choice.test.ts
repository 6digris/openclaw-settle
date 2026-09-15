import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applySessionModelSelection } from "../model-picker/apply-session-model-selection.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { preparePublishedModelRuntimeChoice } from "./model-runtime-choice.js";
import { setPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const published = vi.hoisted((): { owner?: PreparedModelRuntimeSnapshot } => ({}));
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => published.owner,
  materializePreparedModelCatalogOwner: (owner: PreparedModelRuntimeSnapshot) => owner,
  loadProviderScopedThinkingCatalog: async () => [],
}));

const cfg: OpenClawConfig = { plugins: { enabled: false } };
const request = {
  cfg,
  agentId: "main",
  provider: "fixture",
  model: "model",
  runtimeId: "openclaw",
};

function publish(
  isCurrent = () => true,
  config = cfg,
  facts: Pick<PreparedModelRuntimeSnapshot, "authModes" | "pluginRegistry"> = { authModes: {} },
) {
  const entry = { provider: "fixture", id: "model", name: "Model" };
  const owner: PreparedModelRuntimeSnapshot = {
    config,
    observationConfig: config,
    catalogOwner: { agentId: "main", workspaceDir: "/tmp/runtime-choice" },
    agentId: "main",
    agentDir: "/tmp/runtime-choice/agent",
    workspaceDir: "/tmp/runtime-choice",
    activeProjectKeys: [],
    ...facts,
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    isCurrent,
    allowGatewaySubagentBinding: false,
    modelCatalog: { entries: [entry], routeVariants: [entry] },
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores() {
      const authStorage = AuthStorage.inMemory({});
      return { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage) };
    },
  };
  setPreparedModelRuntimeAuthStore(owner, {
    version: 1,
    profiles: {
      "fixture:account": { type: "api_key", provider: "fixture", key: "synthetic-credential" },
    },
  });
  published.owner = owner;
  return owner;
}

function publishNative(
  runtimes: string[],
  host = false,
  isCurrent = () => true,
  facts: Partial<Pick<PreparedModelRuntimeSnapshot, "config" | "authModes">> = {},
) {
  const registry = createEmptyPluginRegistry();
  for (const id of runtimes) {
    registry.agentHarnesses.push({
      pluginId: id,
      source: "fixture",
      harness: {
        id,
        label: id,
        authBootstrap: "harness",
        autoSelection: { providerIds: [] },
        supports: ({ requestedRuntime }) => ({ supported: requestedRuntime === id }),
        async runAttempt() {
          throw new Error("Model selection must not run a prompt");
        },
      },
    });
  }
  const owner = publish(isCurrent, facts.config ?? cfg, {
    pluginRegistry: registry,
    authModes: facts.authModes ?? {},
  });
  const entry = owner.modelCatalog.entries[0]!;
  const nativeEntries = runtimes.map((nativeRuntime) => ({ ...entry, nativeRuntime }));
  owner.modelCatalog.entries = [nativeEntries[0]!];
  owner.modelCatalog.routeVariants = [...nativeEntries, ...(host ? [entry] : [])];
  if (!host) {
    setPreparedModelRuntimeAuthStore(owner, { version: 1, profiles: {} });
  }
  return owner;
}

describe("published runtime choice", () => {
  beforeEach(() => {
    published.owner = undefined;
  });

  it("refuses an unpublished or unresolved model", async () => {
    expect(await preparePublishedModelRuntimeChoice(request)).toMatchObject({
      kind: "unavailable",
    });
    publish();
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, model: "unobserved" }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("selects the sole native route and rechecks its generation before commit", async () => {
    let current = true;
    publishNative(["native"], false, () => current);
    const choice = await preparePublishedModelRuntimeChoice({ ...request, runtimeId: undefined });
    expect(choice).toMatchObject({ kind: "ready", runtimeId: "native" });
    if (choice.kind !== "ready") {
      throw new Error("Expected an available native runtime");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toBeDefined();
  });

  it.each([
    { previous: "native-a", selected: "native-b", provider: "fixture" },
    { previous: "native-a", selected: "claude-cli", provider: "claude-cli" },
    { previous: "claude-cli", selected: "native-b", provider: "fixture" },
  ])(
    "switches $previous to $selected through the shared session selection",
    async ({ previous, selected, provider }) => {
      const owner = publishNative(["native-a", "native-b"], false, () => true, {
        authModes: { "claude-cli": "token" },
      });
      owner.pluginRegistry!.cliBackends.push({
        pluginId: "anthropic",
        source: "fixture",
        backend: { id: "claude-cli", modelProvider: "anthropic", config: { command: "claude" } },
      });
      owner.modelCatalog.entries =
        selected === "claude-cli"
          ? [{ provider, id: "model", name: "CLI model", reasoning: false }]
          : [owner.modelCatalog.routeVariants[1]!];
      owner.modelCatalog.routeVariants = [...owner.modelCatalog.entries];
      const entry: SessionEntry = {
        sessionId: "model-runtime-cutover",
        updatedAt: 1,
        agentHarnessId: previous,
        agentRuntimeOverride: previous,
      };
      const result = await withPluginRuntimeRegistryScope(owner.pluginRegistry!, () =>
        applySessionModelSelection({
          cfg,
          agentId: "main",
          sessionKey: "agent:main:runtime-cutover",
          sessionEntry: entry,
          sessionStore: { "agent:main:runtime-cutover": entry },
          defaultProvider: "fixture",
          defaultModel: "previous",
          currentProvider: "fixture",
          currentModel: "previous",
          modelCatalog: owner.modelCatalog.entries,
          request: {
            provider,
            model: "model",
            isDefault: false,
            runtime: { kind: "unchanged" },
          },
          markLiveSwitchPending: true,
        }),
      );
      expect(result).toMatchObject({ status: "applied", agentRuntime: selected });
      expect(entry.agentRuntimeOverride).toBe(selected);
      expect(entry.agentHarnessId).toBe(previous);
    },
  );

  it("retains a prior runtime only when the selected model publishes that route", async () => {
    const owner = publishNative(["native-a", "native-b"]);
    expect(
      await preparePublishedModelRuntimeChoice({
        ...request,
        runtimeId: undefined,
        preferredRuntimeId: "native-a",
      }),
    ).toMatchObject({ kind: "ready", runtimeId: "native-a" });
    owner.modelCatalog.entries = [owner.modelCatalog.routeVariants[1]!];
    owner.modelCatalog.routeVariants = [...owner.modelCatalog.entries];
    expect(
      await preparePublishedModelRuntimeChoice({
        ...request,
        runtimeId: undefined,
        preferredRuntimeId: "native-a",
      }),
    ).toMatchObject({ kind: "ready", runtimeId: "native-b" });
  });

  it.each([undefined, "native-b"])(
    "honors configured routing and the current explicit runtime %s ahead of a prior pin",
    async (runtimeId) => {
      const owner = publishNative(["native-a", "native-b"], false, () => true, {
        config: {
          ...cfg,
          agents: {
            defaults: { models: { "fixture/model": { agentRuntime: { id: "native-a" } } } },
          },
        },
      });
      expect(
        await preparePublishedModelRuntimeChoice({
          ...request,
          cfg: owner.config,
          runtimeId,
          preferredRuntimeId: "native-b",
        }),
      ).toMatchObject({ kind: "ready", runtimeId: runtimeId ?? "native-a" });
    },
  );

  it("keeps a usable hosted default when native alternatives are installed", async () => {
    publishNative(["native", "other-native"], true);
    const choice = await preparePublishedModelRuntimeChoice({ ...request, runtimeId: undefined });
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected the existing hosted route");
    }
    expect(choice.runtimeId).toBeUndefined();
    expect(choice.validate()).toBeUndefined();
  });

  it("rejects ambiguous native defaults while honoring an explicit native choice", async () => {
    publishNative(["native", "other-native"]);
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, runtimeId: undefined }),
    ).toMatchObject({
      kind: "unavailable",
      message: expect.stringContaining("Choose an explicit runtime"),
    });
    expect(
      await preparePublishedModelRuntimeChoice({ ...request, runtimeId: "other-native" }),
    ).toMatchObject({
      kind: "ready",
      runtimeId: "other-native",
    });
  });

  it.each([undefined, "openclaw"])(
    "validates an off-catalog model with prior runtime %s through its configured route",
    async (preferredRuntimeId) => {
      const config: OpenClawConfig = {
        ...cfg,
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://models.example.invalid/v1",
              models: [],
            },
          },
        },
      };
      let current = true;
      publish(() => current, config);
      const choice = await preparePublishedModelRuntimeChoice({
        ...request,
        cfg: config,
        model: "off-catalog",
        runtimeId: preferredRuntimeId ? undefined : request.runtimeId,
        preferredRuntimeId,
      });
      expect(choice.kind).toBe("ready");
      if (choice.kind !== "ready") {
        throw new Error("Expected the configured off-catalog route to be selectable");
      }
      expect(choice.validate()).toBeUndefined();
      current = false;
      expect(choice.validate()).toContain("fixture/off-catalog");
    },
  );

  it.each([
    { authenticated: true, previousRuntime: "openclaw" },
    { authenticated: false, previousRuntime: "openclaw" },
    { authenticated: true, previousRuntime: "native" },
  ])(
    "applies a model-only off-catalog selection from $previousRuntime only with valid auth=$authenticated",
    async ({ authenticated, previousRuntime }) => {
      const config: OpenClawConfig = {
        ...cfg,
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://models.example.invalid/v1",
              models: [],
            },
          },
        },
      };
      const registry = createEmptyPluginRegistry();
      registry.agentHarnesses.push({
        pluginId: "native",
        source: "fixture",
        harness: {
          id: "native",
          label: "Native",
          authBootstrap: "harness",
          autoSelection: { providerIds: [] },
          supports: () => ({ supported: true }),
          async runAttempt() {
            throw new Error("Selection must not run a prompt");
          },
        },
      });
      const owner = publish(() => true, config, { authModes: {}, pluginRegistry: registry });
      if (!authenticated) {
        setPreparedModelRuntimeAuthStore(owner, { version: 1, profiles: {} });
      }
      const entry: SessionEntry = {
        sessionId: "off-catalog-selection",
        updatedAt: 1,
        providerOverride: "fixture",
        modelOverride: "previous",
        agentRuntimeOverride: previousRuntime,
      };
      const initial = { ...entry };
      const result = await withPluginRuntimeRegistryScope(registry, () =>
        applySessionModelSelection({
          cfg: config,
          agentId: "main",
          sessionKey: "agent:main:off-catalog-selection",
          sessionEntry: entry,
          sessionStore: { "agent:main:off-catalog-selection": entry },
          defaultProvider: "fixture",
          defaultModel: "previous",
          currentProvider: "fixture",
          currentModel: "previous",
          modelCatalog: owner.modelCatalog.entries,
          request: {
            provider: "fixture",
            model: "off-catalog",
            isDefault: false,
            runtime: { kind: "unchanged" },
          },
          markLiveSwitchPending: true,
        }),
      );
      if (authenticated) {
        expect(result).toMatchObject({ status: "applied", agentRuntime: "openclaw" });
        expect(entry).toMatchObject({
          providerOverride: "fixture",
          modelOverride: "off-catalog",
        });
        expect(entry.agentRuntimeOverride).toBe(
          previousRuntime === "openclaw" ? "openclaw" : undefined,
        );
      } else {
        expect(result).toMatchObject({ status: "rejected", reason: "invalid-runtime" });
        expect(entry).toEqual(initial);
      }
    },
  );

  it("does not grant an incompatible runtime to an off-catalog model", async () => {
    const config: OpenClawConfig = {
      ...cfg,
      models: {
        providers: {
          fixture: {
            api: "openai-completions",
            baseUrl: "https://models.example.invalid/v1",
            models: [],
          },
        },
      },
    };
    publish(() => true, config);
    expect(
      await preparePublishedModelRuntimeChoice({
        ...request,
        cfg: config,
        model: "off-catalog",
        runtimeId: "codex",
      }),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("rechecks the same generation at the session commit boundary", async () => {
    let current = true;
    publish(() => current);
    const choice = await preparePublishedModelRuntimeChoice(request);
    expect(choice.kind).toBe("ready");
    if (choice.kind !== "ready") {
      throw new Error("Expected a supported runtime");
    }
    expect(choice.validate()).toBeUndefined();
    current = false;
    expect(choice.validate()).toContain("not available");
  });
});
