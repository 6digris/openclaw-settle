import { afterEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  printResult: vi.fn(),
  gatewayCommand: vi.fn<
    typeof import("./update-command-service-command.js").runUpdatedInstallGatewayCommand
  >(async () => "accepted"),
  readRuntime: vi.fn(async (): Promise<{ status: string; pid?: number }> => ({
    status: "unknown",
  })),
  restartCandidate: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(
    async () => "ok",
  ),
  stopCandidate: vi.fn(),
  revalidateService: vi.fn<
    typeof import("./update-command-service-maintenance.js").revalidateManagedGatewayServiceAfterUpdate
  >(async ({ root }) => ({
    kind: "owned",
    root,
    fingerprint: "fixture",
    refreshDefinition: false,
  })),
  restart:
    vi.fn<
      typeof import("./update-command-service-recovery.js").maybeRestartServiceAfterFailedMutableUpdate
    >(),
  restoreWindowsAutoStart: vi.fn(async () => true),
  freshProcess: vi.fn(),
  writeSentinel: vi.fn<
    typeof import("./update-command-result.js").writeControlPlaneUpdateRestartSentinelBestEffort
  >(async () => undefined),
}));

vi.mock("./progress.js", () => ({ printResult: mocks.printResult }));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: mocks.gatewayCommand,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: async () => ({
    valid: true,
    config: {},
    sourceConfig: {},
    parsed: {},
    warnings: [],
    issues: [],
    legacyIssues: [],
  }),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => ({ readRuntime: mocks.readRuntime }),
  readGatewayServiceState: async () => ({
    installed: true,
    loadState: { status: "loaded" },
    env: {},
    command: { programArguments: ["node", "/repo/dist/entry.js", "gateway"] },
  }),
}));
vi.mock("./update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-maintenance.js")>()),
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidateService,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: mocks.restoreWindowsAutoStart,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stopCandidate,
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restartCandidate,
}));
vi.mock("./update-command-service-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-recovery.js")>()),
  maybeRestartServiceAfterFailedMutableUpdate: mocks.restart,
}));
vi.mock("./update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-plan.js")>()),
  resolveUpdatedGatewayRestartPort: async () => 19101,
}));
vi.mock("./update-command-post-core.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-post-core.js")>()),
  continuePostCoreUpdateInFreshProcess: mocks.freshProcess,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import { finishUpdate } from "./update-command-post-update.js";
import { UpdateCommandFailure } from "./update-command-result.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];
type UpdateProfileContext = FinishUpdateParams["profiles"][number];
export const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

export function failedResult(recovery: UpdateRunResult["recovery"]): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "doctor-failed",
    root: "/repo",
    recovery,
    steps: [],
    durationMs: 1,
  };
}

export async function finishFailedUpdate(
  result: UpdateRunResult,
  options: {
    failure?: { cause: unknown; detail: string };
    json?: boolean;
    stopped?: boolean;
    run?: FinishUpdateParams["opts"]["run"];
    originalRoot?: string;
    previousInstallRoot?: string;
    packageTransaction?: FinishUpdateParams["packageTransaction"];
    schemaVersions?: UpdateProfileContext["schemaVersions"];
    configSnapshot?: UpdateProfileContext["configSnapshot"];
    activationConfig?: { path: string; raw: string | null; hash: string };
    previousVerified?: boolean;
    windowsTaskAutoStartRecovery?: NonNullable<
      UpdateProfileContext["preManagedServiceStop"]
    >["windowsTaskAutoStartRecovery"];
  } = {},
): Promise<UpdateCommandFailure> {
  return await finishUpdate({
    mutationStarted: true,
    result,
    ...(options.failure ? { failure: options.failure } : {}),
    root: options.originalRoot ?? result.root ?? "/repo",
    previousInstallRoot: options.previousInstallRoot,
    packageTransaction: options.packageTransaction,
    installKindChanged: false,
    channel: "stable",
    downgradeRisk: false,
    shouldRestart: true,
    profiles: [
      {
        schemaVersions: options.schemaVersions,
        activationConfig: options.activationConfig,
        previousVerified: options.previousVerified,
        configSnapshot: options.configSnapshot ?? {
          path: "/fixture/openclaw.json",
          exists: false,
          raw: null,
          parsed: {},
          sourceConfig: asResolvedSourceConfig({}),
          resolved: asResolvedSourceConfig({}),
          valid: true,
          runtimeConfig: asRuntimeConfig({}),
          config: asRuntimeConfig({}),
          issues: [],
          warnings: [],
          legacyIssues: [],
        },
        requestedChannel: null,
        storedChannel: "stable",
        preManagedServiceStop: {
          stopped: options.stopped ?? true,
          inspected: true,
          runtimeInspected: true,
          running: true,
          serviceEnv: options.run?.env ?? {},
          windowsTaskAutoStartRecovery: options.windowsTaskAutoStartRecovery,
        },
        preUpdatePluginInstallRecords: {},
      },
    ],
    updateStepTimeoutMs: 1000,
    opts: { json: options.json, run: options.run },
    startedAt: Date.now(),
    controlPlaneUpdateSentinelMeta: null,
  }).then(
    () => {
      throw new Error("Expected failed update finalization to reject");
    },
    (error: unknown) => {
      if (!(error instanceof UpdateCommandFailure)) {
        throw error;
      }
      expect(error.result).toEqual(mocks.printResult.mock.lastCall?.[0]);
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
      return error;
    },
  );
}

export async function finishSkippedUpdate(reason: string): Promise<UpdateCommandFailure> {
  return await finishFailedUpdate(
    {
      status: "skipped",
      mode: reason === "dirty" || reason === "no-upstream" ? "git" : "unknown",
      reason,
      steps: [],
      durationMs: 1,
    },
    { stopped: false },
  );
}

export { mocks };
