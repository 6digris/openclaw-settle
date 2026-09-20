import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createConfigIO } from "../config/io.factory.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import * as stateMigrations from "../infra/state-migrations.doctor.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";
import { planAutomaticConfigRepair } from "./doctor/shared/automatic-startup-config-repair.js";
import { planPristineStartupStateMigrations } from "./doctor/shared/pristine-startup-state.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
// Source exports have no emitted build-info; keep real lease/checkpoint storage
// while supplying the same deterministic build identity on reads and writes.
vi.mock("../infra/startup-migration-checkpoint.js", async (importActual) => {
  const actual = await importActual<typeof import("../infra/startup-migration-checkpoint.js")>();
  const pin = <P extends { buildIdentity?: string | null }, R>(fn: (params?: P) => R) =>
    ((params?: P) => fn({ buildIdentity: "d10-real-plan-test", ...params } as P)) as typeof fn;
  return {
    ...actual,
    readMigrationCheckpointStatus: pin(actual.readMigrationCheckpointStatus),
    recordSuccessfulStartupMigrations: pin(actual.recordSuccessfulStartupMigrations),
    recordSuccessfulStateMigrations: pin(actual.recordSuccessfulStateMigrations),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupSessionStateForTest();
});

it.each(["Doctor", "Gateway", "state-checkpoint"] as const)(
  "%s invokes general migrations with a real retained-install repair plan",
  async (caller) => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync(
        {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_UPDATE_IN_PROGRESS: undefined,
          OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: undefined,
        },
        async () => {
          const source = {
            gateway: { mode: "local" as const },
            agents: { entries: { main: {} } },
            plugins: {
              enabled: false,
              installs: {
                retained: {
                  source: "path" as const,
                  installPath: path.join(home, "retained-plugin"),
                },
              },
            },
          };
          const configPath = await writeOpenClawConfig(home, source);
          await fs.mkdir(path.join(path.dirname(configPath), "agents", "main"), {
            recursive: true,
          });
          expect(planPristineStartupStateMigrations().skipCoreStateMigrations).toBe(false);
          const snapshot = await createConfigIO({
            configPath,
            observe: false,
          }).readConfigFileSnapshot();
          expect(snapshot.valid).toBe(false);
          const plan = planAutomaticConfigRepair(snapshot);
          expect(plan?.snapshot.valid).toBe(true);
          expect(plan?.snapshot.config).not.toHaveProperty("plugins.installs");
          const migrate = vi.spyOn(stateMigrations, "autoMigrateLegacyState");
          const options = {
            migrateLegacyConfig: false,
            repairPrefixedConfig: true,
            invalidConfigNote: false as const,
            ...(caller === "Gateway" ? { requireStartupMigrationCheckpoint: true } : {}),
            ...(caller === "state-checkpoint" ? { requireStateMigrationCheckpoint: true } : {}),
          };
          const result = await runDoctorConfigPreflight(options);
          expect(result.snapshot.valid).toBe(true);
          expect(migrate).toHaveBeenCalledOnce();
          const input = migrate.mock.calls[0]?.[0];
          expect(input?.cfg).not.toHaveProperty("plugins.installs");
          expect(input?.pluginDoctorConfig).toHaveProperty(
            "plugins.installs",
            source.plugins.installs,
          );
          expect(input?.configIncludedPaths).toEqual([]);
          if (caller !== "Doctor") {
            migrate.mockClear();
            await runDoctorConfigPreflight(options);
            expect(migrate).not.toHaveBeenCalled();
          }
        },
      );
    });
  },
);

it("refuses an unavailable required owner before consuming the core repair preview", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        agents: { entries: { main: {} } },
        plugins: {
          allow: ["unavailable-owner"],
          entries: { "unavailable-owner": { enabled: true } },
          installs: {
            retained: { source: "path", installPath: path.join(home, "retained-plugin") },
          },
        },
      });
      await fs.mkdir(path.join(path.dirname(configPath), "agents", "main"), { recursive: true });
      const raw = await fs.readFile(configPath, "utf8");
      const snapshot = await createConfigIO({
        configPath,
        observe: false,
      }).readConfigFileSnapshot();
      expect(planAutomaticConfigRepair(snapshot, { pluginContracts: false })?.snapshot.valid).toBe(
        true,
      );
      const migrate = vi.spyOn(stateMigrations, "autoMigrateLegacyState");
      await expect(
        runDoctorConfigPreflight({
          migrateLegacyConfig: false,
          invalidConfigNote: false,
          requireStartupMigrationCheckpoint: true,
        }),
      ).rejects.toThrow("Plugin migration owners are unavailable: unavailable-owner");
      expect(migrate).not.toHaveBeenCalled();
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    });
  });
});
