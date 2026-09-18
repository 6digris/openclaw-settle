import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { resolveDeferredPluginMigrationConfigPaths } from "../config/deferred-plugin-migration-config.js";
import { readConfigFileSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { acquireStartupMigrationLease } from "../infra/startup-migration-checkpoint.js";
import { readBundledDiscoveryMode } from "../plugins/bundled-discovery-state.js";
import { readPersistedInstalledPluginIndexRowSync } from "../plugins/installed-plugin-index-row.js";
import { writePersistedInstalledPluginIndexWithLeaseSync } from "../plugins/installed-plugin-index-store-write.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import * as metadataStateWorker from "../plugins/plugin-metadata-state-worker.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { readDoctorConfigPreflightSnapshot } from "./doctor-config-preflight-plugin-index.js";
import {
  prepareDoctorMigrationPlugins,
  readStartupMigrationSnapshot,
} from "./doctor-config-preflight-startup.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { planAutomaticConfigRepair } from "./doctor/shared/automatic-startup-config-repair.js";

it("reads discovery policy and index from one generation, then releases it before migration guards", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
    const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ gateway: { mode: "local" }, plugins: { enabled: false } }),
    );
    const options = { env: process.env };
    const { path: databasePath } = openOpenClawStateDatabase(options);
    closeOpenClawStateDatabaseForTest();
    const writer = new DatabaseSync(databasePath);
    const family = () =>
      ["", "-wal", "-shm"].map((suffix) => {
        const pathname = databasePath + suffix;
        return fs.existsSync(pathname) ? fs.readFileSync(pathname) : null;
      });
    const readIndex = () =>
      readPersistedInstalledPluginIndexRowSync({ env: process.env })?.value_json;
    try {
      const insert = writer.prepare(
        "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, 1)",
      );
      insert.run("plugins.bundledDiscovery", '"compat"');
      insert.run("plugins.installedIndex", '{"generation":"before"}');
      const before = family();
      let afterWrite: ReturnType<typeof family> | undefined;
      const result = await readStartupMigrationSnapshot({
        env: process.env,
        readSnapshot: async () => {
          const snapshot = await readConfigFileSnapshot({
            observe: false,
            pluginValidation: "core-only",
          });
          expect(readBundledDiscoveryMode(options)).toBe("compat");
          expect(family()).toEqual(before);
          // A different owner commits between the two metadata reads.
          writer.exec(
            `BEGIN;
             UPDATE config_machine_state SET value_json = '"allowlist"' WHERE state_key = 'plugins.bundledDiscovery';
             UPDATE config_machine_state SET value_json = '{"generation":"after"}' WHERE state_key = 'plugins.installedIndex';
             COMMIT;`,
          );
          afterWrite = family();
          expect(readIndex()).toBe('{"generation":"before"}');
          expect(family()).toEqual(afterWrite);
          return { snapshot, pluginMigrationFingerprint: null };
        },
        planRepair: ({ snapshot }) => planAutomaticConfigRepair(snapshot),
        beforeStateMigrations: async () => {
          expect(readBundledDiscoveryMode(options)).toBe("allowlist");
          expect(readIndex()).toBe('{"generation":"after"}');
          return true;
        },
      });
      expect(result.snapshot.valid).toBe(true);
      expect(family()).toEqual(afterWrite);
    } finally {
      writer.close();
      closeOpenClawStateDatabaseForTest();
    }
  });
});

it("refuses a session-store change between core admission and the full config read", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
    const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const config = { gateway: { mode: "local" }, plugins: { enabled: false } };
    fs.writeFileSync(configPath, JSON.stringify(config));
    const legacyStore = path.join(home, "other", "sessions.json");
    fs.mkdirSync(path.dirname(legacyStore));
    fs.writeFileSync(legacyStore, "{}\n");
    const changedConfig = JSON.stringify({ ...config, session: { store: legacyStore } });

    await expect(
      readStartupMigrationSnapshot({
        env: process.env,
        readSnapshot: async () => {
          // Simulate an operator edit while the asynchronous admission read is in flight.
          fs.writeFileSync(configPath, changedConfig);
          return {
            snapshot: await readConfigFileSnapshot({ observe: false }),
            pluginMigrationFingerprint: null,
          };
        },
        planRepair: ({ snapshot }) => planAutomaticConfigRepair(snapshot),
      }),
    ).rejects.toMatchObject({ code: 78, message: expect.stringContaining("inputs changed") });
    expect(fs.readFileSync(configPath, "utf8")).toBe(changedConfig);
    expect(fs.readFileSync(legacyStore, "utf8")).toBe("{}\n");
    expect(fs.existsSync(path.join(stateDir, "state"))).toBe(false);
  });
});

