import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPluginModuleLoader } from "./loader-module-runtime.js";
import {
  createPluginCache,
  retirePluginCache,
  withPluginCache,
  type PluginCache,
} from "./plugin-cache.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { resolveDirectBundledProviderPolicySurface } from "./provider-policy-surface.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  clearActivePluginRegistry,
  setActivePluginRegistry,
  waitForPluginRegistryRetirement,
} from "./runtime.js";
import { createPluginRecord } from "./status.test-helpers.js";

async function retirePolicySelection(cache: PluginCache, root?: string) {
  const registry = createEmptyPluginRegistry();
  let instance: WeakRef<NonNullable<ReturnType<typeof getPluginInstance>>> | undefined;
  if (root) {
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"commonjs"}');
    fs.writeFileSync(path.join(root, "index.cjs"), "module.exports = {};\n");
    fs.writeFileSync(
      path.join(root, "provider-policy-api.js"),
      'exports.normalizeModelCatalogId = () => "managed-policy";\n',
    );
    const record = createPluginRecord({
      id: "retention-policy",
      source: path.join(root, "index.cjs"),
      rootDir: root,
      origin: "workspace",
    });
    registry.plugins.push(record);
    withPluginCache(cache, () => {
      const load = createPluginModuleLoader({ installNativeSdkResolver: false });
      load(record.source, { record, rootDir: root, registry });
    });
    const owner = getPluginInstance(record);
    assert.ok(owner);
    instance = new WeakRef(owner);
  }
  setActivePluginRegistry(registry);
  const surface = withPluginCache(cache, () =>
    resolveDirectBundledProviderPolicySurface("retention-policy"),
  );
  if (root) {
    assert.equal(
      surface?.normalizeModelCatalogId?.({ provider: "retention-policy", modelId: "authored" }),
      "managed-policy",
    );
  } else {
    assert.equal(surface, null);
  }
  const reference = new WeakRef(registry);
  setActivePluginRegistry(createEmptyPluginRegistry());
  await waitForPluginRegistryRetirement(registry);
  return { reference, instance };
}

export async function runPolicyCacheRetention(mode: string, collect: () => Promise<void>) {
  const cache = createPluginCache();
  // openclaw-temp-dir: allow -- standalone GC child joins instance cleanup before removing its fixture.
  const root =
    mode === "policy-cache-managed"
      ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "policy-retention-")))
      : undefined;
  try {
    const { reference, instance } = await retirePolicySelection(cache, root);
    if (mode === "policy-cache-retired") {
      await retirePluginCache(cache);
    }
    await collect();
    // The managed instance is registration-local; raw native module exports are not this marker.
    assert.equal(instance?.deref(), undefined, "Policy cache retained its retired instance");
    assert.equal(reference.deref(), undefined, "Policy cache retained its retired registry");
  } finally {
    await clearActivePluginRegistry();
    // A completed operation cache can remain reachable through a native async resource.
    await retirePluginCache(cache);
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}
