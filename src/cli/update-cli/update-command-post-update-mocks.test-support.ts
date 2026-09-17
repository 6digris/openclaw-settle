import { afterEach, beforeEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  successfulPluginUpdate,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import * as sourceRuntime from "./update-command-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mocks = vi.hoisted(() => ({
  checkCompletionStatus: vi.fn(),
  completePluginUpdate: vi.fn(),
  ensureCompletionCache: vi.fn(),
  leaseActive: false,
  loadPluginRecords: vi.fn(),
  markSentinelFailure: vi.fn(async () => undefined),
  prepareRestartScript: vi.fn(async () => null),
  printResult: vi.fn(),
  readConfig: vi.fn(),
  createServiceConfigIO: vi.fn(),
  readServiceState: vi.fn(),
  restartService: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(),
  stopService:
    vi.fn<
      typeof import("./update-command-service-maintenance.js").maybeStopManagedServiceBeforeMutableUpdate
    >(),
  revalidateService:
    vi.fn<
      typeof import("./update-command-service-maintenance.js").revalidateManagedGatewayServiceAfterUpdate
    >(),
  updatePlugins: vi.fn(),
  writeSentinel: vi.fn<
    typeof import("./update-command-result.js").writeControlPlaneUpdateRestartSentinelBestEffort
  >(async () => undefined),
}));

vi.mock("./progress.js", () => ({ printResult: mocks.printResult }));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfig,
}));
vi.mock("../../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/io.js")>()),
  createConfigIO: mocks.createServiceConfigIO,
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.readServiceState,
}));
vi.mock("../../commands/doctor-completion.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/doctor-completion.js")>()),
  checkShellCompletionStatus: mocks.checkCompletionStatus,
  ensureCompletionCacheExists: mocks.ensureCompletionCache,
}));
vi.mock("../../plugins/plugin-lifecycle-lease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/plugin-lifecycle-lease.js")>();
  const withPluginLifecycleLease: typeof actual.withPluginLifecycleLease = (params, callback) =>
    actual.withPluginLifecycleLease(params, async (lease) => {
      const leaseWasActive = mocks.leaseActive;
      mocks.leaseActive = true;
      try {
        return await callback(lease);
      } finally {
        mocks.leaseActive = leaseWasActive;
      }
    });
  return { ...actual, withPluginLifecycleLease };
});
vi.mock("../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: mocks.loadPluginRecords,
}));
vi.mock("./update-command-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-config.js")>()),
  persistRequestedUpdateChannel: async (params: { configSnapshot: unknown }) =>
    params.configSnapshot,
  preparePostCorePluginConfig: async () => ({
    configSnapshot: await mocks.readConfig(),
    configWriteOptions: {},
    configChanged: false,
    restoredAuthoredChannels: [],
  }),
}));
vi.mock("./update-command-fresh-doctor.js", () => ({
  completePostCorePluginUpdate: mocks.completePluginUpdate,
}));
vi.mock("./update-command-plugins.js", () => ({
  updatePluginsAfterCoreUpdate: mocks.updatePlugins,
}));
vi.mock("./restart-helper.js", () => ({
  prepareRestartScript: mocks.prepareRestartScript,
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restartService,
}));
vi.mock("./update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-maintenance.js")>()),
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stopService,
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidateService,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  markControlPlaneUpdateRestartSentinelFailureBestEffort: mocks.markSentinelFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

const stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
function expectFailureReport(reason: string, options: unknown = expect.any(Object)) {
  expect(mocks.printResult).toHaveBeenCalledWith(
    expect.objectContaining({ status: "error", reason }),
    options,
    expect.any(Object),
  );
  expect(defaultRuntime.exit).not.toHaveBeenCalled();
}

function expectUpdateFailure(promise: Promise<unknown>, reason: string, details: object = {}) {
  return expect(promise).rejects.toMatchObject({
    name: "UpdateCommandFailure",
    exitCode: 1,
    result: { status: "error", reason },
    ...details,
  });
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (stdinIsTTYDescriptor) {
    Object.defineProperty(process.stdin, "isTTY", stdinIsTTYDescriptor);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime").mockResolvedValue({ changed: false });
  mocks.writeSentinel.mockReset().mockResolvedValue(undefined);
  mocks.readServiceState.mockReset();
  mocks.restartService.mockReset().mockResolvedValue("ok");
  mocks.stopService.mockReset();
  mocks.leaseActive = false;
  mocks.loadPluginRecords.mockResolvedValue({});
  mocks.revalidateService.mockImplementation(async ({ root, preManagedServiceStop }) => ({
    kind: "owned",
    root,
    fingerprint: "sealed",
    refreshDefinition:
      preManagedServiceStop?.serviceUpdateVerdict?.kind === "owned"
        ? preManagedServiceStop.serviceUpdateVerdict.refreshDefinition
        : true,
  }));
  mocks.readConfig.mockResolvedValue(validConfigSnapshot);
  mocks.createServiceConfigIO.mockReturnValue({ readBestEffortConfig: async () => ({}) });
  mocks.updatePlugins.mockResolvedValue(successfulPluginUpdate);
  mocks.completePluginUpdate.mockResolvedValue({
    pluginUpdate: successfulPluginUpdate,
    configSnapshot: validConfigSnapshot,
  });
  vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
});

export { expectFailureReport, expectUpdateFailure, mocks, tempDirs };
