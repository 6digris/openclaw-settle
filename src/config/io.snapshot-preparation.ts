import { hasAnthropicDefaultSignal } from "./defaults.js";
import type { ConfigIoContext } from "./io.context.js";
import { materializeRuntimeConfig } from "./materialize.js";
import type { OpenClawConfig, RuntimeConfig } from "./types.js";
import {
  validateConfigObjectWithPluginsAsync,
  type PreparedConfigValidationPluginMetadata,
} from "./validation.js";

type MetadataLoader = ReturnType<ConfigIoContext["createValidationPluginMetadataSnapshotLoader"]>;
type ValidationRequest = {
  kind: "validate";
  context: ConfigIoContext;
  metadata: MetadataLoader;
  raw: unknown;
  sourceRaw: unknown;
};
type MaterializationRequest = {
  kind: "materialize";
  context: ConfigIoContext;
  metadata: MetadataLoader;
  config: OpenClawConfig;
};
type MetadataRequest = {
  kind: "metadata";
  metadata: MetadataLoader;
  config: OpenClawConfig;
};
type PreparedValidation = {
  deferredPluginMigrations: Awaited<
    ReturnType<ConfigIoContext["resolveDeferredPluginMigrationsAsync"]>
  >;
  validated: Awaited<ReturnType<typeof validateConfigObjectWithPluginsAsync>>;
};

/** Preserve the ordinary reader's lazy defaults, including an unused manifest loader. */
export function materializeConfigSnapshotDefaults(
  context: ConfigIoContext,
  config: OpenClawConfig,
  metadata: MetadataLoader,
): RuntimeConfig {
  return materializeRuntimeConfig(config, {
    ...context.pathResolution,
    ...(context.options.pluginValidation === "core-only"
      ? { manifestRegistry: { plugins: [] } }
      : { loadManifestRegistry: () => metadata.load(config).manifestRegistry }),
  });
}

/** Supplied by a native Gateway host, never selected by generic config readers. */
export function prepareHostConfigSnapshot(request: ValidationRequest): Promise<PreparedValidation>;
export function prepareHostConfigSnapshot(request: MaterializationRequest): Promise<RuntimeConfig>;
export function prepareHostConfigSnapshot(
  request: MetadataRequest,
): Promise<PreparedConfigValidationPluginMetadata>;
export async function prepareHostConfigSnapshot(
  request: ValidationRequest | MaterializationRequest | MetadataRequest,
): Promise<PreparedValidation | RuntimeConfig | PreparedConfigValidationPluginMetadata> {
  if (request.kind === "metadata") {
    return await request.metadata.loadAsync(request.config);
  }
  const { context, metadata } = request;
  if (request.kind === "materialize") {
    if (
      context.options.pluginValidation !== "core-only" &&
      (request.config.models?.providers ||
        hasAnthropicDefaultSignal(request.config, context.deps.env))
    ) {
      await metadata.loadAsync(request.config);
    }
    return materializeConfigSnapshotDefaults(context, request.config, metadata);
  }
  const pending = await context.resolveDeferredPluginMigrationsAsync();
  return {
    deferredPluginMigrations: pending,
    validated: await validateConfigObjectWithPluginsAsync(request.raw, {
      ...context.pathResolution,
      pluginValidation: context.options.pluginValidation,
      loadPluginMetadataSnapshotAsync: metadata.loadAsync,
      sourceRaw: request.sourceRaw,
      preservedLegacyRootKeys: context.options.preservedLegacyRootKeys,
      deferredPluginMigrations: pending,
    }),
  };
}

export type ConfigSnapshotPreparation = typeof prepareHostConfigSnapshot;
export type CapturedConfigSnapshotPreparation = {
  <T>(operation: (prepare: ConfigSnapshotPreparation) => Promise<T>): Promise<T>;
  assertCurrent: () => void;
};
