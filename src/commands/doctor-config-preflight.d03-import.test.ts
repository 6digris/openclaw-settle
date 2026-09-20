import { beforeEach, describe, expect, it, vi } from "vitest";
import { copyPluginInstallRecordMap } from "../config/plugin-install-record-map.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { importShippedPluginInstallConfigForDoctor } from "./doctor/shared/plugin-registry-migration.js";

const m = vi.hoisted(() => ({
  events: [] as string[],
  records: {} as Record<string, import("../config/types.plugins.js").PluginInstallRecord>,
  persisted: null as Record<
    string,
    import("../config/types.plugins.js").PluginInstallRecord
  > | null,
  readForWrite: vi.fn(),
  commitRecords: vi.fn(),
  lease: vi.fn(),
  fullPlanRefused: false,
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
  loadInstalledPluginIndexInstallRecordsSync: () => m.records,
  loadInstalledPluginIndexInstallRecords: async () => m.records,
  readPersistedInstalledPluginIndexInstallRecords: () => m.persisted,
  withoutPluginInstallRecords: (source: import("../config/types.js").OpenClawConfig) => {
    const copy = structuredClone(source);
    if (copy.plugins) {
      delete copy.plugins.installs;
    }
    return copy;
  },
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

vi.mock("./doctor/shared/legacy-config-issues.js", () => ({ addDoctorLegacyIssues: m.legacy }));
vi.mock("./doctor/shared/plugin-metadata-snapshot-scope.js", () => ({
  createDoctorPluginMetadataSnapshotScope: () => ({ run: m.scope, invalidate: vi.fn() }),
  completeDoctorPluginMetadataSnapshot: (p: { snapshot: unknown }) => p.snapshot,
}));
vi.mock("./doctor/shared/automatic-startup-config-repair.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./doctor/shared/automatic-startup-config-repair.js")>()),
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

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshotForWrite: m.readForWrite,
  withConfigMutationExclusive: (run: () => unknown) => run(),
}));
vi.mock("../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshot: () => {
    m.events.push("import-contract");
    throw new Error("stale import contract");
  },
}));
vi.mock("../config/io.read-helpers.js", () => ({ containsConfigIncludeDirective: () => false }));
vi.mock("../config/deferred-plugin-migration-config.js", () => ({
  getDeferredPluginMigrationConfigFacts: () => undefined,
}));
vi.mock("../config/legacy.default-agent-owner.js", () => ({
  inheritLegacyDefaultAgentId: (_source: unknown, value: unknown) => value,
}));
vi.mock("../plugins/installed-plugin-index-record-state.js", () => ({}));
vi.mock("../plugins/installed-plugin-index-store-write.js", () => ({}));
vi.mock("../plugins/installed-plugin-index-store.js", () => ({
  resolveInstalledPluginIndexStorePath: () => "/synthetic-state/state.db",
}));
vi.mock("../plugins/installed-plugin-index.js", () => ({}));
vi.mock("../plugins/official-external-install-records.js", () => ({
  resolveTrustedSourceLinkedOfficialClawHubInstall: () => undefined,
}));
vi.mock("../plugins/install-record-commit.js", () => ({
  commitPluginInstallRecordsOnly: m.commitRecords,
}));
vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({ withPluginLifecycleLease: m.lease }));
vi.mock("./doctor/shared/legacy-config-compat.js", () => ({}));

beforeEach(() => {
  vi.clearAllMocks();
  m.events.length = 0;
  m.ready = false;
  m.refuse = false;
  m.fullPlanRefused = false;
  m.records = {};
  m.persisted = null;
  const source = { plugins: { installs: { owner: { source: "npm" as const, spec: "owner@1" } } } };
  m.snapshot = {
    path: "/synthetic/config.json",
    exists: true,
    raw: JSON.stringify(source),
    parsed: source,
    resolved: source,
    runtimeConfig: source,
    sourceConfig: source,
    config: source,
    valid: false,
    issues: [{ path: "plugins.installs", message: "retired" }],
    warnings: [],
    legacyIssues: [],
    hash: "source-hash",
  };
  m.read.mockImplementation(async () => m.snapshot);
  m.metadata.mockImplementation(async () => ({
    snapshot: m.snapshot,
    pluginMetadataSnapshot: { configFingerprint: "fresh" },
  }));
  m.legacy.mockImplementation((snapshot: ConfigFileSnapshot) => snapshot);
  m.inspect.mockResolvedValue([]);
  m.scope.mockImplementation((_scope: unknown, run: () => unknown) => run());
  m.plan.mockImplementation(
    (snapshot: ConfigFileSnapshot, options?: { pluginContracts?: boolean }) => {
      const preview = options?.pluginContracts === false;
      m.events.push(preview ? "preview" : "full-plan");
      if (!preview && m.fullPlanRefused) {
        throw new Error("postconvergence plugin config rejected");
      }
      return {
        snapshot: { ...snapshot, valid: true },
        config: snapshot.sourceConfig,
        writeConfig: snapshot.sourceConfig,
        changes: ["repair"],
      };
    },
  );
  m.readForWrite.mockImplementation(async () => ({ snapshot: m.snapshot, writeOptions: {} }));
  m.lease.mockImplementation(
    async (_options: unknown, run: (lease: { databasePath: string }) => Promise<unknown>) => {
      m.events.push("plugin-lease");
      return run({ databasePath: "/synthetic-state/state.db" });
    },
  );
  m.commitRecords.mockImplementation(
    async (params: {
      nextInstallRecords: typeof m.records;
      verifyConfigFresh: () => Promise<void>;
    }) => {
      await params.verifyConfigFresh();
      m.events.push("record-commit");
      m.persisted = structuredClone(params.nextInstallRecords);
      m.records = structuredClone(params.nextInstallRecords);
    },
  );
  m.backup.mockResolvedValue(false);
  m.suffix.mockResolvedValue(false);
});
const run = () =>
  runDoctorConfigPreflight({
    migrateLegacyConfig: false,
    repairPrefixedConfig: true,
    preparePluginMetadataSnapshot: true,
  });

