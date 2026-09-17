import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { readConfigFileSnapshotForRuntimeTransaction } from "../config/io.js";
import { resolveConfigWidePluginMetadataSnapshotAsync } from "../config/io.plugin-metadata.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { prepareHostConfigSnapshot } from "../config/io.snapshot-preparation.js";
import { registerManagedRuntimeConfigWriteOwner } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { type GatewayReloadPlan, startGatewayConfigReloader } from "./config-reload.js";

type ReloadOutcome =
  | { kind: "applied"; config: OpenClawConfig; reloadPlugins: boolean }
  | { kind: "invalid" | "error"; message: string };

function writePlugin(dir: string, id: string, required: string[] = []) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `@fixture/${id}`, openclaw: { extensions: ["./index.cjs"] } }),
  );
  fs.writeFileSync(path.join(dir, "index.cjs"), 'throw new Error("metadata fixture executed");');
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      configSchema: {
        type: "object",
        additionalProperties: false,
        required,
        properties: { endpoint: { type: "string" } },
      },
    }),
  );
}

async function withPreparedReloader(
  run: (fixture: {
    config: OpenClawConfig;
    bundledRoot: string;
    newPluginPath: string;
    change: (config: OpenClawConfig) => Promise<ReloadOutcome>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "reload-metadata" }, async (state) => {
    const bundledRoot = state.path("bundled");
    const newPluginPath = state.path("new-plugin");
    state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
    state.envVars.OPENCLAW_DISABLE_BUNDLED_PLUGINS = undefined;
    state.applyEnv();
    writePlugin(path.join(bundledRoot, "prepared"), "prepared");
    const config: OpenClawConfig = {
      gateway: { mode: "local" },
      agents: { entries: { main: {} }, defaults: { workspace: state.workspaceDir } },
      logging: { level: "info" },
      plugins: { slots: { memory: "none" }, entries: { prepared: { enabled: true } } },
    };
    let reloader: ReturnType<typeof startGatewayConfigReloader> | undefined;
    const unregister = registerManagedRuntimeConfigWriteOwner(
      state.configPath,
      undefined,
      prepareHostConfigSnapshot,
    );
    try {
      await state.writeConfig(config);
      const metadata = await resolveConfigWidePluginMetadataSnapshotAsync({ config });
      expect(metadata.plugins.map((plugin) => plugin.id)).toEqual(["prepared"]);
      setGatewayPluginMetadataSnapshot(metadata, { config });
      const initial = await readConfigFileSnapshotForRuntimeTransaction(config);
      expect(initial.valid).toBe(true);
      const watched = createDeferred();
      const outcome = createDeferred<ReloadOutcome>();
      const error = vi.fn((message: string) => outcome.resolve({ kind: "error", message }));
      const applied = async (plan: GatewayReloadPlan, nextConfig: OpenClawConfig) => {
        outcome.resolve({ kind: "applied", config: nextConfig, reloadPlugins: plan.reloadPlugins });
        return "applied" as const;
      };
      reloader = startGatewayConfigReloader({
        initialConfig: initial.config,
        initialCompareConfig: initial.sourceConfig,
        initialSnapshotRawHash: hashConfigRaw(initial.raw),
        initialAuthoredConfig: initial.parsed,
        initialSnapshotValid: initial.valid,
        initialSnapshotIssues: initial.issues,
        initialPluginInstallRecords: metadata.index.installRecords,
        watchPath: state.configPath,
        testDebounceMs: 0,
        onWatcherReady: watched.resolve,
        readSnapshot: readConfigFileSnapshotForRuntimeTransaction,
        onHotReload: applied,
        onNoopConfigCommit: applied,
        onRestart: () => {
          throw new Error("fixture change must hot reload");
        },
        log: {
          info: vi.fn(),
          warn: (message) => {
            if (message.startsWith("config reload skipped (invalid config):")) {
              outcome.resolve({ kind: "invalid", message });
            }
          },
          error,
        },
      });
      await Promise.all([reloader.ready, watched.promise]);
      const active = reloader;
      await run({
        config,
        bundledRoot,
        newPluginPath,
        change: async (nextConfig) => {
          await state.writeConfig(nextConfig);
          const result = await outcome.promise;
          await expect.poll(() => active.isReloading()).toBe(false);
          expect(error).not.toHaveBeenCalled();
          return result;
        },
      });
    } finally {
      await reloader?.stop();
      unregister();
      vi.restoreAllMocks();
      clearCurrentPluginMetadataSnapshot();
      clearPluginMetadataLifecycleCaches();
    }
  });
}

it("reuses prepared Gateway manifests for a logging-only watcher reload", async () => {
  await withPreparedReloader(async ({ config, bundledRoot, change }) => {
    const readdir = vi.spyOn(fs, "readdirSync");
    const result = await change({ ...config, logging: { level: "debug" } });
    expect(result).toMatchObject({ kind: "applied", config: { logging: { level: "debug" } } });
    // Observe only plugin discovery, not unrelated filesystem work owned by the reload.
    expect(readdir.mock.calls.filter(([dir]) => String(dir) === bundledRoot)).toEqual([]);
  });
});

it.each([true, false])(
  "validates a new watcher plugin path against its own schema (valid: %s)",
  async (valid) => {
    await withPreparedReloader(async ({ config, newPluginPath, change }) => {
      writePlugin(newPluginPath, "new-plugin", ["endpoint"]);
      const result = await change({
        ...config,
        plugins: {
          ...config.plugins,
          load: { paths: [newPluginPath] },
          entries: {
            ...config.plugins?.entries,
            "new-plugin": { enabled: true, config: valid ? { endpoint: "fixture" } : {} },
          },
        },
      });
      if (valid) {
        expect(result).toMatchObject({
          kind: "applied",
          reloadPlugins: true,
          config: { plugins: { entries: { "new-plugin": { config: { endpoint: "fixture" } } } } },
        });
      } else {
        expect(result).toMatchObject({
          kind: "invalid",
          message: expect.stringContaining("endpoint"),
        });
      }
    });
  },
);
