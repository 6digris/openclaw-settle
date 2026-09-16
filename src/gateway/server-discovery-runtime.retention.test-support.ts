import assert from "node:assert/strict";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginGatewayDiscoveryServiceRegistration } from "../plugins/registry-types.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
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
