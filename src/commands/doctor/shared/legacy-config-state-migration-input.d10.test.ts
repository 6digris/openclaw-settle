import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { getDeferredPluginMigrationConfigFacts } from "../../../config/deferred-plugin-migration-config.js";
import { createConfigIO } from "../../../config/io.factory.js";
import { getResolvedConfigEnvSecretRef } from "../../../config/resolution-facts.js";
import { writeOpenClawConfig } from "../../../config/test-helpers.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { resolveMigrationCheckpointIdentity } from "../../doctor-config-preflight-checkpoint.js";
import { withDoctorConfigPreflightHome } from "../../doctor-config-preflight.test-support.js";
import { planAutomaticConfigRepair } from "./automatic-startup-config-repair.js";
import { resolveStateMigrationConfigInput } from "./legacy-config-state-migration-input.js";

afterEach(() => vi.restoreAllMocks());

it("uses the validated runtime projection without completing a deferred state owner", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
      const retained = { root: path.join(home, "pending-state") };
      const configPath = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        plugins: {
          enabled: false,
          installs: { retained: { source: "path", installPath: path.join(home, "plugin") } },
        },
        legacyPluginInput: retained,
      });
      const pending = [
        {
          pluginId: "pending-owner",
          reason: "Unavailable owner",
          command: "openclaw update repair",
          requiresStateMigration: true as const,
          configPaths: [["legacyPluginInput"]],
          validationExcludedPaths: [["legacyPluginInput"]],
        },
      ];
      const snapshot = await createConfigIO({
        configPath,
        observe: false,
        deferredPluginMigrations: pending,
      }).readConfigFileSnapshot();
      const originalSource = snapshot.sourceConfigBeforeMigrations;
      const plan = planAutomaticConfigRepair(snapshot);
      expect(plan?.snapshot.valid).toBe(true);
      expect(plan?.config).toHaveProperty("legacyPluginInput", retained);
      expect(plan?.snapshot.config).not.toHaveProperty("legacyPluginInput");
      const selected = resolveStateMigrationConfigInput({
        snapshot,
        baseConfig: snapshot.sourceConfig,
        postConvergenceConfig: plan?.snapshot.config,
      });
      expect(selected?.cfg).toBe(plan?.snapshot.config);
      expect(selected?.cfg).not.toHaveProperty("plugins.installs");
      expect(selected?.pluginDoctorConfig).toBe(snapshot.sourceConfig);
      expect(selected?.pluginDoctorConfig).toHaveProperty("legacyPluginInput", retained);
      expect(getDeferredPluginMigrationConfigFacts(selected?.pluginDoctorConfig)).toEqual(pending);
      expect(snapshot.sourceConfigBeforeMigrations).toBe(originalSource);
      // Repair projection is not permission to checkpoint the still-invalid source.
      expect(
        resolveMigrationCheckpointIdentity({
          snapshot,
          baseConfig: snapshot.sourceConfig,
          pluginMigrationFingerprint: "fixture",
        }),
      ).toBeNull();
    });
  });
});

it("retains read-time environment provenance and authored bytes at the handoff", async () => {
  await withDoctorConfigPreflightHome(async (home) => {
    await withEnvAsync(
      { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", D10_PROVIDER_KEY: "synthetic-key" },
      async () => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          plugins: {
            enabled: false,
            installs: { retained: { source: "path", installPath: path.join(home, "plugin") } },
          },
          models: {
            providers: {
              fixture: {
                baseUrl: "https://fixture.invalid/v1",
                api: "openai-completions",
                apiKey: "${D10_PROVIDER_KEY}",
                models: [{ id: "fixture", name: "Fixture" }],
              },
            },
          },
        });
        const raw = await fs.readFile(configPath, "utf8");
        const snapshot = await createConfigIO({
          configPath,
          observe: false,
        }).readConfigFileSnapshot();
        const plan = planAutomaticConfigRepair(snapshot);
        expect(plan?.snapshot.valid).toBe(true);
        const selected = resolveStateMigrationConfigInput({
          snapshot,
          baseConfig: snapshot.sourceConfig,
          postConvergenceConfig: plan?.snapshot.config,
        });
        expect(
          getResolvedConfigEnvSecretRef(selected?.cfg, "models.providers.fixture.apiKey")?.id,
        ).toBe("D10_PROVIDER_KEY");
        expect(
          getResolvedConfigEnvSecretRef(
            selected?.pluginDoctorConfig,
            "models.providers.fixture.apiKey",
          )?.id,
        ).toBe("D10_PROVIDER_KEY");
        expect(plan?.writeConfig.models?.providers?.fixture?.apiKey).toBe("${D10_PROVIDER_KEY}");
        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      },
    );
  });
});

it.each(["partial", "include", "preview"] as const)(
  "does not promote a %s config without an accepted full plan",
  async (kind) => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const source = {
          gateway: { mode: "local", ...(kind === "partial" ? { port: "invalid" } : {}) },
          plugins: {
            enabled: false,
            installs: { retained: { source: "path", installPath: path.join(home, "plugin") } },
          },
          ...(kind === "partial" ? { tools: { exec: { timeoutSec: 45 } } } : {}),
        };
        const configPath = await writeOpenClawConfig(home, source);
        if (kind === "include") {
          await fs.writeFile(
            path.join(path.dirname(configPath), "included.json"),
            JSON.stringify(source),
          );
          await fs.writeFile(configPath, JSON.stringify({ $include: "included.json" }));
        }
        const snapshot = await createConfigIO({
          configPath,
          observe: false,
        }).readConfigFileSnapshot();
        expect(snapshot.valid).toBe(false);
        const plan = planAutomaticConfigRepair(snapshot, { pluginContracts: kind !== "preview" });
        if (kind === "preview") {
          expect(plan?.snapshot.valid).toBe(true);
        } else {
          expect(plan).toBeNull();
        }
        const selected = resolveStateMigrationConfigInput({
          snapshot,
          baseConfig: snapshot.sourceConfig,
        });
        expect(selected?.cfg).toBeUndefined();
        if (kind === "partial") {
          expect(selected?.pluginDoctorConfig).toBe(snapshot.sourceConfig);
        } else {
          expect(selected).toBeNull();
        }
        if (kind === "include") {
          expect(snapshot.includedPaths).toContain(
            path.join(path.dirname(configPath), "included.json"),
          );
        }
      });
    });
  },
);
