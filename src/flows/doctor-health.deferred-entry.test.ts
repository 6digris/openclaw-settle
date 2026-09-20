import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DoctorDatabasePreflight } from "../commands/doctor-database-preflight.js";
import { prepareLegacyStateDatabaseSchema } from "../infra/state-migrations.doctor.js";
import type { LegacyStateMigrationStep } from "../infra/state-migrations.types.js";
import { UpdateDoctorError } from "../infra/update-doctor-result.js";
import { runDoctorHealthFlow } from "./doctor-health.js";

const mocks = vi.hoisted(() => {
  const events: string[] = [];
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const maintenance = {
    run: vi.fn(),
    assertCurrent: vi.fn(),
    release: vi.fn(),
    finish: vi.fn(),
    warnings: ["maintenance warning"],
  };
  return {
    events,
    runtime,
    maintenance,
    insideMaintenance: false,
    begin: vi.fn(),
    preflight: vi.fn(),
    guard: vi.fn(),
    writer: vi.fn(),
    admissions: vi.fn(),
    config: vi.fn(),
    aliases: vi.fn(),
    contributions: vi.fn(),
    offer: vi.fn(),
    ui: vi.fn(),
    readability: vi.fn(),
    result: vi.fn(),
    outro: vi.fn(),
    authority: undefined as { inputHash: string; assertCurrent: () => void } | undefined,
    capture: { hash: "unchanged", inputHash: "before", configChanges: [] },
  };
});
vi.mock("@clack/prompts", () => ({ intro: vi.fn(), outro: mocks.outro }));
vi.mock("../../packages/terminal-core/src/prompt-style.js", () => ({
  stylePromptTitle: (s: string) => s,
}));
vi.mock("../../packages/terminal-core/src/safe-text.js", () => ({
  sanitizeTerminalText: (s: string) => s,
}));
vi.mock("../logging/redact.js", () => ({ redactSensitiveText: (s: string) => s }));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock("../config/paths.js", () => ({
  resolveStateDir: () => "/synthetic/d04/state",
  resolveConfigPath: () => "/synthetic/d04/config.json",
}));
vi.mock("../infra/openclaw-root.js", () => ({ resolveOpenClawPackageRoot: async () => null }));
vi.mock("../config/config-write-guard.js", () => ({
  assertConfigWriteAllowedInCurrentMode: vi.fn(),
}));
vi.mock("../commands/doctor-maintenance.js", () => ({ beginDoctorMaintenance: mocks.begin }));
vi.mock("../commands/doctor-database-preflight.js", () => ({
  prepareDoctorDatabasePreflight: mocks.preflight,
}));
vi.mock("../commands/doctor-update-schema-guard.js", () => ({
  guardUpdateDoctorSchemaUpgrade: mocks.guard,
}));
vi.mock("../commands/doctor-prompter.js", () => ({
  createDoctorPrompter: () => ({ confirm: vi.fn() }),
}));
vi.mock("../commands/doctor-update.js", () => ({ maybeOfferUpdateBeforeDoctor: mocks.offer }));
vi.mock("../state/agent-database-admission.js", () => ({
  recordAgentDatabaseAdmissions: mocks.admissions,
}));
vi.mock("../state/openclaw-state-db.js", () => ({
  closeOpenClawStateDatabaseByPathAsync: vi.fn(async () => {}),
  repairOpenClawStateDatabaseSchema: mocks.writer,
  repairOpenClawStateDatabaseReadabilityForDoctor: mocks.readability,
}));
vi.mock("../state/openclaw-state-db.paths.js", () => ({
  resolveOpenClawStateSqlitePath: () => "/synthetic/d04/state/openclaw.sqlite",
}));
vi.mock("../commands/doctor-ui.js", () => ({ maybeRepairUiProtocolFreshness: mocks.ui }));
vi.mock("../commands/doctor-install.js", () => ({ noteSourceInstallIssues: vi.fn() }));
vi.mock("../commands/doctor/shared/plugin-runtime-symlinks.js", () => ({
  noteStalePluginRuntimeSymlinks: vi.fn(),
}));
vi.mock("../commands/doctor-platform-notes.js", () => ({ noteStartupOptimizationHints: vi.fn() }));
vi.mock("../commands/doctor/shared/automatic-startup-config-repair.js", () => ({
  repairDoctorConfigBeforePluginConvergence: mocks.aliases,
}));
vi.mock("../commands/doctor-config-flow.js", () => ({
  loadAndMaybeMigrateDoctorConfig: mocks.config,
}));
vi.mock("../config/config.js", () => ({ CONFIG_PATH: "/synthetic/d04/config.json" }));
vi.mock("./doctor-health-contributions.js", () => ({
  runDoctorHealthContributions: mocks.contributions,
}));
vi.mock("../commands/doctor-update-refusal.js", () => ({
  recordUpdateDoctorRefusal: vi.fn(),
  resolveUpdateDoctorGitRecovery: async () => undefined,
}));
vi.mock("../infra/update-rehearsal-paths.js", () => ({
  resolveUpdateRehearsalRoot: () => undefined,
}));
vi.mock("../infra/update-doctor-config.js", () => ({
  formatUpdateDoctorConfigChange: () => "config change",
}));
vi.mock("../infra/update-failure-facts.js", () => ({
  createUpdateFailureFact: (fact: unknown) => fact,
  normalizeUpdateFailureFacts: (facts: unknown) => facts,
}));
vi.mock("../infra/update-doctor-result.js", () => ({
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV: "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE: 86,
  UpdateDoctorError: class extends Error {
    constructor(
      message: string,
      public failureFacts: unknown[],
    ) {
      super(message);
    }
  },
  captureUpdateDoctorConfigWrites: async (
    _path: string,
    run: (capture: unknown) => unknown,
    authority: typeof mocks.authority,
  ) => {
    mocks.authority = authority;
    return await run(mocks.capture);
  },
  getUpdateDoctorConfigWriteAuthority: () => mocks.authority,
  normalizeUpdatePostInstallDoctorWarnings: (warnings: string[]) =>
    warnings.map((w) => w.trim()).filter(Boolean),
  createDeferredConfiguredPluginRepairDoctorResult: (details: string[]) => ({
    status: "advisory",
    advisory: {
      kind: "package-post-install-doctor",
      reason: "deferred-configured-plugin-repair",
      details,
    },
  }),
  writeUpdatePostInstallDoctorResult: mocks.result,
}));
vi.mock("../infra/state-migrations.plan.js", () => ({
  migrationStepPlan: (step: LegacyStateMigrationStep) => {
    const { run: _run, ...plan } = step;
    return plan;
  },
}));
// D04 exercises the real schema-only step runner. Unrelated migration owners
// are tripwires: this early entry must not enumerate or execute their inputs.
vi.mock("../agents/agent-scope-config.js", () => ({
  listAgentIds: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../agents/auth-profiles/shared-main-dir.js", () => ({
  resolveSharedMainAuthAgentDir: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../agents/install-agent-dir.js", () => ({
  resolveInstallAgentDir: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../agents/worktrees/registry.js", () => ({
  discardLegacyRegistryWorktrees: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  listLegacyRegistryWorktreesForMigration: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  listRegistryWorktreesForMigration: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  rewriteRegistryWorktreePathsForMigration: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../channels/plugins/registry.js", () => ({
  getChannelPlugin: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../config/io.runtime.js", () => ({
  readCurrentConfigForResolution: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../config/legacy.default-agent-owner.js", () => ({
  resolveSessionStoreCompatibilityAgentId: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../config/sessions/legacy-main-session-migration.js", () => ({
  migrateLegacyMainSessionKeys: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../config/sessions/session-store-config.js", () => ({
  isPerAgentSessionStoreConfig: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../config/sessions/targets.js", () => ({
  listConfiguredSessionStoreAgentIds: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveConfiguredAgentDatabaseTargets: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../plugins/doctor-contract-registry.js", () => ({
  collectRelevantDoctorPluginIds: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  listPluginDoctorSessionStoreAgentIds: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveLivePluginDoctorStateMigrationInventory: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolvePluginDoctorStateMigrationInventory: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../plugins/installed-plugin-index-store.js", () => ({
  resolveLegacyInstalledPluginIndexStorePath: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../plugins/legacy-session-surfaces.types.js", () => ({
  EMPTY_LEGACY_SESSION_SURFACES: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../routing/session-key.js", () => ({
  DEFAULT_ACCOUNT_ID: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  DEFAULT_MAIN_KEY: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  LEGACY_IMPLICIT_AGENT_ID: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  normalizeAgentId: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../state/openclaw-agent-db-registry.js", () => ({
  inspectOpenClawRegisteredAgentDatabases: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/boundary-path.js", () => ({
  resolveIdentityPathViaExistingAncestorSync: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/delivery-queue-legacy-files.js", () => ({
  detectLegacyDeliveryQueueFiles: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/pairing-files.js", () => ({
  listLegacyPairingStoreFiles: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/path-guards.js", () => ({
  isPathInside: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.acp-replay.js", () => ({
  detectLegacyAcpReplayLedger: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyAcpReplayLedger: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.agent-dir-receipt.js", () => ({
  legacyAgentQuarantineNotices: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveLegacyStandaloneAgentDir: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.apns.js", () => ({
  detectLegacyApnsRegistrations: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyApnsRegistrations: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.audit-logs.js", () => ({
  detectLegacyAuditLogs: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyAuditLogs: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.channel-pairing.js", () => ({
  detectLegacyChannelPairingState: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyChannelPairingState: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.commitments.js", () => ({
  detectLegacyCommitments: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyCommitments: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.config-machine-state.js", () => ({
  migrateLegacyConfigMachineState: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.debug-proxy.js", () => ({
  detectLegacyDebugProxyCaptureSidecar: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyDebugProxyCaptureSidecar: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.device-auth.js", () => ({
  detectLegacyDeviceAuth: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyDeviceAuth: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.device-identity.js", () => ({
  detectLegacyDeviceIdentity: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyDeviceIdentity: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.exec-approvals.js", () => ({
  detectLegacyExecApprovals: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyExecApprovals: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.fs.js", () => ({
  migrationFileExists: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  readSessionStoreJson5: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  safeReadDir: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.legacy-sessions.js", () => ({
  inspectLegacyAgentDir: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyAgentDir: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacySessions: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.managed-outgoing-images.js", () => ({
  detectLegacyManagedOutgoingImages: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyManagedOutgoingImages: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.mcp-oauth.js", () => ({
  detectLegacyMcpOAuthStores: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyMcpOAuthStores: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.meeting-transcripts.js", () => ({
  detectLegacyMeetingTranscripts: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyMeetingTranscripts: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.node-host.js", () => ({
  detectLegacyNodeHostConfig: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyNodeHostConfig: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.plugin-doctor.js", () => ({
  collectPluginDoctorStateMigrationPlans: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  runPluginDoctorStateMigrationPlans: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.plugin-state.js", () => ({
  migrateLegacyInstalledPluginIndex: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyPluginStateSidecar: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.prelude.js", () => ({
  buildLegacyStateMigrationPreludeSteps: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  buildUnresolvedBlockedPreludeSteps: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  createConfigMigrationSources: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  createDeferredPluginSessionStoreRefusal: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  inspectOrphanSessionStoreEndpoints: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  uniqueMigrationEndpoints: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.rescue-pending.js", () => ({
  detectLegacyRescuePending: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  discardLegacyRescuePending: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.restart-sentinel.js", () => ({
  detectLegacyRestartSentinel: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyRestartSentinel: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.runtime-state.js", () => ({
  migrateLegacyConfigHealth: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyCurrentConversationBindings: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyPluginBindingApprovals: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyVoiceWakeSettings: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveLegacyConfigHealthPath: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveLegacyCurrentConversationBindingsPath: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveLegacyPluginBindingApprovalsPath: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveLegacyVoiceWakeRoutingPath: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveLegacyVoiceWakeTriggersPath: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.session-store.js", () => ({
  listLegacySessionKeys: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  mergeSessionStoreAliasPlans: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyAcpSessionMetadata: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveStaleLegacySessionFile: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveSessionStoreOwnership: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.shared-auth-store.js", () => ({
  detectSharedAuthStoreMigration: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateSharedAuthStore: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.state-dir.js", () => ({
  autoMigrateLegacyStateDir: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolvePendingLegacyStateDirMigrationPaths: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.storage.js", () => ({
  PLUGIN_STATE_SQLITE_SIDECAR_SUFFIXES: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  TASK_STATE_SQLITE_SIDECAR_SUFFIXES: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  hasPendingSqliteSidecarArchive: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyTaskStateSidecars: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveLegacyFlowRunsSidecarPath: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveLegacyPluginStateSidecarPath: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveLegacyTaskRunsSidecarPath: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.subagent-registry.js", () => ({
  detectLegacySubagentRegistry: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacySubagentRegistry: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.tui-last-session.js", () => ({
  detectLegacyTuiLastSessions: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyTuiLastSessions: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.update-check.js", () => ({
  migrateLegacyUpdateCheckState: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  resolveLegacyUpdateCheckPath: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.web-push.js", () => ({
  detectLegacyWebPush: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyWebPush: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));
vi.mock("../infra/state-migrations.workspace-setup.js", () => ({
  detectLegacyWorkspaceState: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
  migrateLegacyWorkspaceState: vi.fn(() => {
    throw new Error("unexpected migration discovery");
  }),
}));

const ready = (): DoctorDatabasePreflight =>
  ({
    incompatible: [],
    indeterminate: [],
    pendingMigrations: [],
    agentRefusals: [],
  }) as unknown as DoctorDatabasePreflight;
const pending = (): DoctorDatabasePreflight =>
  ({
    ...ready(),
    pendingMigrations: [{ kind: "state", path: "/synthetic/d04/state/openclaw.sqlite" }],
  }) as unknown as DoctorDatabasePreflight;
function shippedParent() {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", "1");
  vi.stubEnv("OPENCLAW_COMPATIBILITY_HOST_VERSION", "2026.9.3");
  vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", "/synthetic/d04/result.json");
}
function expectNoDiscovery() {
  expect(mocks.config).not.toHaveBeenCalled();
  expect(mocks.contributions).not.toHaveBeenCalled();
  expect(mocks.ui).not.toHaveBeenCalled();
  expect(mocks.readability).not.toHaveBeenCalled();
  expect(mocks.maintenance.finish).not.toHaveBeenCalled();
  expect(mocks.outro).not.toHaveBeenCalledWith("Doctor complete.");
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.events.length = 0;
  mocks.insideMaintenance = false;
  mocks.authority = undefined;
  for (const name of [
    "OPENCLAW_UPDATE_IN_PROGRESS",
    "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE",
    "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
    "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR",
    "OPENCLAW_COMPATIBILITY_HOST_VERSION",
    "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
  ]) {
    vi.stubEnv(name, undefined);
  }
  mocks.aliases.mockResolvedValue([]);
  mocks.preflight.mockResolvedValue(ready());
  mocks.readability.mockReturnValue({ changes: [], warnings: [] });
  mocks.begin.mockResolvedValue(mocks.maintenance);
  mocks.maintenance.run.mockImplementation(async (run: () => Promise<unknown>) => {
    mocks.insideMaintenance = true;
    try {
      return await run();
    } finally {
      mocks.insideMaintenance = false;
    }
  });
  mocks.maintenance.assertCurrent.mockImplementation(() => {
    mocks.events.push("custody");
  });
  mocks.maintenance.release.mockImplementation(async () => {
    mocks.events.push("release");
  });
  mocks.result.mockImplementation(async () => {
    mocks.events.push("result");
  });
  mocks.runtime.exit.mockImplementation(() => {
    mocks.events.push("exit");
  });
  mocks.writer.mockImplementation(() => {
    mocks.events.push("writer");
    expect(mocks.insideMaintenance).toBe(true);
    return { changes: ["shared schema content applied"], warnings: [] };
  });
  mocks.config.mockImplementation(() => {
    throw new Error("stale plugin detector reached");
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("deferred Doctor-health entry", () => {
  it.each(
    ["explicit", "writable-parent"].flatMap((marker) =>
      [false, true].flatMap((repair) => [false, true].map((ipc) => ({ marker, repair, ipc }))),
    ),
  )(
    "defers without discovery or maintenance ($marker, repair=$repair, IPC=$ipc)",
    async ({ marker, repair, ipc }) => {
      vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
      vi.stubEnv(
        marker === "explicit"
          ? "OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR"
          : "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
        "1",
      );
      if (ipc) {
        vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", "/synthetic/d04/result.json");
      }
      await runDoctorHealthFlow(mocks.runtime, { repair, nonInteractive: true });
      expectNoDiscovery();
      expect(mocks.begin).not.toHaveBeenCalled();
      expect(mocks.preflight).not.toHaveBeenCalled();
      expect(mocks.writer).not.toHaveBeenCalled();
      expect(mocks.runtime.log).toHaveBeenCalledWith(expect.stringMatching(/deferred.*post-core/i));
      if (ipc) {
        expect(mocks.result).toHaveBeenCalledWith(
          expect.objectContaining({
            result: expect.objectContaining({
              status: "advisory",
              configHash: "unchanged",
              configInputHash: "before",
              advisory: expect.objectContaining({ reason: "deferred-configured-plugin-repair" }),
            }),
          }),
        );
        expect(mocks.runtime.exit).toHaveBeenCalledWith(86);
        expect(mocks.events).toEqual(["result", "exit"]);
      } else {
        expect(mocks.result).not.toHaveBeenCalled();
        expect(mocks.runtime.exit).not.toHaveBeenCalled();
      }
    },
  );

  it("uses supplied state facts and preserves agent refusals while repairing only shared schema under live custody", async () => {
    shippedParent();
    const schemas = pending();
    const refusals = [{ paths: ["/synthetic/d04/refused-agent.sqlite"], code: "kept" }];
    schemas.agentRefusals = refusals as unknown as DoctorDatabasePreflight["agentRefusals"];
    const assertCurrent = vi.fn(() => {
      mocks.events.push("requester");
    });
    await runDoctorHealthFlow(
      mocks.runtime,
      { repair: true },
      { inputHash: "before", assertCurrent },
      schemas,
    );
    expect(mocks.guard).toHaveBeenCalledWith({
      schemas,
      runtime: mocks.runtime,
      json: undefined,
      statePublicationOnly: true,
    });
    expect(mocks.admissions).toHaveBeenCalledWith(refusals);
    expect(mocks.preflight).toHaveBeenCalledExactlyOnceWith({ scope: "state" });
    expect(mocks.writer).toHaveBeenCalledExactlyOnceWith({
      env: expect.objectContaining({ OPENCLAW_STATE_DIR: "/synthetic/d04/state" }),
    });
    const writer = mocks.events.indexOf("writer");
    expect(mocks.events.slice(writer - 2, writer)).toEqual(["custody", "requester"]);
    expect(mocks.events.slice(-3)).toEqual(["release", "result", "exit"]);
    expect(mocks.result).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          status: "advisory",
          warnings: ["maintenance warning"],
          advisory: expect.objectContaining({
            details: [
              expect.stringMatching(/Shared state schema repair completed.*remain deferred/),
            ],
          }),
        }),
      }),
    );
    expectNoDiscovery();
  });

  it("does not replace existing agent admissions after a state-only refresh", async () => {
    shippedParent();
    mocks.preflight.mockResolvedValueOnce(pending()).mockResolvedValueOnce(ready());
    await runDoctorHealthFlow(mocks.runtime, { repair: true });
    expect(mocks.admissions).not.toHaveBeenCalled();
    expect(mocks.preflight.mock.calls).toEqual([[{ scope: "state" }], [{ scope: "state" }]]);
    expectNoDiscovery();
  });

  it("preserves supplied refusals even when only an advisory is needed", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", "1");
    const schemas = pending();
    const refusals = [{ paths: ["/synthetic/d04/refused-agent.sqlite"], code: "kept" }];
    schemas.agentRefusals = refusals as unknown as DoctorDatabasePreflight["agentRefusals"];
    await runDoctorHealthFlow(mocks.runtime, { repair: true }, undefined, schemas);
    expect(mocks.admissions).toHaveBeenCalledExactlyOnceWith(refusals);
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    expectNoDiscovery();
  });

  it("does not reacquire owners or run schema work for a prepared ready state", async () => {
    shippedParent();
    await runDoctorHealthFlow(mocks.runtime, { yes: true }, undefined, ready());
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.writer).not.toHaveBeenCalled();
    expectNoDiscovery();
  });

  it.each(["refused", "incomplete"])(
    "does not advertise convergence after %s shared schema repair",
    async (failure) => {
      shippedParent();
      if (failure === "refused") {
        mocks.writer.mockReturnValue({ changes: [], warnings: ["schema writer refused"] });
      } else {
        mocks.preflight.mockResolvedValue(pending());
      }
      await expect(
        runDoctorHealthFlow(mocks.runtime, { repair: true }, undefined, pending()),
      ).rejects.toThrow(failure === "refused" ? /state migration refused/ : /did not complete/);
      expect(mocks.result).toHaveBeenCalledWith(
        expect.objectContaining({ result: expect.objectContaining({ status: "error" }) }),
      );
      expect(mocks.runtime.exit).not.toHaveBeenCalled();
      expect(mocks.events.slice(-2)).toEqual(["release", "result"]);
      expectNoDiscovery();
    },
  );

  it("rechecks requester authority after awaited admission before the synchronous schema writer", async () => {
    shippedParent();
    let current = true;
    mocks.maintenance.run.mockImplementation(async (run: () => Promise<unknown>) => {
      current = false;
      return await run();
    });
    const assertCurrent = () => {
      if (!current) {
        throw new Error("requester custody expired");
      }
    };
    await expect(
      runDoctorHealthFlow(
        mocks.runtime,
        { repair: true },
        { inputHash: "before", assertCurrent },
        pending(),
      ),
    ).rejects.toThrow(/requester custody expired/);
    expect(mocks.writer).not.toHaveBeenCalled();
    expect(mocks.result).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ status: "error" }) }),
    );
    expect(mocks.maintenance.release).toHaveBeenCalledOnce();
  });

  it("retains UpdateDoctorError failure facts and result capture on schema-guard refusal", async () => {
    shippedParent();
    const facts = [
      { check: "schema", code: "update-schema-bump-unfenced", message: "old parent owns schema" },
    ];
    const error = new UpdateDoctorError("old parent owns schema", facts);
    mocks.guard.mockRejectedValue(error);
    await expect(
      runDoctorHealthFlow(mocks.runtime, { repair: true }, undefined, pending()),
    ).rejects.toBe(error);
    expect(mocks.writer).not.toHaveBeenCalled();
    expect(mocks.begin).not.toHaveBeenCalled();
    expect(mocks.result).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          status: "error",
          failureFacts: facts,
          configHash: "unchanged",
          configInputHash: "before",
        }),
      }),
    );
  });

  it.each([false, true])(
    "keeps ordinary and post-core diagnostic update offer behavior (post-core=%s)",
    async (postCore) => {
      if (postCore) {
        shippedParent();
        vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "1");
        vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", undefined);
      }
      mocks.begin.mockResolvedValue(undefined);
      mocks.offer.mockResolvedValue({ handled: true });
      await runDoctorHealthFlow(mocks.runtime, {});
      expect(mocks.preflight).toHaveBeenCalledExactlyOnceWith({ scope: "state" });
      expect(mocks.offer).toHaveBeenCalledOnce();
      expect(mocks.writer).not.toHaveBeenCalled();
      expect(mocks.runtime.exit).not.toHaveBeenCalled();
    },
  );
});

