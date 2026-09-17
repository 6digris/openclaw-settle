import assert from "node:assert/strict";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";
import { startGatewayEarlyRuntime } from "./server-startup-early.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

function createStartupInput() {
  return {
    minimalTestGateway: true,
    cfgAtStart: {},
    port: 18_789,
    gatewayTls: { enabled: false },
    gatewayDirectReachable: false,
    tailscaleMode: "off" as const,
    log: { info: () => {}, warn: () => {} },
    logDiscovery: { info: () => {}, warn: () => {} },
    nodeRegistry: null,
    swapDiscovery: () => null,
    ...createGatewayMaintenanceStateForTest(),
    skillsRefreshDelayMs: 30_000,
    getSkillsRefreshTimer: () => null,
    setSkillsRefreshTimer: () => {},
  };
}

function createGeneration() {
  return createGatewayPluginRuntimeGeneration({
    getServices: () => null,
    setServices: () => {},
  });
}

async function startWithRegistry() {
  const registry = createEmptyPluginRegistry();
  const marker = { calls: 0 };
  registry.gatewayHandlers.retention = () => {
    marker.calls += 1;
  };
  const generation = createGeneration();
  const claim = generation.currentClaim();
  const references = [new WeakRef(registry), new WeakRef(marker), new WeakRef(claim)];
  assert.ok(references.every((reference) => reference.deref() !== undefined));
  const runtime = await startGatewayEarlyRuntime({
    ...createStartupInput(),
    pluginRegistry: registry,
    pluginRuntimeClaim: claim,
  });
  generation.reserve().commit();
  assert.equal(claim.isCurrent(), false);
  assert.deepEqual(await disposePluginRegistryInstances(registry), {
    cleanupCount: 0,
    failures: [],
  });
  return { runtime, generation, references };
}

export async function verifyEarlyStartupRetention(collect: () => Promise<void>) {
  const { runtime, generation, references } = await startWithRegistry();
  try {
    await collect();
    assert.ok(
      references.every((reference) => reference.deref() === undefined),
      "Live early runtime retained its initial registry, callback, or claim",
    );
    assert.equal(generation.currentClaim().isCurrent(), true);
    assert.equal(runtime.getActiveTaskCount(), 0);
    assert.equal(await runtime.startMaintenance({}), null);
  } finally {
    await runtime.skillsChangeUnsub();
  }
}
