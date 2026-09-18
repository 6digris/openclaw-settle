import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { runPluginRegisterSyncInRegistry } from "../plugins/loader-module-runtime.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { collectRegistryInvocationInstances } from "../plugins/plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  bindPluginRegistryResourceOwner,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../plugins/registry-lifecycle.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { JudgmentProviderHost } from "./provider-host.js";
import { adoptRuntimeJudgmentProviders } from "./registry-adoption.js";
import {
  evaluateJudgmentInRegistry,
  inspectJudgmentProviders,
  prepareJudgmentProviderReload,
} from "./runtime.js";
import type { JudgmentProviderV1, ProviderJudgmentOutcome } from "./types.js";

const config = {
  judgments: { provider: "fixture" },
  plugins: { entries: { owner: { enabled: true, config: { model: "synthetic" } } } },
};
const batch = { state: "synthetic", questions: { check: { type: "boolean" as const } } };
const answer: ProviderJudgmentOutcome = {
  status: "ok",
  result: { model: "synthetic", answers: { check: { type: "boolean", probabilityTrue: 1 } } },
};
const options = () => ({
  purpose: "test",
  rubricVersion: "1",
  timeoutMs: 1_000,
  signal: new AbortController().signal,
});

function fixture(evaluate: JudgmentProviderV1["evaluate"] = async () => answer) {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "owner",
    source: "/synthetic/index.ts",
    origin: "global",
    enabled: true,
    configSchema: false,
    contracts: { judgmentProviders: ["fixture"] },
  });
  const api = builder.createApi(record, { config });
  runPluginRegisterSyncInRegistry(
    (registration) =>
      registration.registerJudgmentProvider({ id: "fixture", contractVersion: 1, evaluate }),
    api,
    builder.registry,
    record.id,
  );
  builder.registry.plugins.push(record);
  setActivePluginRegistry(builder.registry);
  setPluginRuntimeLoadContext(builder.registry, {
    rawConfig: config,
    config,
    activationSourceConfig: config,
    autoEnabledReasons: {},
    workspaceDir: "/synthetic",
    env: process.env,
    logger: { info() {}, warn() {}, error() {} },
  });
  onTestFinished(async () => {
    await getPluginInstance(record)?.dispose();
  });
  const target = createEmptyPluginRegistry();
  const localRecord = { ...record };
  const duplicate = vi.fn(async () => answer);
  target.plugins.push(localRecord);
  target.judgmentProviders.push({
    pluginId: record.id,
    host: new JudgmentProviderHost(
      { id: "fixture", contractVersion: 1, evaluate: duplicate },
      localRecord,
    ),
  });
  const view = bindPluginRegistryResourceOwner(
    adoptRuntimeJudgmentProviders(target, builder.registry, config),
    target,
  );
  const run = () => evaluateJudgmentInRegistry(batch, options(), view, config);
  return { root: builder.registry, target, view, record, duplicate, run };
}

afterEach(() => resetPluginRuntimeStateForTest());

describe("prepared judgment provider ownership", () => {
  it("shares Gateway counters, circuit state and instance custody across prepared views", async () => {
    const evaluate = vi.fn(async (): Promise<ProviderJudgmentOutcome> => ({
      status: "unavailable",
      reason: "transport",
    }));
    const { root, target, view, record, duplicate, run } = fixture(evaluate);
    expect(view.judgmentProviders[0]).toBe(root.judgmentProviders[0]);
    expect(target.judgmentProviders[0]).not.toBe(root.judgmentProviders[0]);
    expect(collectRegistryInvocationInstances(view).has(getPluginInstance(record)!)).toBe(true);
    await run();
    await evaluateJudgmentInRegistry(batch, options(), root, config);
    await run();
    expect(await evaluateJudgmentInRegistry(batch, options(), root, config)).toEqual({
      status: "unavailable",
      reason: "circuit-open",
    });
    expect(inspectJudgmentProviders(config, root)[0]?.reasons.transport).toBe(3);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("releases a prepared consumer without retiring the shared Gateway provider", async () => {
    let settled = false;
    const { root, target, view, run } = fixture(async (_batch, { signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      settled = true;
      signal.throwIfAborted();
      return answer;
    });
    // Prepared generation custody activates its finite primary registry without making it root.
    markPluginRegistryActive(target);
    const pending = run();
    markPluginRegistryRetired(target);
    await expect(pending).rejects.toBeDefined();
    expect(settled).toBe(true);
    await expect(evaluateJudgmentInRegistry(batch, options(), view, config)).rejects.toThrow(
      "consumer authority closed",
    );
    expect(inspectJudgmentProviders(config, root)[0]).toMatchObject({
      callable: true,
      activeRequests: 0,
    });
  });

  it("shares the concurrency bound and joins provider retirement before fallback", async () => {
    const { root, record, run } = fixture(async (_batch, { signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      signal.throwIfAborted();
      return answer;
    });
    const pending = [
      run(),
      run(),
      evaluateJudgmentInRegistry(batch, options(), root, config),
      run(),
    ];
    expect(await evaluateJudgmentInRegistry(batch, options(), root, config)).toEqual({
      status: "unavailable",
      reason: "overloaded",
    });
    const pause = prepareJudgmentProviderReload(root, new Set([record.id]));
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 4 }, () => ({ status: "unavailable", reason: "retiring" })),
    );
    await pause.rollback(new AbortController().signal);
    expect(inspectJudgmentProviders(config, root)[0]).toMatchObject({
      callable: true,
      activeRequests: 0,
    });
  });

  it("never adopts across a shadowed source, changed config, or retired owner", () => {
    const { root, target } = fixture();
    expect(
      adoptRuntimeJudgmentProviders(target, root, {
        ...config,
        plugins: { entries: { owner: { config: { model: "other" } } } },
      }),
    ).toBe(target);
    target.plugins[0]!.source = "/workspace/shadow.ts";
    expect(adoptRuntimeJudgmentProviders(target, root, config)).toBe(target);
    target.plugins[0]!.source = root.plugins[0]!.source;
    markPluginRegistryRetired(root);
    expect(adoptRuntimeJudgmentProviders(target, root, config)).toBe(target);
  });
});
