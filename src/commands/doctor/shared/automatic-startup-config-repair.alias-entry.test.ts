import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigIO } from "../../../config/io.factory.js";
import { getResolvedConfigEnvSecretRef } from "../../../config/resolution-facts.js";
import * as repair from "./automatic-startup-config-repair.js";

const boundaries = vi.hoisted(() => ({
  compatibility: vi.fn(() => {
    throw new Error("plugin compatibility before convergence");
  }),
  diagnostics: vi.fn(() => {
    throw new Error("executable snapshot diagnostics before convergence");
  }),
  binding: vi.fn(() => {
    throw new Error("binding discovery before convergence");
  }),
  beforeWrite: undefined as (() => Promise<void>) | undefined,
  read: vi.fn<(options: unknown) => void>(),
  write:
    vi.fn<
      (
        options: Parameters<typeof import("../../../config/config.js").transformConfigFile>[0],
      ) => void
    >(),
}));
vi.mock("./channel-legacy-config-migrate.js", () => ({
  applyChannelDoctorCompatibilityMigrations: boundaries.compatibility,
}));
vi.mock("./legacy-config-binding-repair-input.js", () => ({
  resolveChannelAccountBindingRepairInput: boundaries.binding,
}));
vi.mock("../../../config/io.snapshot-shared.js", async (original) => {
  const actual = await original<typeof import("../../../config/io.snapshot-shared.js")>();
  return { ...actual, collectInvalidConfigLegacyIssues: boundaries.diagnostics };
});
vi.mock("../../../config/io.js", async (original) => {
  const actual = await original<typeof import("../../../config/io.js")>();
  return {
    ...actual,
    createConfigIO: (options: Parameters<typeof actual.createConfigIO>[0]) => {
      boundaries.read(options);
      return actual.createConfigIO(options);
    },
  };
});
vi.mock("../../../config/config.js", async (original) => {
  const actual = await original<typeof import("../../../config/config.js")>();
  return {
    ...actual,
    transformConfigFile: async (...args: Parameters<typeof actual.transformConfigFile>) => {
      boundaries.write(args[0]);
      await boundaries.beforeWrite?.();
      return await actual.transformConfigFile(...args);
    },
  };
});
let root: string;
let configPath: string;
beforeEach(async () => {
  vi.clearAllMocks();
  boundaries.beforeWrite = undefined;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-d08-alias-"));
  configPath = path.join(root, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "1");
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", "1");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
async function write(config: unknown) {
  const raw = JSON.stringify(config, null, 2) + "\n";
  await fs.writeFile(configPath, raw);
  return raw;
}
function source(extra: Record<string, unknown> = {}) {
  return {
    gateway: { mode: "local" },
    plugins: { enabled: false },
    session: { idleMinutes: 45 },
    ...extra,
  };
}
function expectNoPluginRepair() {
  expect(boundaries.diagnostics).not.toHaveBeenCalled();
  expect(boundaries.compatibility).not.toHaveBeenCalled();
  expect(boundaries.binding).not.toHaveBeenCalled();
}

describe("D08 early alias writer", () => {
  it("uses the existing guarded writer once, retains source facts, and is idempotent", async () => {
    vi.stubEnv("D08_PROVIDER_KEY", "synthetic-key");
    const raw = await write(
      source({
        models: {
          providers: {
            fixture: {
              baseUrl: "https://fixture.invalid/v1",
              api: "openai-completions",
              apiKey: "${D08_PROVIDER_KEY}",
              models: [],
            },
          },
        },
      }),
    );
    const changes = await repair.repairDoctorConfigBeforePluginConvergence();
    expect(changes.join("\n")).toContain("session");
    expect(boundaries.read).toHaveBeenCalledWith(
      expect.objectContaining({
        observe: false,
        pluginValidation: "core-only",
        shellEnvFallback: "defer",
      }),
    );
    expect(boundaries.write).toHaveBeenCalledTimes(1);
    const writeOptions = boundaries.write.mock.calls[0]?.[0];
    expect(writeOptions).toBeDefined();
    if (!writeOptions) {
      throw new Error("Expected guarded config write");
    }
    expect(writeOptions.baseHash).toEqual(expect.any(String));
    expect(writeOptions.writeOptions).toMatchObject({
      expectedConfigPath: configPath,
      persistCanonicalAgentRoster: true,
    });
    expect(writeOptions.writeOptions?.skipPluginValidation).not.toBe(true);
    expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toMatchObject({
      session: { reset: { mode: "idle", idleMinutes: 45 } },
      models: { providers: { fixture: { apiKey: "${D08_PROVIDER_KEY}" } } },
    });
    expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(raw);
    const snapshot = await createConfigIO({
      env: process.env,
      observe: false,
      pluginValidation: "core-only",
    }).readConfigFileSnapshot();
    expect(
      getResolvedConfigEnvSecretRef(snapshot.sourceConfig, "models.providers.fixture.apiKey")?.id,
    ).toBe("D08_PROVIDER_KEY");
    expect(await repair.repairDoctorConfigBeforePluginConvergence()).toEqual([]);
    expect(boundaries.write).toHaveBeenCalledTimes(1);
    expectNoPluginRepair();
  });
  it.each(["${D08_IMAGE_MODEL}", "$${D08_IMAGE_MODEL}"])(
    "preserves moved %s references across environment rotation",
    async (model) => {
      vi.stubEnv("D08_IMAGE_MODEL", "fixture/planning-model");
      const raw = await write(source({ agents: { defaults: { imageGenerationModel: model } } }));
      boundaries.beforeWrite = async () => {
        vi.stubEnv("D08_IMAGE_MODEL", "fixture/write-model");
      };
      expect((await repair.repairDoctorConfigBeforePluginConvergence()).length).toBeGreaterThan(0);
      const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(saved.agents.defaults.mediaModels.image).toBe(model);
      expect(saved.agents.defaults).not.toHaveProperty("imageGenerationModel");
      expect(await fs.readFile(`${configPath}.bak`, "utf8")).toBe(raw);
      expectNoPluginRepair();
    },
  );
  it("preserves canonical and disabled precedence through the actual writer", async () => {
    await write(
      source({
        session: { idleMinutes: 45, reset: { mode: "daily", idleMinutes: 12 } },
        tools: { exec: { mode: "deny", security: "full", ask: "off" } },
      }),
    );
    expect((await repair.repairDoctorConfigBeforePluginConvergence()).length).toBeGreaterThan(0);
    const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(saved.session).toEqual({ reset: { mode: "daily", idleMinutes: 12 } });
    expect(saved.tools.exec).toEqual({ mode: "deny" });
    expectNoPluginRepair();
  });
  it("keeps the ordinary planner on its full-mode compatibility path", async () => {
    await write(source());
    const snapshot = await createConfigIO({
      env: process.env,
      observe: false,
      pluginValidation: "core-only",
    }).readConfigFileSnapshot();
    expect(() => repair.planAutomaticConfigRepair(snapshot)).toThrow(
      "plugin compatibility before convergence",
    );
    expect(boundaries.compatibility).toHaveBeenCalledTimes(1);
    expect(boundaries.write).not.toHaveBeenCalled();
  });
  it("checks current requester authority before the atomic writer can replace source", async () => {
    const raw = await write(source());
    const assertCurrent = vi.fn(() => {
      throw new Error("requester expired");
    });
    await expect(
      repair.repairDoctorConfigBeforePluginConvergence({ assertCurrent }),
    ).rejects.toThrow("requester expired");
    expect(assertCurrent).toHaveBeenCalled();
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    await expect(fs.stat(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("keeps the shipped parent's version stamp", async () => {
    vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "2026.7.1");
    vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", "1");
    vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", "0");
    await write(source({ meta: { lastTouchedVersion: "2026.6.0" } }));
    expect((await repair.repairDoctorConfigBeforePluginConvergence()).length).toBeGreaterThan(0);
    expect(JSON.parse(await fs.readFile(configPath, "utf8")).meta.lastTouchedVersion).toBe(
      "2026.6.0",
    );
    expectNoPluginRepair();
  });
  it("refuses a changed source after planning without overwriting it or creating a backup", async () => {
    await write(source());
    const concurrent = JSON.stringify(source({ gateway: { mode: "remote" } }));
    boundaries.beforeWrite = async () => {
      await fs.writeFile(configPath, concurrent);
    };
    await expect(repair.repairDoctorConfigBeforePluginConvergence()).rejects.toThrow();
    expect(await fs.readFile(configPath, "utf8")).toBe(concurrent);
    await expect(fs.stat(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each([
    {
      name: "pending plugin install",
      extra: {
        plugins: {
          enabled: false,
          installs: { pending: { source: "path", installPath: "/synthetic/pending" } },
        },
      },
    },
    {
      name: "authored legacy roster",
      extra: { agents: { list: [{ id: "ops" }, { id: "main" }] } },
    },
    {
      name: "owner marker projection",
      extra: { agents: { entries: { ops: { default: true }, main: {} } } },
    },
    {
      name: "context-budget projection",
      extra: { agents: { defaults: { contextTokens: 12345 } } },
    },
    { name: "remaining state locator", extra: { cron: { store: "/synthetic/cron.json" } } },
    { name: "unrelated invalid value", extra: { gateway: { port: "invalid" } } },
  ])("retains $name without claiming a repair", async ({ extra }) => {
    const raw = await write(source(extra));
    expect(await repair.repairDoctorConfigBeforePluginConvergence()).toEqual([]);
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    expect(boundaries.write).not.toHaveBeenCalled();
    await expect(fs.stat(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoPluginRepair();
  });
  it("refuses include ownership without modifying either file", async () => {
    const include = path.join(root, "session.json");
    const includedRaw = '{"idleMinutes": 45}\n';
    await fs.writeFile(include, includedRaw);
    const raw = await write(source({ session: { $include: "session.json" } }));
    expect(await repair.repairDoctorConfigBeforePluginConvergence()).toEqual([]);
    expect(await fs.readFile(configPath, "utf8")).toBe(raw);
    expect(await fs.readFile(include, "utf8")).toBe(includedRaw);
    expect(boundaries.write).not.toHaveBeenCalled();
  });
});
