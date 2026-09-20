import { beforeEach, describe, expect, it, vi } from "vitest";
import { coerceConfig } from "../../../config/io.read-helpers.js";
import {
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "../../../config/legacy.default-agent-owner.js";
import {
  createConfigResolutionFacts,
  getAuthoredConfigSecretRef,
  getConfigResolutionFacts,
  getResolvedConfigEnvSecretRef,
  setConfigResolutionFacts,
} from "../../../config/resolution-facts.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

const boundaries = vi.hoisted(() => ({
  compat: vi.fn((next: Record<string, unknown>, _options: unknown) => ({
    next,
    changes: [] as string[],
  })),
  bindingInput: vi.fn((_config: unknown) => true),
  repair: vi.fn(
    ({ config }: { config: Record<string, unknown>; sourceConfigBeforeMigrations: unknown }) => ({
      config,
      changes: ["binding control"],
      warnings: ["binding warning"],
    }),
  ),
  loader: vi.fn(),
}));
vi.mock("./channel-legacy-config-migrate.js", () => ({
  applyChannelDoctorCompatibilityMigrations: boundaries.compat,
}));
vi.mock("./legacy-config-binding-repair-input.js", () => ({
  resolveChannelAccountBindingRepairInput: boundaries.bindingInput,
}));
vi.mock("../../../plugins/native-module-require.js", () => ({
  isPluginSourceModulePath: () => true,
}));
vi.mock("../../../plugins/plugin-module-loader-cache.js", () => ({
  getCachedPluginModuleLoader: boundaries.loader,
}));

beforeEach(() => {
  vi.clearAllMocks();
  boundaries.loader.mockReturnValue(() => ({
    repairUnownedChannelAccountBindings: boundaries.repair,
  }));
});
function early(raw: unknown, pluginContracts?: boolean) {
  return applyLegacyDoctorMigrations(raw, {
    sourceConfigBeforeMigrations: raw,
    beforePluginConvergence: true,
    pluginContracts,
  });
}
function expectNoPluginRepair() {
  expect(boundaries.compat).not.toHaveBeenCalled();
  expect(boundaries.bindingInput).not.toHaveBeenCalled();
  expect(boundaries.loader).not.toHaveBeenCalled();
  expect(boundaries.repair).not.toHaveBeenCalled();
}
function retainedInputs() {
  return {
    meta: { lastTouchedAt: "2026-07-01" },
    cron: { store: "/old/cron.json" },
    session: { store: "/old/sessions.json" },
    tts: { prefsPath: "/old/tts.json", personas: { narrator: { prompt: "retain" } } },
    hooks: { internal: { installs: { old: { source: "npm" } }, handlers: ["retain"] } },
    plugins: {
      bundledDiscovery: true,
      installs: { old: { installPath: "/old/plugin" } },
      entries: { codex: { config: { codexDynamicToolsProfile: "retain" } } },
    },
    cloudWorkers: { profiles: { remote: { lifetime: "ephemeral" } } },
    memory: { search: { sync: { onStart: false } } },
    security: { installPolicy: { exec: { allowInsecurePath: true } } },
    secrets: { providers: { cli: { source: "exec", allowSymlinkCommand: true } } },
    agents: {
      defaults: {
        compaction: { customInstructions: "retain" },
        promptOverlays: { gpt5: { personality: "retain" } },
      },
    },
    web: { enabled: false },
    messages: { responsePrefix: "retain" },
    channels: {
      signal: { httpHost: "127.0.0.1", httpPort: 8090 },
      custom: { heartbeat: { showOk: false } },
    },
    gateway: { bind: "localhost" },
  };
}

describe("early pure-alias migration", () => {
  it("migrates selected tier and layout aliases without consuming deferred inputs", () => {
    const retained = retainedInputs();
    const raw = {
      ...retained,
      session: { ...retained.session, idleMinutes: 31 },
      tools: { exec: { security: "full", ask: "off", timeoutSec: 15 } },
      discovery: { wideArea: { enabled: false, domain: "example.test" } },
      media: { keepOriginal: true },
      audit: { enabled: true },
    };
    const original = structuredClone(raw);
    const result = early(raw);
    expect(result.next).toEqual({
      ...retained,
      session: { ...retained.session, reset: { mode: "idle", idleMinutes: 31 } },
      tools: { exec: { mode: "full", timeoutSeconds: 15 } },
      discovery: { wideArea: {} },
      attachments: { keepOriginal: true },
      logging: { audit: { enabled: true } },
    });
    expect(raw).toEqual(original);
    expect(result.changes.length).toBeGreaterThan(0);
    expectNoPluginRepair();
  });

  it.each([undefined, false, true])(
    "preserves canonical and disabled values with pluginContracts=%s",
    (pluginContracts) => {
      const raw = {
        session: { idleMinutes: 60, reset: { mode: "daily", idleMinutes: 0 } },
        tools: {
          exec: { security: "full", ask: "off", mode: "deny", timeoutSec: 30, timeoutSeconds: 0 },
        },
        discovery: { wideArea: { enabled: false, domain: "example.test" } },
        agents: {
          entries: {
            helper: {
              tools: { exec: { security: "full", ask: "off", mode: "deny" } },
              sandbox: { browser: { enableNoVnc: true, noVncEnabled: false } },
            },
          },
        },
        gateway: { nodes: { skills: { enabled: true }, allowSkills: false } },
        env: { TOKEN: "old", vars: { TOKEN: "canonical" } },
      };
      const next = early(raw, pluginContracts).next;
      expect(next).toEqual({
        session: { reset: { mode: "daily", idleMinutes: 0 } },
        tools: { exec: { mode: "deny", timeoutSeconds: 0 } },
        discovery: { wideArea: {} },
        agents: {
          entries: {
            helper: {
              tools: { exec: { mode: "deny" } },
              sandbox: { browser: { noVncEnabled: false } },
            },
          },
        },
        gateway: { nodes: { allowSkills: false } },
        env: { vars: { TOKEN: "canonical" } },
      });
      expectNoPluginRepair();
    },
  );

  it.each([
    {
      raw: { discovery: { wideArea: { enabled: true, domain: "example.test" } } },
      expected: { discovery: { wideArea: { domain: "example.test" } } },
    },
    {
      raw: { session: { idleMinutes: 10, reset: { idleMinutes: 0 } } },
      expected: { session: { reset: { idleMinutes: 0 } } },
    },
  ])(
    "reports an alias-only deletion instead of losing the changed clone: $raw",
    ({ raw, expected }) => {
      const result = early(raw);
      expect(result.next).toEqual(expected);
      expect(result.changes.length).toBeGreaterThan(0);
      expectNoPluginRepair();
    },
  );

  it("keeps authored source, pending/resolved env facts and the retired default-agent owner", () => {
    const raw = {
      session: { idleMinutes: 8 },
      agents: { entries: { helper: {}, main: {} } },
      gateway: { auth: { token: "decoded-literal" } },
      channels: { custom: { token: "${PENDING}" } },
    };
    const facts = createConfigResolutionFacts(
      [],
      new Map([["channels.custom.token", "PENDING"]]),
      undefined,
      new Map([["gateway.auth.token", "RESOLVED"]]),
    );
    setConfigResolutionFacts(raw, facts);
    retainLegacyDefaultAgentId(coerceConfig(raw), "helper");
    const authored = {
      $include: "agents.json",
      session: { idleMinutes: 8 },
      gateway: { auth: { token: "${RESOLVED}" } },
    };
    const authoredBefore = structuredClone(authored);
    const result = applyLegacyDoctorMigrations(raw, {
      sourceConfigBeforeMigrations: authored,
      context: { authoredRaw: authored, resolvedRaw: raw },
      beforePluginConvergence: true,
    });
    if (!result.next) {
      throw new Error("Expected migrated config");
    }
    expect(getConfigResolutionFacts(result.next)).toBe(facts);
    expect(getAuthoredConfigSecretRef(result.next, "channels.custom.token")).toEqual({
      source: "env",
      provider: "default",
      id: "PENDING",
    });
    expect(getResolvedConfigEnvSecretRef(result.next, "gateway.auth.token")).toEqual({
      source: "env",
      provider: "default",
      id: "RESOLVED",
    });
    expect(tryGetLegacyDefaultAgentId(result.next)).toBe("helper");
    expect(authored).toEqual(authoredBefore);
    expect(raw.session).toEqual({ idleMinutes: 8 });
    expectNoPluginRepair();
  });

  it("returns no change for retirement-only inputs and is idempotent for aliases", () => {
    const raw = retainedInputs();
    expect(early(raw)).toEqual({ next: null, changes: [] });
    const first = early({ session: { idleMinutes: 7 } });
    expect(first.next).not.toBeNull();
    expect(early(first.next)).toEqual({ next: null, changes: [] });
    expectNoPluginRepair();
  });
});

describe("full migration remains the default", () => {
  it.each([undefined, false])(
    "still runs full migrations and compatibility with pluginContracts=%s",
    (pluginContracts) => {
      const raw = {
        gateway: { bind: "localhost" },
        session: { idleMinutes: 23 },
        cron: { store: "/old/cron.json" },
        discovery: { wideArea: { enabled: false, domain: "example.test" } },
      };
      const result = applyLegacyDoctorMigrations(raw, {
        sourceConfigBeforeMigrations: raw,
        pluginContracts,
      });
      expect(result.next).toMatchObject({
        gateway: { bind: "loopback" },
        session: { reset: { mode: "idle", idleMinutes: 23 } },
        discovery: { wideArea: {} },
      });
      expect(result.next).not.toHaveProperty("cron.store");
      expect(boundaries.compat).toHaveBeenCalledOnce();
      expect(boundaries.compat).toHaveBeenCalledWith(expect.any(Object), {
        pluginContracts: pluginContracts !== false,
      });
      if (pluginContracts === false) {
        expect(boundaries.bindingInput).not.toHaveBeenCalled();
        expect(boundaries.loader).not.toHaveBeenCalled();
      } else {
        expect(boundaries.repair).toHaveBeenCalledWith({
          config: result.next,
          sourceConfigBeforeMigrations: raw,
        });
        expect(result.warnings).toContain("binding warning");
      }
    },
  );
});
