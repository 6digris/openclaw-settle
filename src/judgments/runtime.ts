import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginHostCleanupTimeout } from "../plugins/host-hook-cleanup-timeout.js";
import {
  capturePluginLifecycleAuthority,
  capturePluginRegistryLifecycleEpoch,
  capturePluginRegistryLifecycleSignal,
  getPluginRegistryResourceOwner,
} from "../plugins/registry-lifecycle.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { getPluginRegistryForContext } from "../plugins/runtime/gateway-request-scope.js";
import type { JudgmentProviderHost } from "./provider-host.js";
import type { JudgmentBatch, JudgmentOutcome, JudgmentRuntimeV1 } from "./types.js";
import { JudgmentContractError, validateJudgmentBatch } from "./validation.js";

type Options = Parameters<JudgmentRuntimeV1["evaluate"]>[1];

/** Core calls carry their owner's abort signal; plugin callers additionally bind their exact instance. */
export async function evaluateJudgment(
  batch: JudgmentBatch,
  options: Options,
): Promise<JudgmentOutcome> {
  return evaluateJudgmentInRegistry(
    batch,
    options,
    getPluginRegistryForContext(),
    getRuntimeConfig(),
  );
}

export async function evaluateJudgmentInRegistry(
  batch: JudgmentBatch,
  options: Options,
  registry: PluginRegistry | null,
  config: OpenClawConfig,
  consumerId?: string,
): Promise<JudgmentOutcome> {
  if (
    !options ||
    typeof options.purpose !== "string" ||
    !options.purpose ||
    options.purpose.length > 128 ||
    typeof options.rubricVersion !== "string" ||
    !options.rubricVersion ||
    options.rubricVersion.length > 128 ||
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    !(options.signal instanceof AbortSignal)
  ) {
    throw new JudgmentContractError();
  }
  options.signal.throwIfAborted();
  if (!validateJudgmentBatch(batch)) {
    return { status: "unavailable", reason: "unsupported-input" };
  }
  const selected = config.judgments?.provider;
  if (!selected) {
    return { status: "unavailable", reason: "disabled" };
  }
  if (config.plugins?.enabled === false) {
    return { status: "unavailable", reason: "disabled" };
  }
  const entry = registry?.judgmentProviders.find(
    (candidate) => candidate.host.provider.id === selected,
  );
  if (!entry || !registry) {
    return { status: "unavailable", reason: "not-configured" };
  }
  if (config.plugins?.entries?.[entry.pluginId]?.enabled === false) {
    return entry.host.unavailable("disabled");
  }
  // Root callers carry their own work signal: provider replacement may still allow fallback.
  // Prepared views additionally lose consumer authority when their finite view is released.
  if (getPluginRegistryResourceOwner(registry) === getPluginRegistryState()?.activeRegistry) {
    return entry.host.evaluate(batch, options, config, registry, consumerId);
  }
  const authority = capturePluginLifecycleAuthority(registry, undefined, { scopedRuntime: true });
  const lifetime = capturePluginRegistryLifecycleSignal(
    registry,
    capturePluginRegistryLifecycleEpoch(registry),
    { scopedRuntime: true },
  );
  if (!authority?.() || !lifetime) {
    throw new Error("Judgment consumer authority closed.");
  }
  const signal = AbortSignal.any([options.signal, lifetime]);
  const result = await entry.host.evaluate(
    batch,
    { ...options, signal },
    config,
    registry,
    consumerId,
  );
  signal.throwIfAborted();
  if (!authority()) {
    throw new Error("Judgment consumer authority closed.");
  }
  return result;
}

/** Abort before dependent consumers drain. Services subsequently join actual physical settlement. */
export function prepareJudgmentProviderReload(
  registry: PluginRegistry,
  changedPluginIds: ReadonlySet<string>,
) {
  const paused: ReturnType<JudgmentProviderHost["pauseForReload"]>[] = [];
  for (const entry of registry.judgmentProviders) {
    if (changedPluginIds.has(entry.pluginId)) {
      paused.push(entry.host.pauseForReload(changedPluginIds));
    } else {
      for (const pluginId of changedPluginIds) {
        entry.host.cancelConsumer(pluginId);
      }
    }
  }
  return {
    async rollback(signal: AbortSignal) {
      // Timeout only observes settlement: no detached continuation may reopen admission.
      await withPluginHostCleanupTimeout("judgment reload rollback", () =>
        Promise.all(paused.map((pause) => pause.settled)),
      );
      signal.throwIfAborted();
      for (const pause of paused) {
        pause.assertResumable();
      }
      for (const pause of paused) {
        pause.resume();
      }
    },
  };
}

export function inspectJudgmentProviders(
  config: OpenClawConfig,
  registry = getPluginRegistryForContext(),
) {
  return registry?.judgmentProviders.map((entry) => entry.host.inspect(config)) ?? [];
}

export async function recordJudgmentOutcome(
  outcome: "accepted" | "fallback" | "no-change",
  registry = getPluginRegistryForContext(),
): Promise<void> {
  const provider = getRuntimeConfig().judgments?.provider;
  registry?.judgmentProviders
    .find((entry) => entry.host.provider.id === provider)
    ?.host.recordOutcome(outcome);
}
