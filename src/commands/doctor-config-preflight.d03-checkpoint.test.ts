import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";

const m = vi.hoisted(() => ({
  events: [] as string[],
  ready: false,
  current: false,
  liveOwner: false,
  databaseReady: true,
  drift: false,
  recoveryMismatch: false,
  lease: vi.fn(),
  release: vi.fn(),
  valid: true,
  coreValid: true,
  fullRepairable: true,
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
  recordStartupMigrationWarnings: vi.fn(),
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
  withOpenClawStateDatabaseReadSnapshot: (run: () => unknown) => run(),
}));
vi.mock("../state/openclaw-state-db.paths.js", () => ({
  resolveOpenClawStateSqlitePath: () => "/synthetic-state/state.db",
}));
vi.mock("../state/openclaw-state-ownership.js", () => ({
  assertOpenClawStateWriteAllowedAtPath: vi.fn(),
}));
vi.mock("../utils.js", () => ({}));
vi.mock("./doctor-config-analysis.js", () => ({ noteDoctorConfigPreflightIssues: vi.fn() }));
vi.mock("./doctor-config-preflight-checkpoint.js", () => ({
  resolveMigrationCheckpointIdentity: (p: {
    snapshot: ConfigFileSnapshot;
    pluginMigrationFingerprint: string | null;
  }) =>
    p.snapshot.valid && p.pluginMigrationFingerprint
      ? {
          effectiveConfigFingerprint: "source",
          pluginDoctorConfigFingerprint: "source",
          pluginMigrationFingerprint: p.pluginMigrationFingerprint,
        }
      : null,
}));
vi.mock("./doctor-config-preflight-measure.js", () => ({
  measureDoctorConfigPreflightStep: async (_s: string, run: () => unknown) => await run(),
}));
vi.mock("./doctor-config-preflight-worker-scope.js", () => ({
  withDoctorConfigPreflightWorkerScope: (_o: unknown, run: () => unknown) => run(),
}));
vi.mock("./doctor-config-preflight.cron.js", () => ({}));
vi.mock("./doctor-plugin-host-links.js", () => ({}));
vi.mock("./doctor-startup-migration-refusal.js", () => ({
  refuseStartupMigrationsForLiveGatewayOwner: async () => {
    m.events.push("live-owner");
    if (m.liveOwner) {
      throw new Error("live owner");
    }
  },
  throwStartupMigrationGuardRejected: () => {
    throw new Error("guard rejected");
  },
  throwStartupMigrationIdentityChanged: () => {
    throw new Error("inputs changed");
  },
  throwStartupMigrationRefusal: (message: string) => {
    throw new Error(message);
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
  resolveStartupConfigSnapshot: (s: ConfigFileSnapshot) =>
    m.coreValid ? { ...s, valid: true } : undefined,
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
    prepare: m.inspect,
    observe: vi.fn(),
    converged: vi.fn(),
  }),
}));

vi.mock("../config/config-env-vars.js", () => ({
  cloneEnvWithPlatformSemantics: (e: unknown) => e,
}));
vi.mock("../agents/workspace-state-dirs.js", () => ({
  assertConfiguredWorkspaceStateReady: vi.fn(),
}));
vi.mock("../agents/agent-scope-config.js", () => ({ listAgentIds: () => ["main"] }));
vi.mock("../state/agent-database-admission.js", () => ({
  listAgentDatabaseAdmissionRefusals: () => [],
  readAgentDatabaseAdmissionRefusal: () => undefined,
}));
vi.mock("../state/agent-database-startup.js", () => ({}));
vi.mock("../state/openclaw-database-preflight.js", () => ({
  assertOpenClawDatabasesReady: async () => {
    m.events.push("database-ready");
    if (!m.databaseReady) {
      throw new Error("database not ready");
    }
  },
}));
vi.mock("../config/sessions/startup-migration.js", () => ({
  assertSessionStoreMigrationComplete: vi.fn(),
}));
vi.mock("../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreCandidateTargetsSync: () => [],
}));
vi.mock("../state/openclaw-agent-db-registry.js", () => ({
  inspectOpenClawRegisteredAgentDatabases: () => [],
}));
vi.mock("../runtime.js", () => ({ ExitError: class extends Error {} }));
vi.mock("../plugins/runtime-degraded-state.js", () => ({ setActiveDegradedPlugins: vi.fn() }));
vi.mock("./doctor-config-preflight-plugin-verification.js", () => ({
  runDoctorPluginConvergence: async () => {
    m.events.push("converge");
    if (m.refuse) {
      throw new Error("required owner unavailable");
    }
    m.ready = true;
    return { quarantinedPlugins: [], warnings: [], deferredPlugins: [] };
  },
  refreshStartupPluginQuarantine: async () => {
    m.events.push("quarantine");
    return { quarantinedPlugins: [], warnings: [], deferredPlugins: [] };
  },
}));
vi.mock("../config/io.factory.js", () => ({
  createConfigIO: (o: { pluginValidation?: string; deferDoctorLegacyIssues?: boolean }) => ({
    prepareConfigRecovery: async () => {
      m.events.push(o.pluginValidation === "core-only" ? "core-recovery" : "recovery");
      return m.recoveryMismatch && o.pluginValidation === "core-only"
        ? { snapshot: m.snapshot, apply: vi.fn() }
        : null;
    },
    readConfigFileSnapshotWithPluginMetadata: async () => m.metadata(o),
  }),
}));
vi.mock("./doctor/shared/pristine-startup-state.js", () => ({
  planPristineStartupStateMigrations: async () => ({
    skipAllStateMigrations: false,
    skipCoreStateMigrations: true,
  }),
}));
vi.mock("../infra/startup-migration-checkpoint.js", () => ({
  STARTUP_MIGRATION_HEARTBEAT_INTERVAL_MS: 60000,
  readMigrationCheckpointStatus: () => {
    m.events.push("checkpoint");
    return m.current ? "startup-current" : "stale";
  },
  acquireStartupMigrationLeaseWithWait: m.lease,
}));