describe("existing schema-only owner", () => {
  it("retains conditional default behavior for existing preflight callers", async () => {
    mocks.writer.mockReturnValue({ changes: [], warnings: [] });
    const receipt = await prepareLegacyStateDatabaseSchema({});
    expect(receipt).toMatchObject({ id: "state-schema", requiredness: "conditional" });
    expect(mocks.writer).toHaveBeenCalledOnce();
  });
  it("checks live assertion immediately before writing and returns a required receipt", async () => {
    mocks.writer.mockReturnValue({ changes: ["content applied"], warnings: [] });
    const order: string[] = [];
    mocks.writer.mockImplementation(() => {
      order.push("write");
      return { changes: ["content applied"], warnings: [] };
    });
    const receipt = await prepareLegacyStateDatabaseSchema(
      {},
      {
        requiredness: "required",
        assertCurrent: () => {
          order.push("assert");
        },
      },
    );
    expect(order).toEqual(["assert", "write"]);
    expect(receipt).toMatchObject({
      id: "state-schema",
      requiredness: "required",
      outcome: "completed",
    });
  });
  it("never reaches the schema writer after its live assertion expires", async () => {
    const receipt = await prepareLegacyStateDatabaseSchema(
      {},
      {
        requiredness: "required",
        assertCurrent: () => {
          throw new Error("expired custody");
        },
      },
    );
    expect(mocks.writer).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      id: "state-schema",
      requiredness: "required",
      outcome: "refused",
      refusal: { message: "expired custody" },
    });
  });
});

