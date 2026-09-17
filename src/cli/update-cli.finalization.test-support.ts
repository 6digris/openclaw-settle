import type { Mock } from "vitest";
import type { ConfigFileSnapshot, OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { UpdateRunResult } from "../infra/update-runner.js";
import type { CommandOptions, RunExecOptions, SpawnResult } from "../process/exec.js";
import type { UpdateCommandOptions } from "./update-cli/shared.js";

type ConfigReplaceParams = Parameters<typeof import("../config/config.js").replaceConfigFile>[0];

/** The finalization suite consumes these fixtures without importing its test entry point. */
export type UpdateCliFinalizationSuiteContext = {
  ExitError: typeof import("../runtime.js").ExitError;
  FRESH_POST_UPDATE_ENTRYPOINT: string;
  baseConfig: OpenClawConfig;
  baseSnapshot: ConfigFileSnapshot;
  capturedDoctorArgs: (argv: string[]) => string[];
  checkUpdateStatus: typeof import("../infra/update-check.js").checkUpdateStatus;
  completionCommandCall: () => [string[], Record<string, unknown>] | undefined;
  configSnapshot: (
    config: OpenClawConfig,
    overrides?: Partial<ConfigFileSnapshot>,
  ) => ConfigFileSnapshot;
  confirm: Mock;
  createCaseDir: (prefix: string) => string;
  createPreUpdateConfigSnapshotMock: Mock;
  defaultRuntime: typeof import("../runtime.js").defaultRuntime;
  doctorCommand: typeof import("../commands/doctor.js").doctorCommand;
  doctorProcessResult: (overrides?: Partial<SpawnResult>) => SpawnResult;
  expectFreshPostUpdateDoctor: (params: {
    yes: boolean;
    workspaceSuggestions?: boolean | undefined;
  }) => void;
  expectNoSideEffects: (...effects: unknown[]) => void;
  freshUpdateCommands: () => (
    | { argv: string[]; options: CommandOptions; order: number }
    | { argv: string[]; options: RunExecOptions | undefined; order: number }
  )[];
  gatewayCommandCall: (
    entryPath: string,
    action: "install" | "restart",
  ) => [string[], Record<string, unknown>] | undefined;
  getErrorOutput: () => string;
  initializeExistingUpdateProfile: (env?: NodeJS.ProcessEnv) => void;
  invokeUpdateCli: (opts: UpdateCommandOptions) => Promise<void>;
  lastNpmPluginUpdateCall: () =>
    | (Record<string, unknown> & {
        config?: OpenClawConfig | undefined;
        timeoutMs?: number | undefined;
      })
    | undefined;
  lastReplaceConfigCall: () => ConfigReplaceParams | undefined;
  lastWriteJsonCall: () => unknown;
  launchdUpdateCleanupMocks: {
    disableCurrentOpenClawUpdateLaunchdJob: Mock<() => Promise<boolean>>;
  };
  loadInstalledPluginIndexInstallRecords: Mock<
    (params?: {
      config?: OpenClawConfig;
      env?: NodeJS.ProcessEnv;
    }) => Promise<Record<string, PluginInstallRecord>>
  >;
  makeOkUpdateResult: (overrides?: Partial<UpdateRunResult>) => UpdateRunResult;
  mockCurrentProcessFreshDoctor: (params?: {
    postCoreResumeAttempt?: boolean | undefined;
    packageRoot?: string | undefined;
    candidateAdmission?: boolean | undefined;
  }) => void;
  mockFileBackedPathExists: () => void;
  mockGitUpdateAfterMutation: (
    result?: UpdateRunResult,
    reinspect?: boolean,
  ) => (void | {
    allowGatewayServiceRepair?: boolean | undefined;
    allowGatewayActivation?: boolean | undefined;
  })[];
  mockNpmGlobalCommands: (
    nodeModules: string,
    handle?: (
      argv: string[],
      optionsOrTimeout: number | CommandOptions,
    ) => SpawnResult | Promise<SpawnResult | undefined> | undefined,
    sourceCheckout?: string | (() => string),
  ) => void;
  mockPackageInstallAtCaseDir: (prefix?: string, version?: string) => Promise<string>;
  mockPackageInstallStatus: (root: string) => void;
  mockRunningManagedGateway: (programArguments?: string[]) => void;
  npmPluginUpdateResult: (config: OpenClawConfig) => {
    changed: boolean;
    config: OpenClawConfig;
    outcomes: never[];
  };
  packageInstallCommandCall: () => [string[], Record<string, unknown>] | undefined;
  pathExists: Mock;
  pluginSyncResult: (
    config: OpenClawConfig,
    changed?: boolean,
    overrides?: {
      warnings?: string[] | undefined;
      errors?: { pluginId: string; message: string; code?: string | undefined }[] | undefined;
    },
  ) => {
    changed: boolean;
    config: OpenClawConfig;
    summary: {
      warnings: string[];
      errors: { pluginId: string; message: string; code?: string | undefined }[];
      switchedToBundled: never[];
      switchedToClawHub: never[];
      switchedToNpm: never[];
    };
  };
  prepareRestartScript: Mock;
  primeServiceCommand: (
    programArguments: (string | undefined)[],
    environment?: NodeJS.ProcessEnv,
  ) => void;
  profileStateDir: (profile?: string) => string;
  readConfigFileSnapshot: typeof import("../config/config.js").readConfigFileSnapshot;
  registerUpdateCli: typeof import("./update-cli.js").registerUpdateCli;
  replaceConfigCall: (index?: number) => ConfigReplaceParams | undefined;
  replaceConfigFile: typeof import("../config/config.js").replaceConfigFile;
  requireValue: <T>(value: T | undefined, label: string) => T;
  resolveGatewayInstallEntrypoint: typeof import("../daemon/gateway-entrypoint.js").resolveGatewayInstallEntrypoint;
  resolveGitInstallDir: () => string;
  resolveOpenClawPackageRoot: typeof import("../infra/openclaw-root.js").resolveOpenClawPackageRoot;
  runCommandWithTimeout: typeof import("../process/exec.js").runCommandWithTimeout;
  runDaemonInstall: typeof import("./daemon-cli.js").runDaemonInstall;
  runExec: Mock<
    (
      command: string,
      args: string[],
      opts?: number | RunExecOptions,
    ) => Promise<{ stdout: string; stderr: string }>
  >;
  runGatewayUpdate: typeof import("../infra/update-runner.js").runGatewayUpdate;
  runRestartScript: Mock;
  runUtf8CommandWithTimeout: typeof import("../process/exec.js").runUtf8CommandWithTimeout;
  select: Mock;
  setTty: (value: boolean | undefined) => void;
  setupNonInteractiveDowngrade: () => Promise<string>;
  setupUpdatedRootRefresh: (params?: {
    gatewayUpdateImpl?: ((root: string) => Promise<UpdateRunResult>) | undefined;
    entrypoints?: string[] | undefined;
    admitMutation?: boolean | undefined;
    targetVersion?: string | undefined;
  }) => { root: string; entrypoints: string[] };
  sourceRuntimeCompletion: Mock<
    typeof import("./update-cli/update-command-runtime.js").completeSourceUpdateRuntime
  >;
  spawnCall: (
    index?: number,
  ) => [string, string[], { env?: NodeJS.ProcessEnv | undefined; stdio?: unknown }] | undefined;
  syncPluginCall: (index?: number) =>
    | (Record<string, unknown> & {
        channel?: string | undefined;
        config?: OpenClawConfig | undefined;
      })
    | undefined;
  syncPluginsForUpdateChannel: Mock;
  tempDirs: ReturnType<
    typeof import("../../test/helpers/temp-dir.js").useAutoCleanupTempDirTracker
  >;
  updateCliShared: typeof import("./update-cli/shared.js");
  updateCommand: typeof import("./update-cli/update-command.js").updateCommand;
  updateFinalizeCommand: typeof import("./update-cli/update-command-finalize.js").updateFinalizeCommand;
  updateNpmInstalledPlugins: Mock;
  updateStatusCommand: typeof import("./update-cli/status.js").updateStatusCommand;
  updateWizardCommand: typeof import("./update-cli/wizard.js").updateWizardCommand;
  writeJsonFixture: (filePath: string, value: unknown, trailingNewline?: boolean) => Promise<void>;
  writeOpenClawPackageFixture: (
    root: string,
    version: string,
    options?: {
      entryPath?: string | undefined;
      entrySource?: string | undefined;
      git?: boolean | undefined;
      builtSha?: string | undefined;
      inventory?: boolean | undefined;
    },
  ) => Promise<string>;
};