beforeEach(() => {
  vi.clearAllMocks();
  m.events.length = 0;
  m.ready = false;
  m.current = false;
  m.liveOwner = false;
  m.databaseReady = true;
  m.drift = false;
  m.recoveryMismatch = false;
  m.valid = true;
  m.coreValid = true;
  m.fullRepairable = true;
  m.preview = true;
  m.refuse = false;
  m.guard = true;
  m.parseable = true;
  const source = {
    gateway: { mode: "local" as const },
    plugins: { entries: { fixture: { enabled: true } } },
  };
  m.snapshot = {
    path: "/synthetic/config.json",
    exists: true,
    raw: JSON.stringify(source),
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
  m.read.mockImplementation(async () => ({ ...m.snapshot, valid: m.valid }));
  m.metadata.mockImplementation(async (o?: { deferDoctorLegacyIssues?: boolean }) => {
    m.events.push("schema-read");
    if (!m.valid && !m.ready && !m.current && !o?.deferDoctorLegacyIssues) {
      throw new Error("invalid diagnostics before convergence");
    }
    const sourceConfig =
      m.drift && m.lease.mock.calls.length
        ? { ...m.snapshot.sourceConfig, gateway: { mode: "local", port: 19999 } }
        : m.snapshot.sourceConfig;
    return {
      snapshot: { ...m.snapshot, sourceConfig, valid: m.valid },
      pluginMetadataSnapshot: {
        configFingerprint: "available-payload",
        registrySource: "persisted",
      },
    };
  });
  m.legacy.mockImplementation((s: ConfigFileSnapshot) => {
    m.events.push("detector");
    if (!m.ready && !m.current) {
      throw new Error("detector before convergence");
    }
    return s;
  });
  m.inspect.mockImplementation(async () => {
    m.events.push("manifest");
    return [];
  });
  m.scope.mockImplementation((_s: unknown, run: () => unknown) => {
    m.events.push("scope");
    if (!m.ready && !m.current) {
      throw new Error("planner scope before convergence");
    }
    return run();
  });
  m.plan.mockImplementation((snapshot: ConfigFileSnapshot, o?: { pluginContracts?: boolean }) => {
    m.events.push(o?.pluginContracts === false ? "preview" : "full-plan");
    if (o?.pluginContracts !== false && !m.ready && !m.current) {
      throw new Error("full planner before convergence");
    }
    if (o?.pluginContracts !== false && !m.fullRepairable) {
      return null;
    }
    if (o?.pluginContracts === false && !m.preview) {
      return null;
    }
    return {
      snapshot: { ...snapshot, valid: true },
      config: snapshot.sourceConfig,
      writeConfig: snapshot.sourceConfig,
      changes: ["legacy repair"],
    };
  });
  m.lease.mockImplementation(async () => {
    m.events.push("lease");
    return { heartbeat: vi.fn(), release: m.release };
  });
});

const callers = ["Gateway", "state-checkpoint"] as const;
function runPreflight(caller: (typeof callers)[number]) {
  return runDoctorConfigPreflight({
    ...(caller === "Gateway"
      ? { requireStartupMigrationCheckpoint: true }
      : { requireStateMigrationCheckpoint: true }),
    migrateLegacyConfig: false,
    repairPrefixedConfig: true,
    skipPristineCoreStateMigrations: true,
    beforeStateMigrations: async () => {
      m.events.push("guard");
      return m.guard;
    },
    validateStartupConfig: () => {
      m.events.push("validate");
    },
  });
}
describe.each(callers)("%s executable diagnostics ordering", (caller) => {
  it.each([true, false])(
    "converges an available payload before detector or planner (valid=%s)",
    async (valid) => {
      m.valid = valid;
      await expect(runPreflight(caller)).rejects.toThrow("state boundary reached");
      expect(m.events).toContain("manifest");
      expect(m.events).toContain("converge");
      for (const event of ["detector", ...(valid ? [] : ["full-plan"])]) {
        expect(m.events.indexOf(event)).toBeGreaterThan(m.events.indexOf("converge"));
      }
      expect(m.events.indexOf("guard")).toBeLessThan(m.events.indexOf("lease"));
      expect(m.commit).not.toHaveBeenCalled();
      expect(m.release).toHaveBeenCalledOnce();
    },
  );
  it("defers a plugin-only repair when the core preview has no changes", async () => {
    m.valid = false;
    m.preview = false;
    await expect(runPreflight(caller)).rejects.toThrow("state boundary reached");
    expect(m.events.indexOf("full-plan")).toBeGreaterThan(m.events.indexOf("converge"));
    expect(m.commit).not.toHaveBeenCalled();
  });
  it("refuses a required owner without invoking executable diagnostics", async () => {
    m.refuse = true;
    await expect(runPreflight(caller)).rejects.toThrow("required owner unavailable");
    expect(m.legacy).not.toHaveBeenCalled();
    expect(m.scope).not.toHaveBeenCalled();
    expect(m.commit).not.toHaveBeenCalled();
  });
  it("preserves the current checkpoint fast path without convergence or lease", async () => {
    m.current = true;
    await expect(runPreflight(caller)).rejects.toThrow("state boundary reached");
    expect(m.events).not.toContain("converge");
    expect(m.lease).not.toHaveBeenCalled();
  });
});
it("refuses Gateway guard before acquiring a lease", async () => {
  m.guard = false;
  await expect(runPreflight("Gateway")).rejects.toThrow("guard rejected");
  expect(m.lease).not.toHaveBeenCalled();
  expect(m.events).not.toContain("converge");
  expect(m.legacy).not.toHaveBeenCalled();
});
it.each(["live-owner", "database"])(
  "preserves %s readiness before metadata and lease",
  async (kind) => {
    m.liveOwner = kind === "live-owner";
    m.databaseReady = kind !== "database";
    await expect(runPreflight("Gateway")).rejects.toThrow(
      kind === "live-owner" ? "live owner" : "database not ready",
    );
    expect(m.metadata).not.toHaveBeenCalled();
    expect(m.lease).not.toHaveBeenCalled();
    expect(m.inspect).not.toHaveBeenCalled();
  },
);
it("refuses changed source during the guarded lease reread", async () => {
  m.drift = true;
  await expect(runPreflight("Gateway")).rejects.toThrow("inputs changed");
  expect(m.events).not.toContain("converge");
  expect(m.release).toHaveBeenCalledOnce();
});
it("preserves prepared recovery agreement before lease acquisition", async () => {
  m.recoveryMismatch = true;
  await expect(runPreflight("Gateway")).rejects.toThrow("inputs changed");
  expect(m.lease).not.toHaveBeenCalled();
  expect(m.events).not.toContain("converge");
});

it("rejects an invalid core configuration without a core repair before lease", async () => {
  m.valid = false;
  m.coreValid = false;
  m.preview = false;
  await expect(runPreflight("Gateway")).rejects.toThrow("config is invalid");
  expect(m.lease).not.toHaveBeenCalled();
  expect(m.events).not.toContain("converge");
});

it.each(callers)(
  "%s refuses unrepaired plugin config after convergence before state migrations",
  async (caller) => {
    m.valid = false;
    m.preview = false;
    m.fullRepairable = false;
    await expect(runPreflight(caller)).rejects.toThrow("config is invalid");
    expect(m.events.indexOf("full-plan")).toBeGreaterThan(m.events.indexOf("converge"));
    expect(m.events).not.toContain("state-input");
    expect(m.commit).not.toHaveBeenCalled();
    expect(m.release).toHaveBeenCalledOnce();
  },
);
