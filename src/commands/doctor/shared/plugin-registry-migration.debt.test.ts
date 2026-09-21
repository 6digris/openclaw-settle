import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfigFileSnapshot } from "../../../config/config.js";
import {
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
} from "../../../infra/deferred-plugin-migrations.js";
import { seedInstalledPluginIndex } from "../../../plugins/test-helpers/installed-plugin-index.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withDoctorConfigPreflightHome } from "../../doctor-config-preflight.test-support.js";
import { importAutomaticConfigRepairInstallRecords } from "./automatic-startup-config-repair.js";
import {
  assertShippedPluginInstallConfigImportCurrent,
  importShippedPluginInstallConfigForDoctor,
  prepareShippedPluginInstallConfigImport,
} from "./plugin-registry-migration.js";

const hooks = vi.hoisted(() => ({ beforeIndexWrite: undefined as (() => void) | undefined }));
vi.mock("../../../plugins/installed-plugin-index-records.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../plugins/installed-plugin-index-records.js")>();
  return {
    ...actual,
    writePersistedInstalledPluginIndexInstallRecordsWithLease: (
      ...args: Parameters<typeof actual.writePersistedInstalledPluginIndexInstallRecordsWithLease>
    ) => {
      const inject = hooks.beforeIndexWrite;
      hooks.beforeIndexWrite = undefined;
      inject?.();
      // The real writer invokes inherited lease authority inside its SQLite transaction.
      return actual.writePersistedInstalledPluginIndexInstallRecordsWithLease(...args);
    },
  };
});
afterEach(() => {
  hooks.beforeIndexWrite = undefined;
});

const retained = {
  pluginId: "migration-proof-plugin",
  reason: "Historical work remains unfinished.",
  command: "openclaw doctor --fix",
};
const rows = () =>
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => ({
    index:
      db
        .prepare("SELECT * FROM config_machine_state WHERE state_key = ?")
        .get("plugins.installedIndex") ?? null,
    debt: db
      .prepare("SELECT * FROM migration_runs WHERE id LIKE ? ORDER BY id")
      .all("deferred-plugin-migration:%"),
  }));

describe("importer debt guard at canonical publication", () => {
  it.each([
    { index: "absent", change: "stronger" },
    { index: "empty", change: "stronger" },
    { index: "existing", change: "stronger" },
    { index: "absent", change: "added" },
    { index: "existing", change: "removed" },
    { index: "absent", change: "none" },
    { index: "empty", change: "none" },
    { index: "existing", change: "none" },
  ] as const)(
    "$change debt with $index index after awaited admission",
    async ({ index, change }) => {
      await withDoctorConfigPreflightHome(async (home) =>
        withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(home, ".openclaw");
          const configPath =
            process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json");
          const includePath = path.join(stateDir, "plugins.json");
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(
            includePath,
            JSON.stringify({
              enabled: false,
              installs: {
                [retained.pluginId]: {
                  source: "path",
                  sourcePath: path.join(home, "legacy-plugin"),
                  installPath: path.join(home, "legacy-plugin"),
                },
              },
            }),
          );
          fs.writeFileSync(
            configPath,
            JSON.stringify({ gateway: { mode: "local" }, plugins: { $include: "./plugins.json" } }),
          );
          fs.writeFileSync(`${configPath}.bak`, "operator backup\n");
          openOpenClawStateDatabase();
          if (index !== "absent") {
            await seedInstalledPluginIndex(
              index === "empty"
                ? {}
                : { existing: { source: "path", installPath: path.join(home, "existing-owner") } },
              { config: { plugins: { enabled: false } } },
            );
          }
          recordDeferredPluginMigrations({ pending: [retained] });
          const expectedPending = readDeferredPluginMigrations();
          const snapshot = await readConfigFileSnapshot({
            observe: false,
            pluginValidation: "core-only",
          });
          const prepared = await prepareShippedPluginInstallConfigImport(snapshot);
          expect(prepared).toBeDefined();
          if (!prepared) {
            throw new Error("fixture missing inventory");
          }
          const source = () =>
            [configPath, includePath, `${configPath}.bak`].map((p) => fs.readFileSync(p));
          const original = source();
          let before = rows();
          let reachedPublication = false;
          hooks.beforeIndexWrite = () => {
            reachedPublication = true;
            if (change === "removed") {
              recordDeferredPluginMigrations({
                pending: [],
                resolvedPluginIds: [retained.pluginId],
                expectedPending,
              });
            } else if (change !== "none") {
              recordDeferredPluginMigrations({
                pending: [
                  change === "added"
                    ? { ...retained, pluginId: "another-owner" }
                    : { ...retained, requiresStateMigration: true },
                ],
              });
            }
            before = rows();
          };
          let validated = false;
          const importing = importShippedPluginInstallConfigForDoctor(snapshot, {
            prepared,
            expectedPending,
            validateRecords: async () => {
              await Promise.resolve();
              validated = true;
            },
          });
          if (change === "none") {
            const receipt = await importing;
            expect(receipt?.pluginInventoryChanged).toBe(true);
            expect(() =>
              assertShippedPluginInstallConfigImportCurrent(snapshot, receipt),
            ).not.toThrow();
            expect(rows()?.index).not.toEqual(before?.index);
            expect(rows()?.debt).toEqual(before?.debt);
          } else {
            await expect(importing).rejects.toThrow(/Plugin migration obligations changed/);
            // Compare exact SQL values and timestamps, including absence, not just parsed records.
            expect(rows()).toEqual(before);
          }
          expect(source()).toEqual(original);
          expect(validated).toBe(true);
          expect(reachedPublication).toBe(true);
        }),
      );
    },
  );
});

describe("automatic repair importer debt admission", () => {
  it.each(["before-import", "before-publication", "unchanged"] as const)(
    "preserves canonical ownership when debt is %s",
    async (change) => {
      await withDoctorConfigPreflightHome(async (home) =>
        withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const configPath =
            process.env.OPENCLAW_CONFIG_PATH ?? path.join(home, ".openclaw", "openclaw.json");
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          const raw = JSON.stringify({
            gateway: { mode: "local" },
            plugins: {
              enabled: false,
              installs: {
                [retained.pluginId]: {
                  source: "path",
                  installPath: path.join(home, "legacy-plugin"),
                },
              },
            },
          });
          fs.writeFileSync(configPath, raw);
          fs.writeFileSync(`${configPath}.bak`, "operator backup\n");
          openOpenClawStateDatabase();
          recordDeferredPluginMigrations({ pending: [retained] });
          const expectedPending = readDeferredPluginMigrations();
          const snapshot = await readConfigFileSnapshot({
            observe: false,
            pluginValidation: "core-only",
          });
          let before = rows();
          const strengthenDebt = () => {
            recordDeferredPluginMigrations({
              pending: [{ ...retained, requiresStateMigration: true }],
            });
            before = rows();
          };
          if (change === "before-import") {
            strengthenDebt();
          } else if (change === "before-publication") {
            hooks.beforeIndexWrite = strengthenDebt;
          }
          const importing = importAutomaticConfigRepairInstallRecords(snapshot, expectedPending);
          if (change === "unchanged") {
            expect((await importing)?.pluginInventoryChanged).toBe(true);
            expect(rows()?.index).not.toEqual(before?.index);
            expect(rows()?.debt).toEqual(before?.debt);
          } else {
            await expect(importing).rejects.toThrow(/Plugin migration obligations changed/);
            expect(rows()).toEqual(before);
          }
          expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
          expect(fs.readFileSync(`${configPath}.bak`, "utf8")).toBe("operator backup\n");
        }),
      );
    },
  );
});
