import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  assertInstalledPluginIdRecoveryCurrent,
  recoverInstalledPluginConfigIds,
} from "./installed-plugin-id-recovery.js";
import { seedRecoveryOwner } from "./installed-plugin-id-recovery.test-support.js";

describe("installed plugin recovery after same-run repair", () => {
  it.each(["repaired", "not-repaired", "different-root", "record-drift"] as const)(
    "keeps the commit fence after %s",
    async (scenario) => {
      await withOpenClawTestState(
        { label: `recovery-${scenario}`, env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
        async (state) => {
          const cfg = {
            plugins: { entries: { qqbot: { enabled: false, config: { authored: true } } } },
          };
          await seedRecoveryOwner(state, cfg, { version: "2.0.1" });
          const planned = await recoverInstalledPluginConfigIds(cfg, state.env);
          expect(planned.recovery.size).toBe(1);
          expect(planned.config.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(false);
          await assertInstalledPluginIdRecoveryCurrent(planned.config, planned.recovery, state.env);
          const repaired = await seedRecoveryOwner(state, planned.config, {
            version: "2.0.3",
            ...(scenario === "different-root" ? { root: state.path("other-owner") } : {}),
          });
          const result = await recoverInstalledPluginConfigIds(planned.config, state.env, {
            previousRecovery: planned.recovery,
            repairedPluginIds: scenario === "not-repaired" ? [] : ["openclaw-qqbot"],
            records: scenario === "record-drift" ? {} : repaired.records,
          });
          expect(result.config).toEqual(planned.config);
          const recovery = new Map([...planned.recovery, ...result.recovery]);
          const validate = () =>
            assertInstalledPluginIdRecoveryCurrent(result.config, recovery, state.env);
          if (scenario !== "repaired") {
            await expect(validate()).rejects.toThrow("Plugin ownership changed");
            return;
          }
          await expect(validate()).resolves.toBeUndefined();
          // Even the refreshed receipt must reject drift after Doctor's own repair.
          await fs.appendFile(path.join(repaired.root, "openclaw.plugin.json"), "\n");
          await expect(validate()).rejects.toThrow("Plugin ownership changed");
        },
      );
    },
  );
});

// Model a catalog-declared alias; catalog ingestion has separate owner coverage.
vi.mock("../../../plugins/official-external-plugin-catalog.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../plugins/official-external-plugin-catalog.js")>();
  return {
    ...actual,
    resolveOfficialExternalPluginLegacyIds: (
      entry: Parameters<typeof actual.resolveOfficialExternalPluginLegacyIds>[0],
    ) =>
      actual.resolveOfficialExternalPluginId(entry) === "openclaw-qqbot"
        ? ["qqbot"]
        : actual.resolveOfficialExternalPluginLegacyIds(entry),
  };
});

afterEach(() => vi.restoreAllMocks());

it("persists the early disabled alias after Doctor repairs the same owner", async () => {
  const { prepareDoctorContext } = await import("../../doctor-config-flow.test-support.js");
  const { runInitialConfigWriteHealth } =
    await import("../../../flows/doctor-health-contribution-runners.config.js");
  const installRepair = await import("./missing-configured-plugin-install.js");
  const temporaryState = await import("../../../infra/tmp-openclaw-dir.js");
  await withOpenClawTestState(
    { label: "doctor-recovery-repair", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
    async (state) => {
      const control = state.path("control");
      await fs.mkdir(control, { mode: 0o700 });
      vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      const cfg = {
        gateway: { mode: "local" as const },
        plugins: { enabled: false, entries: { qqbot: { enabled: false } } },
      };
      await state.writeConfig(cfg);
      const initialOwner = await seedRecoveryOwner(state, cfg, { version: "2.0.1" });
      let repairRan = false;
      vi.spyOn(installRepair, "repairMissingConfiguredPluginInstalls").mockImplementation(
        async ({ cfg: candidate }) => {
          if (!candidate.plugins?.entries?.["openclaw-qqbot"]) {
            return {
              records: initialOwner.records,
              changes: [],
              warnings: [],
              repairedPluginIds: [],
            };
          }
          repairRan = true;
          expect(candidate.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(false);
          const owner = await seedRecoveryOwner(state, candidate, { version: "2.0.3" });
          return {
            records: owner.records,
            changes: [],
            warnings: [],
            repairedPluginIds: ["openclaw-qqbot"],
            pluginInventoryChanged: true,
          };
        },
      );
      const ctx = await prepareDoctorContext(state.configPath);
      expect(repairRan).toBe(true);
      await runInitialConfigWriteHealth(ctx);
      const saved = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      expect(saved.plugins.entries).toEqual({ "openclaw-qqbot": { enabled: false } });
      expect(ctx.configResultWriteCommitted).toBe(true);
    },
  );
});
