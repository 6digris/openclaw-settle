import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.js";
import {
  createDoctorConfigRepairPlanner,
  prepareDoctorConfigRecovery,
} from "./doctor-config-preflight-legacy-config.js";
import { readDoctorConfigPreflightSnapshot } from "./doctor-config-preflight-plugin-index.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";

const m = vi.hoisted(() => ({
  events: [] as string[],
  ready: false,
  valid: true,
  parseable: true,
  preview: true,
  refuse: false,
  guard: true,
  snapshot: {} as ConfigFileSnapshot,
  read: vi.fn(),
  metadata: vi.fn(),
  legacy: vi.fn(),
  inspect: vi.fn(),
  plan: vi.fn(),
  scope: vi.fn(),
  backup: vi.fn(),
  suffix: vi.fn(),
  commit: vi.fn(),
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../../packages/terminal-core/src/safe-text.js", () => ({
  sanitizeTerminalText: (s: string) => s,
}));
vi.mock("../cli/command-format.js", () => ({ formatCliCommand: (s: string) => s }));
vi.mock("../config/env-vars.js", () => ({ cloneEnvWithPlatformSemantics: (e: unknown) => e }));
vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/synthetic-state",
  resolveIsConfigReadOnly: () => false,
}));
vi.mock("../config/future-version-guard.js", () => ({
  resolveFutureConfigActionBlock: () => false,
}));
vi.mock("../config/plugin-install-config-migration.js", () => ({
  inspectShippedPluginInstallConfigRecords: () => ({ status: "missing" }),
}));
vi.mock("../config/io.js", () => ({
  readConfigFileSnapshot: m.read,
  readConfigFileSnapshotWithPluginMetadata: m.metadata,
  parseConfigJson5: () => ({ ok: m.parseable }),
  recoverConfigFromJsonRootSuffix: m.suffix,
  recoverConfigFromLastKnownGood: m.backup,
}));
vi.mock("../infra/env.js", () => ({ isTruthyEnvValue: () => false }));
vi.mock("../infra/errors.js", () => ({ formatErrorMessage: String }));
vi.mock("../infra/update-rehearsal-paths.js", () => ({
  resolveUpdateRehearsalRoot: () => undefined,
}));
vi.mock("../infra/state-migrations.messages.js", () => ({
  throwIfDoctorStateMigrationRefused: vi.fn(),
}));
vi.mock("../infra/state-migrations.state-dir.js", () => ({
  autoMigrateLegacyStateDir: async () => ({ changes: [], warnings: [] }),
}));
vi.mock("../plugins/installed-plugin-index-policy.js", () => ({}));
vi.mock("../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecordsSync: vi.fn(),
}));
vi.mock("../plugins/plugin-cache.js", () => ({
  createPluginCache: () => ({}),
  getPluginCache: () => ({}),
  withPluginCache: (_c: unknown, run: () => unknown) => run(),
}));
vi.mock("../plugins/doctor-contract-registry.js", () => ({
  withDeferredPluginDoctorMigrations: (_ids: unknown, run: () => unknown) => run(),
}));
vi.mock("../state/openclaw-state-db-readonly.js", () => ({
  withArtifactPreservingStateReads: (run: () => unknown) => run(),
}));
vi.mock("../state/openclaw-state-db.paths.js", () => ({
  resolveOpenClawStateSqlitePath: () => "/synthetic-state/state.db",
}));
vi.mock("../state/openclaw-state-ownership.js", () => ({
  assertOpenClawStateWriteAllowedAtPath: vi.fn(),
}));
vi.mock("../utils.js", () => ({}));
vi.mock("./doctor-config-analysis.js", () => ({ noteDoctorConfigPreflightIssues: vi.fn() }));
vi.mock("./doctor-config-preflight-checkpoint.js", () => ({}));
vi.mock("./doctor-config-preflight-measure.js", () => ({
  measureDoctorConfigPreflightStep: async (_s: string, run: () => unknown) => await run(),
}));
vi.mock("./doctor-config-preflight-worker-scope.js", () => ({
  withDoctorConfigPreflightWorkerScope: (_o: unknown, run: () => unknown) => run(),
}));
vi.mock("./doctor-config-preflight.cron.js", () => ({}));
vi.mock("./doctor-plugin-host-links.js", () => ({}));
vi.mock("./doctor-startup-migration-refusal.js", () => ({
  throwStartupMigrationGuardRejected: () => {
    throw new Error("guard rejected");
  },
}));
vi.mock("./doctor-update-run.js", () => ({ noteStaleUpdateRuns: vi.fn() }));
vi.mock("./doctor/shared/update-phase.js", () => ({
  shouldSkipLegacyUpdateDoctorConfigWrite: () => false,
}));
vi.mock("./doctor/shared/plugin-registry-migration.js", () => ({}));
vi.mock("./doctor/shared/legacy-config-issues.js", () => ({ addDoctorLegacyIssues: m.legacy }));
vi.mock("./doctor/shared/plugin-metadata-snapshot-scope.js", () => ({
  createDoctorPluginMetadataSnapshotScope: () => ({ run: m.scope, invalidate: vi.fn() }),
  completeDoctorPluginMetadataSnapshot: (p: { snapshot: unknown }) => p.snapshot,
}));
vi.mock("./doctor/shared/automatic-startup-config-repair.js", () => ({
  planAutomaticConfigRepair: m.plan,
  commitAutomaticConfigRepair: m.commit,
}));
vi.mock("./doctor/shared/legacy-config-state-migration-input.js", () => ({
  resolveStateMigrationConfigInput: () => {
    m.events.push("state-input");
    throw new Error("state boundary reached");
  },
}));
vi.mock("./doctor-config-preflight-plugin-migrations.js", () => ({
  createDoctorPluginMigrationPreparation: () => ({
    snapshotOptions: () => ({
      preparePluginMigrations: m.inspect,
      deferredPluginMigrations: [{ pluginId: "retained", reason: "pending", command: "repair" }],
    }),
    deferred: () => [],
    observe: vi.fn(),
    converged: vi.fn(),
  }),
}));
vi.mock("./doctor-config-preflight-startup.js", () => ({
  noteStateMigrationResult: vi.fn(),
  prepareDoctorMigrationPlugins: async (p: { readRefreshedSnapshot: () => Promise<unknown> }) => {
    m.events.push("converge");
    if (m.refuse) {
      throw new Error("required owner unavailable");
    }
    m.ready = true;
    return await p.readRefreshedSnapshot();
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  m.events.length = 0;
  m.ready = false;
  m.valid = true;
  m.parseable = true;
  m.preview = true;
  m.refuse = false;
  m.guard = true;
  const source = { session: { store: "/retained/legacy.json" } };
  m.snapshot = {
    path: "/synthetic/config.json",
    exists: true,
    raw: "{}",
    parsed: source,
    resolved: source,
    runtimeConfig: source,
    sourceConfig: source,
    config: source,
    valid: true,
    issues: [],
    warnings: [],
    legacyIssues: [],
    hash: "source-hash",
  };
  m.read.mockImplementation(async (o: { pluginValidation?: string }) => {
    m.events.push(o.pluginValidation === "core-only" ? "core-read" : "plugin-read");
    if (o.pluginValidation !== "core-only" && !m.ready) {
      throw new Error("stale plugin reader");
    }
    return { ...m.snapshot, valid: m.valid };
  });
  m.metadata.mockImplementation(async (options) => {
    m.events.push("metadata");
    if (!m.ready) {
      // Metadata completion is manifest-only; executable legacy diagnostics stay deferred.
      expect(options).toMatchObject({ deferDoctorLegacyIssues: true });
    }
    return {
      snapshot: { ...m.snapshot, valid: m.valid },
      pluginMetadataSnapshot: { configFingerprint: "fresh" },
    };
  });
  m.legacy.mockImplementation((s: ConfigFileSnapshot) => {
    m.events.push("detector");
    if (!m.ready) {
      throw new Error("stale detector");
    }
    return s;
  });
  m.inspect.mockImplementation(async () => {
    m.events.push("inspect");
    // Availability inspection reads manifest ownership, not executable Doctor contracts.
    return [];
  });
  m.scope.mockImplementation((_s: unknown, run: () => unknown) => {
    m.events.push("scope");
    if (!m.ready) {
      throw new Error("stale repair scope");
    }
    return run();
  });
  m.plan.mockImplementation((s: ConfigFileSnapshot, o?: { pluginContracts?: boolean }) => {
    const core = o?.pluginContracts === false;
    m.events.push(core ? "preview" : "full-plan");
    if (!core && !m.ready) {
      throw new Error("stale repair plan");
    }
    return core && !m.preview
      ? null
      : {
          snapshot: { ...s, valid: true },
          config: s.sourceConfig,
          writeConfig: s.sourceConfig,
          changes: ["legacy repair"],
        };
  });
  m.backup.mockResolvedValue(false);
  m.suffix.mockResolvedValue(false);
});

const readOptions = () => ({
  allowCurrentPluginMetadata: false,
  includePluginMetadata: true,
  preparePluginMetadataSnapshot: true,
  skipPluginValidation: false,
});
const planner = (before: () => boolean) =>
  createDoctorConfigRepairPlanner({
    options: { repairPrefixedConfig: true },
    gatewayStartupCheckpointRequired: false,
    stateMigrationsRequested: true,
    skipLegacyParentConfigWrite: false,
    hasImportedPluginConfig: () => false,
    beforePluginConvergence: before,
    runWithPluginMetadataSnapshot: m.scope,
  });

describe("D03 source-first ordinary Doctor entry", () => {
  it.each([true, false])(
    "reaches convergence before contract reads with valid=%s",
    async (valid) => {
      m.valid = valid;
      await expect(
        runDoctorConfigPreflight({
          migrateLegacyConfig: false,
          repairPrefixedConfig: true,
          preparePluginMetadataSnapshot: true,
        }),
      ).rejects.toThrow("state boundary reached");
      const index = m.events.indexOf("converge");
      expect(index).toBeGreaterThan(-1);
      expect(m.events.indexOf("detector")).toBeGreaterThan(index);
      if (!valid) {
        expect(m.events.indexOf("preview")).toBeLessThan(index);
        expect(m.events.indexOf("full-plan")).toBeGreaterThan(index);
      }
      expect(m.commit).not.toHaveBeenCalled();
      expect(m.backup).not.toHaveBeenCalled();
    },
  );
  it("required-owner refusal prevents detector, recovery commit and state selection", async () => {
    m.refuse = true;
    m.valid = false;
    await expect(
      runDoctorConfigPreflight({ migrateLegacyConfig: false, repairPrefixedConfig: true }),
    ).rejects.toThrow("required owner unavailable");
    for (const name of ["metadata", "detector", "scope", "full-plan", "state-input"]) {
      expect(m.events).not.toContain(name);
    }
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.backup).not.toHaveBeenCalled();
  });
  it("source-only read preserves exact snapshot facts and pending inputs without invoking contracts", async () => {
    const pending = [{ pluginId: "owner", reason: "pending", command: "repair" }];
    const prepareSnapshot = vi.fn();
    const result = await readDoctorConfigPreflightSnapshot({
      ...readOptions(),
      beforePluginConvergence: true,
      includePluginMetadata: false,
      preparePluginMigrations: m.inspect,
      deferredPluginMigrations: pending,
      prepareSnapshot,
    });
    expect(result.snapshot).toEqual(m.snapshot);
    expect(result.pluginMigrationFingerprint).toBeNull();
    expect(result.pluginMetadataSnapshot).toBeUndefined();
    expect(m.read).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginValidation: "core-only",
        deferredPluginMigrations: pending,
        allowCurrentPluginMetadata: false,
      }),
    );
    expect(prepareSnapshot).toHaveBeenCalledWith(result.snapshot);
    expect(m.inspect).not.toHaveBeenCalled();
    expect(m.legacy).not.toHaveBeenCalled();
  });
  it("post-convergence read still completes metadata and runs detectors", async () => {
    m.ready = true;
    const result = await readDoctorConfigPreflightSnapshot({
      ...readOptions(),
      preparePluginMigrations: m.inspect,
    });
    expect(result.pluginMigrationFingerprint).toBe("fresh");
    expect(m.inspect).toHaveBeenCalled();
    expect(m.legacy).toHaveBeenCalled();
  });
  it("recovery preview avoids plugin scope then uses the full plan after acceptance", () => {
    const p = planner(() => !m.ready);
    p.planScopedConfigRepair(m.snapshot);
    expect(m.scope).not.toHaveBeenCalled();
    m.ready = true;
    p.planScopedConfigRepair(m.snapshot);
    expect(m.scope).toHaveBeenCalledOnce();
    expect(m.events).toEqual(["preview", "scope", "full-plan"]);
  });
  it("readable source with no core repair is not replaced by an older backup", async () => {
    m.preview = false;
    const snapshotRead = {
      snapshot: { ...m.snapshot, valid: false },
      pluginMigrationFingerprint: null,
    };
    const result = await prepareDoctorConfigRecovery({
      enabled: true,
      beforePluginConvergence: true,
      snapshotRead,
      planRepair: planner(() => true).planScopedConfigRepair,
      readSnapshot: vi.fn(),
    });
    expect(result.snapshotRead).toBe(snapshotRead);
    expect(result.activeConfigRepair).toBeNull();
    expect(m.suffix).not.toHaveBeenCalled();
    expect(m.backup).not.toHaveBeenCalled();
  });
  it("malformed source still invokes the existing recovery owner and refuses if unrecoverable", async () => {
    m.parseable = false;
    await expect(
      prepareDoctorConfigRecovery({
        enabled: true,
        beforePluginConvergence: true,
        snapshotRead: {
          snapshot: { ...m.snapshot, valid: false },
          pluginMigrationFingerprint: null,
        },
        planRepair: m.plan,
        readSnapshot: vi.fn(),
      }),
    ).rejects.toThrow("not parseable");
    expect(m.plan).not.toHaveBeenCalled();
    expect(m.suffix).toHaveBeenCalledOnce();
    expect(m.backup).toHaveBeenCalledOnce();
  });
  it("ordinary post-convergence recovery keeps backup selection", async () => {
    m.ready = true;
    m.plan.mockReturnValue(null);
    await prepareDoctorConfigRecovery({
      enabled: true,
      snapshotRead: { snapshot: { ...m.snapshot, valid: false }, pluginMigrationFingerprint: null },
      planRepair: m.plan,
      readSnapshot: vi.fn(),
    });
    expect(m.suffix).toHaveBeenCalledOnce();
    expect(m.backup).toHaveBeenCalledOnce();
  });
});
