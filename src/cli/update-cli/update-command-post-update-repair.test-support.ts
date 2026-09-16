import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { GATEWAY_SERVICE_SELECTOR_ENV_KEYS } from "../../daemon/constants.js";
import { createUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";

const mocks = vi.hoisted(() => ({
  repair:
    vi.fn<typeof import("../../infra/update-repair-agent.js").prepareUnattendedUpdateRepair>(),
  rollback: vi.fn<typeof import("./update-command-rollback.js").rollbackFailedUpdate>(),
  restart: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(),
  restartCommand:
    vi.fn<typeof import("./update-command-service-command.js").runUpdatedInstallGatewayCommand>(),
  healthy: false,
  version: "2026.9.3",
  stop: vi.fn<
    typeof import("./update-command-service.js").maybeStopManagedServiceBeforeMutableUpdate
  >(),
  readyz: vi.fn(),
  print: vi.fn(),
  revalidate: vi.fn(),
  converge: vi.fn<typeof import("./update-command-convergence.js").convergeUpdatePlugins>(),
  readService: vi.fn<typeof import("../../daemon/service.js").readGatewayServiceState>(),
  execSchtasks: vi.fn<typeof import("../../daemon/schtasks-exec.js").execSchtasks>(),
}));
vi.mock("../../daemon/schtasks-exec.js", () => ({ execSchtasks: mocks.execSchtasks }));
vi.mock("../../infra/update-repair-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-repair-agent.js")>()),
  prepareUnattendedUpdateRepair: mocks.repair,
}));
vi.mock("./update-command-rollback.js", () => ({ rollbackFailedUpdate: mocks.rollback }));
vi.mock("./progress.js", () => ({ printResult: mocks.print }));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  tryWriteCompletionCache: async () => {},
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: async () => ({
    valid: true,
    exists: false,
    config: asRuntimeConfig({}),
    sourceConfig: asResolvedSourceConfig({}),
  }),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.readService,
}));
vi.mock("../daemon-cli/restart-health-probe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health-probe.js")>()),
  resolveGatewayRestartProbeContext: async () => ({ config: {} }),
  confirmGatewayReachable: async () => ({ reachable: false }),
}));
vi.mock("../daemon-cli/restart-health.js", async (importOriginal) => {
  const readHealth = async ({ expectedVersion }: { expectedVersion?: string }) => ({
    gatewayBootId: "repair-boot",
    healthy: mocks.healthy && mocks.version === expectedVersion,
    runtime: { status: mocks.healthy ? "running" : "stopped", pid: 4321 },
    gatewayVersion: mocks.version,
    expectedVersion,
    versionMismatch: mocks.version !== expectedVersion,
    portUsage: { status: "free", listeners: [] },
    staleGatewayPids: [],
  });
  return {
    ...(await importOriginal<typeof import("../daemon-cli/restart-health.js")>()),
    waitForGatewayHealthyRestart: readHealth,
    inspectGatewayRestart: readHealth,
    waitForGatewayHttpReadiness: mocks.readyz,
  };
});
vi.mock("./update-command-service-recovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-recovery.js")>()),
  hasLoadedLaunchdKeepAliveSupervisor: async () => false,
}));
vi.mock("./update-command-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restart,
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stop,
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidate,
  resolveUpdatedGatewayRestartPort: async () => 19101,
  tryInstallShellCompletion: async () => {},
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: mocks.restartCommand,
}));
vi.mock("./update-command-convergence.js", () => ({
  convergeUpdatePlugins: mocks.converge,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  writeControlPlaneUpdateRestartSentinelBestEffort: async () => {},
  markControlPlaneUpdateRestartSentinelFailureBestEffort: async () => {},
}));

export const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

export function fixture(): FinishUpdateParams {
  const home = dirs.make("post-update-repair-");
  for (const key of [
    "OPENCLAW_HOME",
    "OPENCLAW_SUPERVISOR_MODE",
    ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  const env = { ...process.env };
  const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
  return {
    mutationStarted: true,
    result: {
      status: "ok",
      mode: "npm",
      root: "/candidate",
      steps: [],
      durationMs: 1,
      before: { version: "2026.9.1" },
      after: { version: "2026.9.3" },
    },
    root: "/candidate",
    installKindChanged: false,
    channel: "stable",
    downgradeRisk: false,
    shouldRestart: true,
    opts: { json: true, run },
    controlPlaneUpdateSentinelMeta: null,
    profiles: [
      {
        configSnapshot: {
          path: configPath,
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
        ownedManagedUpdateEnv: env,
        preManagedServiceStop: {
          stopped: true,
          running: true,
          inspected: true,
          runtimeInspected: true,
          serviceEnv: env,
          serviceUpdateVerdict: {
            kind: "owned",
            root: "/candidate",
            fingerprint: "fixture",
            refreshDefinition: false,
          },
        },
        preUpdatePluginInstallRecords: {},
      },
    ],
    startedAt: Date.now(),
    updateStepTimeoutMs: 1_000,
    rollbackBlockedReason: "state-migrated-no-rollback",
  };
}

export function setupPostUpdateRepairTests() {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.healthy = false;
    mocks.version = "2026.9.3";
    mocks.readService.mockResolvedValue({
      installed: true,
      loadState: { status: "loaded" },
      running: false,
      runtime: { status: "stopped" },
      env: process.env,
      command: { programArguments: ["node", "/candidate/dist/entry.js", "gateway"] },
    });
    mocks.converge.mockImplementation(async (params) => ({
      resultWithPostUpdate: params.result,
    }));
    mocks.revalidate.mockResolvedValue({
      kind: "owned",
      root: "/candidate",
      fingerprint: "fixture",
      refreshDefinition: false,
    });
    mocks.readyz.mockImplementation(async () => ({ readyz: mocks.healthy ? 200 : 503 }));
    mocks.rollback.mockImplementation(async ({ result, rollbackBlockedReason }) => ({
      result: { ...result, reason: rollbackBlockedReason ?? "source-rollback-failed" },
      rolledBack: false,
    }));
    mocks.restart.mockImplementation(async (params) => {
      if (!mocks.restart.mock.calls.slice(0, -1).length) {
        if (params.opts.run) {
          recordUpdateRunPhase(params.opts.run.runId, "verifying", undefined, {
            env: params.opts.run.env,
          });
        }
        params.onVerificationFailure?.("readyz-unhealthy");
        return "restart-health-failed";
      }
      return mocks.healthy ? "ok" : "restart-health-failed";
    });
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
    vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  });
}

export { mocks };