describe("D08 deferred Doctor alias entry", () => {
  it.each([{ repair: true }, { yes: true }])(
    "runs aliases for explicit repair %j before returning advisory",
    async (options) => {
      shippedParent();
      mocks.aliases.mockResolvedValue(["Alias moved"]);
      await runDoctorHealthFlow(mocks.runtime, options, undefined, ready());
      expect(mocks.aliases).toHaveBeenCalledTimes(1);
      expect(mocks.runtime.log.mock.calls.map(([message]) => message)).toEqual([
        "Alias moved",
        expect.stringMatching(/remain deferred|repair deferred/),
      ]);
      expectNoDiscovery();
      expect(mocks.begin).not.toHaveBeenCalled();
      expect(mocks.result).toHaveBeenCalledWith(
        expect.objectContaining({
          result: expect.objectContaining({
            status: "advisory",
            configHash: "unchanged",
            configInputHash: "before",
          }),
        }),
      );
    },
  );
  it("does not write aliases during diagnostic deferral", async () => {
    shippedParent();
    await runDoctorHealthFlow(mocks.runtime, { repair: false }, undefined, ready());
    expect(mocks.aliases).not.toHaveBeenCalled();
    expectNoDiscovery();
  });
  it("runs alias writes within acquired schema maintenance and after schema completion", async () => {
    shippedParent();
    mocks.aliases.mockImplementation(async () => {
      expect(mocks.insideMaintenance).toBe(true);
      expect(mocks.events).toContain("writer");
      mocks.events.push("aliases");
      return ["Alias moved"];
    });
    await runDoctorHealthFlow(mocks.runtime, { repair: true }, undefined, pending());
    expect(mocks.aliases).toHaveBeenCalledTimes(1);
    expect(mocks.events.indexOf("writer")).toBeLessThan(mocks.events.indexOf("aliases"));
    expect(mocks.events.indexOf("aliases")).toBeLessThan(mocks.events.indexOf("release"));
    expectNoDiscovery();
  });
  it("propagates writer refusal before advisory and preserves result capture", async () => {
    shippedParent();
    mocks.aliases.mockRejectedValue(new Error("Config changed since planning"));
    await expect(
      runDoctorHealthFlow(mocks.runtime, { repair: true }, undefined, ready()),
    ).rejects.toThrow("Config changed since planning");
    expect(mocks.result).toHaveBeenCalledWith(
      expect.objectContaining({ result: expect.objectContaining({ status: "error" }) }),
    );
    expect(mocks.runtime.log).not.toHaveBeenCalledWith(expect.stringMatching(/repair deferred/));
    expectNoDiscovery();
  });
});
