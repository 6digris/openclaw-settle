import type fsSync from "node:fs";
import type { Mock, MockInstance } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { createUpdateCliConfigFixtures } from "./update-cli/update-cli-config.test-support.js";
import type {
  createUpdateCliPackageFixtures,
  createCurrentProcessFreshDoctorFixture,
} from "./update-cli/update-cli-package.test-support.js";

type ConfigFixtures = ReturnType<typeof createUpdateCliConfigFixtures>;
type PackageFixtures = ReturnType<typeof createUpdateCliPackageFixtures>;
type CommandCall = [string[], Record<string, unknown>];
type DoctorResult = Awaited<
  ReturnType<typeof import("../process/exec.js").runUtf8CommandWithTimeout>
>;

// The suite owns the mocks; extracted scenarios consume this leaf contract.
export type UpdateCliExtractedContext = Pick<
  ConfigFixtures,
  "configSnapshot" | "mockNpmPluginOutcomes" | "useFileBackedConfig"
> &
  Pick<
    PackageFixtures,
    | "mockFileBackedPathExists"
    | "mockNpmGlobalCommands"
    | "mockPackageGatewayLifecycle"
    | "mockRunningManagedGateway"
    | "setupInstalledPackageRoot"
  > & {
    DatabaseSync: typeof import("node:sqlite").DatabaseSync;
    ExitError: typeof import("../runtime.js").ExitError;
    FRESH_POST_UPDATE_ENTRYPOINT: string;
    VERSION: string;
    baseConfig: OpenClawConfig;
    candidateValidation: Mock;
    createCaseDir: (prefix: string) => string;
    createUpdateRun: typeof import("../infra/update-run-ledger.js").createUpdateRun;
    databasePreflightMocks: { preflightOpenClawDatabaseSchemas: Mock };
    defaultRuntime: typeof import("../runtime.js").defaultRuntime;
    doctorCommandCall: () => CommandCall | undefined;
    doctorProcessResult: (overrides?: Partial<DoctorResult>) => DoctorResult;
    expect: typeof import("vitest").expect;
    expectNoSideEffects: (...effects: unknown[]) => void;
    expectPackageInstallSpec: (spec: string) => void;
    fetchNpmPackageTargetStatus: typeof import("../infra/update-check-package-target.js").fetchNpmPackageTargetStatus;
    fetchNpmTagVersion: typeof import("../infra/update-check.js").fetchNpmTagVersion;
    freshRestartCalls: () => Parameters<
      typeof import("../process/exec.js").runCommandWithTimeout
    >[];
    fs: typeof import("node:fs/promises");
    fsSync: typeof import("node:fs");
    getErrorOutput: () => string;
    getLogOutput: () => string;
    getUpdateRun: typeof import("../infra/update-run-ledger.js").getUpdateRun;
    initializeExistingUpdateProfile: (env?: NodeJS.ProcessEnv) => void;
    it: typeof import("vitest").it;
    lastReplaceConfigCall: () =>
      | Parameters<typeof import("../config/config.js").replaceConfigFile>[0]
      | undefined;
    lastWriteJsonCall: () => unknown;
    listUpdateRuns: typeof import("../infra/update-run-ledger.js").listUpdateRuns;
    loadInstalledPluginIndexInstallRecords: Mock<
      (params?: {
        config?: OpenClawConfig;
        env?: NodeJS.ProcessEnv;
      }) => Promise<NonNullable<NonNullable<OpenClawConfig["plugins"]>["installs"]>>
    >;
    managedUpdateHandoff: { start: Mock; transfer: Mock; cancel: Mock };
    mockCurrentProcessFreshDoctor: ReturnType<typeof createCurrentProcessFreshDoctorFixture>;
    mockPackageInstallAtCaseDir: (prefix?: string, version?: string) => Promise<string>;
    nodeVersionSatisfiesEngine: typeof import("./update-cli/update-cli-process-mocks.test-support.js").updateCliProcessMocks.nodeVersionSatisfiesEngine;
    openOpenClawStateDatabase: typeof import("../state/openclaw-state-db.js").openOpenClawStateDatabase;
    packageInstallCommandCall: () => CommandCall | undefined;
    packageTargetStatus: typeof import("./update-cli/update-cli-package.test-support.js").packageTargetStatus;
    path: typeof import("node:path");
    pluginAvailabilityPreflight: Mock;
    postCoreConvergenceResult: typeof import("./update-cli/update-cli-config.test-support.js").postCoreConvergenceResult;
    prepareRestartScript: Mock;
    primeNpmChannelTag: (tag: string, version: string | null) => void;
    primeServiceCommand: (
      programArguments: Array<string | undefined>,
      environment?: NodeJS.ProcessEnv,
    ) => void;
    profileStateDir: (profile?: string) => string;
    readConfigFileSnapshot: typeof import("../config/config.js").readConfigFileSnapshot;
    readPackageVersion: Mock;
    registerAlreadyCurrentAdmissionTests: typeof import("./update-cli/update-command-current-admission.test-support.js").registerAlreadyCurrentAdmissionTests;
    replaceConfigFile: typeof import("../config/config.js").replaceConfigFile;
    requireValue: <T>(value: T | undefined, label: string) => T;
    resolveConfigPath: typeof import("../config/paths.js").resolveConfigPath;
    resolveGatewayInstallEntrypoint: typeof import("../daemon/gateway-entrypoint.js").resolveGatewayInstallEntrypoint;
    resolveNpmChannelTag: typeof import("../infra/update-check.js").resolveNpmChannelTag;
    resolveStateDir: typeof import("../config/paths.js").resolveStateDir;
    resolveUpdateInstallIdentity: typeof import("../infra/update-check.js").resolveUpdateInstallIdentity;
    resolveUpdateInstallKind: typeof import("../infra/update-check.js").resolveUpdateInstallKind;
    runCommandWithTimeout: typeof import("../process/exec.js").runCommandWithTimeout;
    runDaemonRestart: typeof import("./daemon-cli.js").runDaemonRestart;
    runPostCorePluginConvergenceSpy: MockInstance<
      typeof import("../commands/doctor/shared/post-core-plugin-convergence.js").runPostCorePluginConvergence
    >;
    runUtf8CommandWithTimeout: typeof import("../process/exec.js").runUtf8CommandWithTimeout;
    runtimeRecovery: typeof import("./update-cli/update-command-runtime-recovery.test-support.js");
    serviceReadRuntime: Mock;
    serviceRestart: Mock;
    serviceStart: Mock;
    serviceStop: Mock;
    setTty: (value: boolean | undefined) => void;
    statfsFixture: typeof statfsFixture;
    stripAnsi: typeof import("../../packages/terminal-core/src/ansi.js").stripAnsi;
    syncPluginsForUpdateChannel: Mock;
    systemdPolicy: Mock<
      typeof import("../daemon/systemd-maintenance.js").prepareSystemdGatewayMaintenance
    >;
    tempDirs: ReturnType<
      typeof import("../../test/helpers/temp-dir.js").useAutoCleanupTempDirTracker
    >;
    updateCommand: typeof import("./update-cli/update-command.js").updateCommand;
    updateGitCheckout: typeof import("../infra/update-runner-git.js").updateGitCheckout;
    updateNpmInstalledPlugins: Mock;
    versionManagerPath: typeof import("../shared/version-manager-path.js");
    vi: typeof import("vitest").vi;
    withEnvAsync: typeof import("../test-utils/env.js").withEnvAsync;
    writeJsonFixture: typeof import("./update-cli/update-cli-package.test-support.js").writeJsonFixture;
    writeNpmPackageInstall: typeof import("./update-cli/update-cli-package.test-support.js").writeNpmPackageInstall;
    writeOpenClawPackageFixture: typeof import("./update-cli/update-cli-package.test-support.js").writeOpenClawPackageFixture;
    writePackageDistInventory: typeof import("../../scripts/lib/package-dist-inventory.ts").writePackageDistInventory;
    writePersistedInstalledPluginIndexInstallRecordsWithLease: Mock<
      () => Promise<{ previous: null; revision: number }>
    >;
  };

export const statfsFixture = (params: {
  bavail: number;
  bsize?: number;
  blocks?: number;
}): ReturnType<typeof fsSync.statfsSync> => ({
  type: 0,
  bsize: params.bsize ?? 1024,
  blocks: params.blocks ?? 2_000_000,
  bfree: params.bavail,
  bavail: params.bavail,
  files: 0,
  frsize: params.bsize ?? 1024,
  ffree: 0,
});