it("admits active pending-plugin inputs without selecting an older valid backup", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
    const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const source = {
      gateway: { mode: "local", port: 18991 },
      plugins: { entries: { canvas: { enabled: true } } },
      canvasHost: { enabled: true, root: path.join(home, "legacy-canvas") },
    };
    const activeRaw = `${JSON.stringify(source, null, 2)}\n`;
    const backupRaw = JSON.stringify({
      gateway: { mode: "local", port: 18789 },
      plugins: { enabled: false },
    });
    fs.writeFileSync(configPath, activeRaw);
    fs.writeFileSync(`${configPath}.bak`, backupRaw);
    const initial = await readConfigFileSnapshot({ observe: false, pluginValidation: "core-only" });
    expect(initial.valid).toBe(false);

    const readiness = await import("../state/openclaw-database-preflight.js");
    const assertReady = readiness.assertOpenClawDatabasesReady;
    let databaseAdmitted = false;
    const admission = vi
      .spyOn(readiness, "assertOpenClawDatabasesReady")
      .mockImplementation(async (params) => {
        await assertReady(params);
        databaseAdmitted = true;
      });
    try {
      const result = await readStartupMigrationSnapshot({
        env: process.env,
        readSnapshot: async () => ({
          snapshot: await readConfigFileSnapshot({ observe: false }),
          pluginMigrationFingerprint: null,
        }),
        planRepair: ({ snapshot }) => planAutomaticConfigRepair(snapshot),
        preparePluginMigrations: async (snapshot) => {
          expect(databaseAdmitted).toBe(true);
          expect(snapshot.raw).toBe(activeRaw);
          expect(snapshot.hash).toBe(initial.hash);
          expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
          return [
            {
              pluginId: "canvas",
              reason: "The configured plugin is not installed.",
              command: "openclaw doctor --fix",
              ...resolveDeferredPluginMigrationConfigPaths({
                config: snapshot.sourceConfig,
                pluginId: "canvas",
                compatibilityMigrationPaths: ["canvasHost"],
              }),
            },
          ];
        },
      });
      expect(result.recovery).toBeUndefined();
      expect(result.snapshot.valid).toBe(true);
      expect(result.snapshot.hash).toBe(initial.hash);
      expect(result.snapshot.raw).toBe(activeRaw);
      expect(result.snapshot.sourceConfig).toMatchObject(source);
      expect(result.snapshot.config.gateway?.port).toBe(18991);
      expect(result.snapshot.config).not.toHaveProperty("canvasHost");
      expect(fs.readFileSync(configPath, "utf8")).toBe(activeRaw);
      expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe(backupRaw);
      expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
    } finally {
      admission.mockRestore();
    }
  });
});

it.each([
  { mode: "prepared readonly", metadata: true, converge: false, expectedReads: 0 },
  { mode: "unprepared readonly", metadata: false, converge: false, expectedReads: 1 },
  { mode: "convergence", metadata: true, converge: true, expectedReads: 1 },
])(
  "uses admitted install records during $mode plugin preparation",
  async ({ metadata, converge, expectedReads }) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
      const configPath = process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
      const bundledRoot = path.join(home, "bundled");
      fs.mkdirSync(bundledRoot);
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const config: OpenClawConfig = { gateway: { mode: "local" }, plugins: { enabled: false } };
      fs.writeFileSync(configPath, JSON.stringify(config));
      const readSnapshot = () =>
        readDoctorConfigPreflightSnapshot({
          allowCurrentPluginMetadata: false,
          includePluginMetadata: true,
          preparePluginMetadataSnapshot: true,
          skipPluginValidation: false,
          observe: false,
        });
      const rowRead = vi.spyOn(metadataStateWorker, "readPluginMetadataStateRow");
      try {
        openOpenClawStateDatabase({ env: process.env });
        const initial = await readSnapshot();
        if (!initial.pluginMetadataSnapshot) {
          throw new Error("Expected real Doctor metadata before persisting the fixture index");
        }
        const lease = acquireStartupMigrationLease();
        try {
          writePersistedInstalledPluginIndexWithLeaseSync(initial.pluginMetadataSnapshot.index, {
            env: process.env,
            lease,
          });
        } finally {
          lease.release();
        }
        const prepared = await readSnapshot();
        expect(prepared.snapshot.valid).toBe(true);
        expect(prepared.pluginMetadataSnapshot?.registrySource).toBe("persisted");
        const snapshotRead = metadata
          ? prepared
          : {
              snapshot: prepared.snapshot,
              pluginMigrationFingerprint: prepared.pluginMigrationFingerprint,
            };
        rowRead.mockClear();
        const refreshedRead = vi.fn(async () => prepared);
        const guard = vi.fn(async () => true);
        const warnings = vi.fn();
        const deferred = vi.fn();
        const result = await withPluginCache(createPluginCache(), () =>
          prepareDoctorMigrationPlugins({
            cfg: config,
            env: process.env,
            converge,
            lease: undefined,
            snapshotRead,
            readRefreshedSnapshot: refreshedRead,
            beforeStateMigrations: guard,
            onWarnings: warnings,
            onDeferredPlugins: deferred,
          }),
        );
        expect(
          rowRead.mock.calls.filter(([selector]) => selector === "installed-index"),
        ).toHaveLength(expectedReads);
        expect(result).toBe(converge ? prepared : snapshotRead);
        expect(refreshedRead).toHaveBeenCalledTimes(converge ? 1 : 0);
        expect(guard).toHaveBeenCalledTimes(converge ? 1 : 0);
        expect(warnings).toHaveBeenCalledWith([]);
        expect(deferred).toHaveBeenCalledWith([], undefined);
      } finally {
        rowRead.mockRestore();
        await closeOpenClawStateDatabaseAsync();
        closeOpenClawStateDatabaseForTest();
      }
    });
  },
);
