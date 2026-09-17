import assert from "node:assert/strict";
import { createUnavailableRuntime } from "../plugins/api-builder.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginGatewayDiscoveryServiceRegistration } from "../plugins/registry-types.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withEnvAsync } from "../test-utils/env.js";
import { startGatewayDiscovery, type GatewayDiscovery } from "./server-discovery-runtime.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";

async function updateFromRequest(
  discovery: GatewayDiscovery,
  entry: PluginGatewayDiscoveryServiceRegistration,
) {
  const registry = createEmptyPluginRegistry();
  const marker = { calls: 0 };
  registry.gatewayHandlers.retention = () => {
    marker.calls += 1;
  };
  const reference = new WeakRef(registry);
  await withPluginRuntimeRegistryScope(registry, () =>
    discovery.update({ gatewayDiscoveryServices: [entry] }),
  );
  return { reference, marker: new WeakRef(marker) };
}

export async function verifyDiscoveryTimerRetention(collect: () => Promise<void>) {
  await withEnvAsync(
    { NODE_ENV: "development", VITEST: undefined, OPENCLAW_DISABLE_BONJOUR: undefined },
    async () => {
      const owner = createGatewayPluginRuntimeGeneration({
        getServices: () => null,
        setServices: () => {},
      });
      let starts = 0;
      let stops = 0;
      const entry = {
        id: "retention",
        pluginId: "retention",
        pluginName: "Retention",
        source: "test",
        service: {
          id: "retention",
          advertise: async () => {
            starts += 1;
            return {
              stop: () => {
                stops += 1;
              },
            };
          },
        },
      };
      const discovery = await startGatewayDiscovery({
        pluginRuntimeClaim: owner.currentClaim(),
        machineDisplayName: "Retention",
        port: 18789,
        tailscaleMode: "off",
        logDiscovery: { info: () => {}, warn: () => {} },
      });
      try {
        const { reference, marker } = await updateFromRequest(discovery, entry);
        assert.equal(starts, 1);
        assert.equal(stops, 0);
        await collect();
        assert.equal(reference.deref(), undefined, "Live discovery retained its startup registry");
        assert.equal(marker.deref(), undefined, "Live discovery retained its startup callback");
        await discovery.stop();
        assert.equal(stops, 1);
      } finally {
        await discovery.stop();
      }
      assert.equal(stops, 1);
    },
  );
}

type DiscoveryCounts = { starts: number; stops: number; disposals: number };

function createManagedDiscoveryRegistration(counts: DiscoveryCounts, pending?: Promise<void>) {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {} },
    runtime: createUnavailableRuntime("setup-only", "discovery-retention"),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "discovery-retention",
    source: "test",
    origin: "workspace",
    enabled: true,
    configSchema: false,
  });
  builder.registry.plugins.push(record);
  const instance = new PluginInstance(record.id, { record, registry: builder.registry });
  const sentinel = { calls: 0 };
  const advertise = async () => {
    sentinel.calls += 1;
    counts.starts += 1;
    await pending;
    return { stop: () => void (counts.stops += 1) };
  };
  instance.run(() => {
    instance.lifecycle.onDispose(() => void (counts.disposals += 1));
    builder.createApi(record, { config: {} }).registerGatewayDiscoveryService({
      id: "discovery-retention",
      advertise,
    });
  });
  return {
    registry: builder.registry,
    instance,
    references: {
      registry: new WeakRef(builder.registry),
      instance: new WeakRef(instance),
      registration: new WeakRef(builder.registry.gatewayDiscoveryServices[0]!),
      callback: new WeakRef(advertise),
      sentinel: new WeakRef(sentinel),
    },
  };
}

async function replaceStartupDiscovery(late: boolean, counts: DiscoveryCounts[]) {
  const released = createDeferredCore();
  const old = createManagedDiscoveryRegistration(counts[0]!, late ? released.promise : undefined);
  const current = createManagedDiscoveryRegistration(counts[1]!);
  const owner = createGatewayPluginRuntimeGeneration({
    getServices: () => null,
    setServices: () => {},
  });
  // The host's acquisition deadline is unref'ed; keep this child alive until the late reply.
  const keepAlive = setInterval(() => {}, 1_000);
  let discovery: GatewayDiscovery | undefined;
  try {
    discovery = await startGatewayDiscovery({
      gatewayDiscoveryServices: old.registry.gatewayDiscoveryServices,
      pluginRuntimeClaim: owner.currentClaim(),
      machineDisplayName: "Retention",
      port: 18789,
      tailscaleMode: "off",
      logDiscovery: { info() {}, warn() {} },
    });
    const replacement = owner.reserve();
    replacement.commit();
    await discovery.update(
      { gatewayDiscoveryServices: current.registry.gatewayDiscoveryServices },
      replacement.claim,
    );
    released.resolve();
    await old.instance.dispose();
    assert.deepEqual(counts[0], { starts: 1, stops: 1, disposals: 1 });
    assert.deepEqual(counts[1], { starts: 1, stops: 0, disposals: 0 });
    return { discovery, current, references: old.references };
  } catch (error) {
    released.resolve();
    await discovery?.stop();
    await Promise.all([old.instance.dispose(), current.instance.dispose()]);
    throw error;
  } finally {
    clearInterval(keepAlive);
  }
}

export async function verifyDiscoveryStartupRetention(collect: () => Promise<void>, late: boolean) {
  await withEnvAsync(
    {
      NODE_ENV: "development",
      VITEST: undefined,
      OPENCLAW_DISABLE_BONJOUR: undefined,
      OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS: "5",
    },
    async () => {
      const counts = [
        { starts: 0, stops: 0, disposals: 0 },
        { starts: 0, stops: 0, disposals: 0 },
      ];
      const { discovery, current, references } = await replaceStartupDiscovery(late, counts);
      try {
        await collect();
        for (const [kind, reference] of Object.entries(references)) {
          assert.equal(
            reference.deref(),
            undefined,
            `Live discovery retained its retired startup ${kind}`,
          );
        }
        // A successor remains callable after the initial registration has been released.
        await discovery.update({ gatewayTlsFingerprintSha256: "successor-probe" });
        assert.deepEqual(counts[1], { starts: 2, stops: 1, disposals: 0 });
      } finally {
        await discovery.stop();
        await discovery.stop();
        await current.instance.dispose();
      }
      assert.deepEqual(counts[0], { starts: 1, stops: 1, disposals: 1 });
      assert.deepEqual(counts[1], { starts: 2, stops: 2, disposals: 1 });
    },
  );
}
