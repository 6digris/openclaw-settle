import assert from "node:assert/strict";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createChannelManager } from "./server-channels.js";

function createGeneration(label: string) {
  const marker = { label, enabled: true };
  return {
    marker: new WeakRef(marker),
    registry: createTestRegistry([
      {
        pluginId: "retention",
        source: "test",
        plugin: createChannelTestPluginBase({
          id: "retention",
          label,
          config: {
            listAccountIds: () => [label],
            resolveAccount: () => marker,
          },
        }),
      },
    ]),
  };
}

function prepareReplacement() {
  const { registry: initialRegistry, marker } = createGeneration("previous");
  let registry = initialRegistry;
  const reference = new WeakRef(registry);
  assert.ok(reference.deref());
  assert.ok(marker.deref());
  const manager = createChannelManager({
    getRuntimeConfig: () => ({}),
    getPluginRegistry: () => registry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  const publish = manager.pauseChannelStarts(["retention"]);
  registry = createGeneration("current").registry;
  const retry = manager.pauseChannelStarts(["retention"]);
  retry("rollback");
  return { manager, reference, marker, publish };
}

async function publishReplacement(collect: () => Promise<void>) {
  const { manager, reference, marker, publish } = prepareReplacement();
  await collect();
  assert.equal(manager.isAccountListed("retention", "previous"), true);
  assert.equal(manager.isAccountListed("retention", "current"), false);
  const snapshot = manager.getRuntimeSnapshot();
  assert.equal(snapshot.reloadingChannels?.has("retention"), true);
  assert.equal(snapshot.channels.retention?.accountId, "previous");
  publish("published");
  // The reload operation drops its release callback; the long-lived manager keeps the fence.
  return { manager, reference, marker };
}

export async function verifyPublishedChannelFenceRetention(collect: () => Promise<void>) {
  const { manager, reference, marker } = await publishReplacement(collect);
  await collect();
  assert.equal(reference.deref(), undefined, "Published channel fence retained its old registry");
  assert.equal(marker.deref(), undefined, "Published channel fence retained its old projection");
  assert.equal(manager.isAccountListed("retention", "previous"), false);
  assert.equal(manager.isAccountListed("retention", "current"), true);
  const snapshot = manager.getRuntimeSnapshot();
  assert.equal(snapshot.reloadingChannels?.has("retention") ?? false, false);
  assert.equal(snapshot.channels.retention?.accountId, "current");
}