describe("D03 source install import before convergence", () => {
  it("preserves records without loading stale contracts, then validates after convergence", async () => {
    const before = structuredClone(m.snapshot);
    await expect(run()).rejects.toThrow("state boundary reached");
    expect(m.events).not.toContain("import-contract");
    expect(m.events.indexOf("record-commit")).toBeLessThan(m.events.indexOf("converge"));
    expect(m.events.indexOf("full-plan")).toBeGreaterThan(m.events.indexOf("converge"));
    expect(m.persisted?.owner).toEqual({ source: "npm", spec: "owner@1" });
    expect(m.snapshot).toEqual(before);
    expect(m.commit).not.toHaveBeenCalled();
  });
  it("retains imported records and config when required-owner convergence refuses", async () => {
    m.refuse = true;
    await expect(run()).rejects.toThrow("required owner unavailable");
    expect(m.persisted?.owner?.spec).toBe("owner@1");
    expect(m.snapshot.sourceConfig.plugins?.installs?.owner?.spec).toBe("owner@1");
    expect(m.events).not.toContain("full-plan");
    expect(m.events).not.toContain("state-input");
    expect(m.commit).not.toHaveBeenCalled();
  });
  it("postconvergence plugin validation still refuses the config writer", async () => {
    m.fullPlanRefused = true;
    await expect(run()).rejects.toThrow("postconvergence plugin config rejected");
    expect(m.events).toContain("converge");
    expect(m.events).not.toContain("state-input");
    expect(m.commit).not.toHaveBeenCalled();
  });
  it("keeps an existing ledger owner authoritative", async () => {
    m.persisted = copyPluginInstallRecordMap({ owner: { source: "npm", spec: "owner@2" } });
    m.records = structuredClone(m.persisted);
    await expect(run()).rejects.toThrow("state boundary reached");
    expect(m.persisted.owner?.spec).toBe("owner@2");
    expect(m.commitRecords).not.toHaveBeenCalled();
  });
  it("rejects a source edit before importing records", async () => {
    m.readForWrite.mockResolvedValue({
      snapshot: { ...m.snapshot, hash: "changed" },
      writeOptions: {},
    });
    await expect(run()).rejects.toThrow("config changed before plugin install migration");
    expect(m.commitRecords).not.toHaveBeenCalled();
    expect(m.events).not.toContain("converge");
  });
  it("rejects an included-file edit immediately before committing records", async () => {
    m.readForWrite
      .mockResolvedValueOnce({
        snapshot: m.snapshot,
        writeOptions: { includeFileHashesForWrite: { part: "old" } },
      })
      .mockResolvedValue({
        snapshot: m.snapshot,
        writeOptions: { includeFileHashesForWrite: { part: "changed" } },
      });
    await expect(run()).rejects.toThrow("config changed during plugin install migration");
    expect(m.persisted).toBeNull();
    expect(m.events).not.toContain("converge");
  });
});

vi.mock("../agents/agent-scope-config.js", () => ({}));
vi.mock("../config/config-path-mutation.js", () => ({}));
vi.mock("../config/io.meta.js", () => ({}));
vi.mock("../config/io.write-topology.js", () => ({}));
vi.mock("../config/legacy.js", () => ({}));
vi.mock("../config/legacy.roster.js", () => ({}));
vi.mock("../config/resolution-facts.js", () => ({}));
vi.mock("../config/validation.js", () => ({}));
vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({}));
vi.mock("./doctor/shared/config-flow-steps.js", () => ({}));

it("rejects malformed authored records before acquiring the plugin lease", async () => {
  const source: ConfigFileSnapshot["sourceConfig"] = JSON.parse(
    '{"plugins":{"installs":{"owner":{"source":"unsupported"}}}}',
  );
  const snapshot = { ...m.snapshot, sourceConfig: source };
  await expect(importShippedPluginInstallConfigForDoctor(snapshot)).rejects.toThrow(
    "plugins.installs contains invalid records",
  );
  expect(m.lease).not.toHaveBeenCalled();
  expect(m.commitRecords).not.toHaveBeenCalled();
});
it.each([undefined, {}])(
  "does not acquire a lease for missing or empty records: %j",
  async (installs) => {
    m.snapshot.sourceConfig = { plugins: { installs } };
    await importShippedPluginInstallConfigForDoctor(m.snapshot);
    expect(m.lease).not.toHaveBeenCalled();
    expect(m.commitRecords).not.toHaveBeenCalled();
  },
);
