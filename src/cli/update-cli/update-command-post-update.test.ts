import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readRestartSentinel } from "../../infra/restart-sentinel.js";
import * as updateCheck from "../../infra/update-check.js";
import * as updateHandoff from "../../infra/update-managed-service-handoff.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import * as gitRecovery from "../../infra/update-runner-git-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as restartHealth from "../daemon-cli/restart-health.js";
import { UpdatePreMutationError } from "./shared.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  managedServiceState,
  programArguments,
  successfulPluginUpdate,
  taskRecovery,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import * as sourceRuntime from "./update-command-runtime.js";
import * as servicePlan from "./update-command-service-plan.js";

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
      typeof import("./update-command-service.js").maybeStopManagedServiceBeforeMutableUpdate
    >(),
  revalidateService:
    vi.fn<
      typeof import("./update-command-service.js").revalidateManagedGatewayServiceAfterUpdate
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
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stopService,
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidateService,
}));
vi.mock("./update-command-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-result.js")>()),
  markControlPlaneUpdateRestartSentinelFailureBestEffort: mocks.markSentinelFailure,
  writeControlPlaneUpdateRestartSentinelBestEffort: mocks.writeSentinel,
}));

import * as postCoreModule from "./update-command-post-core.js";
import { finishUpdate } from "./update-command-post-update.js";
import * as repairService from "./update-command-repair-service.js";
import * as rollbackModule from "./update-command-rollback.js";
import { UpdateServiceLoadBoundaryError } from "./update-command-service-load.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service.js";
import { recordUpdateGatewayHealth } from "./update-command-verification.js";

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];
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

describe("successful update finalization ordering", () => {
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

  it("does not finalize or clean an active durable run without its live executor", async () => {
    const home = tempDirs.make("finalizer-pending-recovery-");
    const env = { HOME: home, OPENCLAW_STATE_DIR: home };
    const run = createUpdateRun({ trigger: "cli" }, { env });
    const runtime = { root: home, nodePath: process.execPath, version: "1.0.0", buildId: null };
    const record = createRetainedUpdateRecovery(
      { runId: run.runId, from: runtime, to: runtime },
      { env },
    );
    const complete = vi.fn(async () => undefined);
    await expect(
      finishSuccessfulPackageSwitch(
        { run: { runId: run.runId, env } },
        {
          packageTransaction: { backupRoot: home, rollback: vi.fn(), complete },
        },
      ),
    ).rejects.toMatchObject({
      name: "UpdateCommandPendingRecoveryFailure",
      cause: { name: "UpdateRecoveryRequiredError" },
      result: { status: "error", recovery: { serviceRestartSafe: false } },
    });
    expect(complete).not.toHaveBeenCalled();
    expect(mocks.restartService).not.toHaveBeenCalled();
    expect(mocks.printResult).not.toHaveBeenCalled();
    expect(loadUpdateRecovery(run.runId, { env })).toEqual(record);
  });

  it("retains pending staged service load without legacy rollback or completion", async () => {
    const refusal = new UpdateServiceLoadBoundaryError("checkpoint seal refused");
    mocks.restartService.mockRejectedValueOnce(refusal);
    const rollback = vi
      .spyOn(rollbackModule, "rollbackFailedUpdate")
      .mockImplementationOnce(async ({ result }) => ({ result, rolledBack: false }));
    const complete = vi.fn<NonNullable<FinishUpdateParams["packageTransaction"]>["complete"]>(
      async () => undefined,
    );
    const finishing = finishSuccessfulPackageSwitch(undefined, {
      packageTransaction: { backupRoot: "/tmp/retained-previous", rollback: vi.fn(), complete },
    });
    await expect(finishing).rejects.toBe(refusal);
    expect(rollback).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(mocks.printResult).not.toHaveBeenCalled();
    expect(mocks.restartService).toHaveBeenCalledOnce();
  });

  it.each(["local", "fresh"] as const)(
    "keeps service activation behind awaited %s convergence and Doctor",
    async (execution) => {
      const identity = createManagedServiceIdentityFixture(
        tempDirs.make("update-convergence-order-"),
      );
      mocks.readServiceState.mockResolvedValue(managedServiceState(process.env));
      mocks.stopService.mockResolvedValue({
        inspected: true,
        runtimeInspected: true,
        running: true,
        stopped: true,
      });
      const events: string[] = [];
      const entered = createDeferred();
      const release = createDeferred();
      const plugins = { ...successfulPluginUpdate, changed: true };
      const converge = async () => {
        events.push("plugins");
        entered.resolve();
        await release.promise;
        return plugins;
      };
      vi.spyOn(postCoreModule, "shouldResumePostCoreUpdateInFreshProcess").mockReturnValue(
        execution === "fresh",
      );
      if (execution === "fresh") {
        vi.spyOn(postCoreModule, "continuePostCoreUpdateInFreshProcess").mockImplementationOnce(
          async () => ({ resumed: true, pluginUpdate: await converge() }),
        );
      } else {
        mocks.updatePlugins.mockImplementationOnce(converge);
      }
      mocks.completePluginUpdate.mockImplementationOnce(
        async (params: { beforeDoctor?: () => Promise<void> }) => {
          await params.beforeDoctor?.();
          events.push("doctor");
          return { pluginUpdate: plugins, configSnapshot: validConfigSnapshot };
        },
      );
      const recovery = taskRecovery((phase) => events.push(phase));
      mocks.restartService.mockImplementationOnce(async () => {
        events.push("start");
        return "ok";
      });
      const finishing = finishSuccessfulPackageSwitch({
        restartEnvironment: process.env,
        windowsTaskAutoStartRecovery: recovery,
      });
      try {
        try {
          await Promise.race([
            entered.promise,
            finishing.then(() => {
              throw new Error("Update completed before plugin convergence entered.");
            }),
          ]);
          expect.soft(mocks.restartService).not.toHaveBeenCalled();
          expect.soft(recovery.restore).not.toHaveBeenCalled();
        } finally {
          release.resolve();
        }
        await finishing;
      } finally {
        identity.restore();
      }
      expect(events.indexOf("doctor")).toBeLessThan(events.indexOf("restore"));
      expect(events.indexOf("doctor")).toBeLessThan(events.indexOf("start"));
      expect(mocks.restartService).toHaveBeenCalledOnce();
      expect(mocks.stopService).not.toHaveBeenCalled();
    },
  );

  it("restarts after completion status inspection fails", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.checkCompletionStatus.mockRejectedValueOnce(
      Object.assign(new Error("EACCES: completion profile read denied"), { code: "EACCES" }),
    );

    await expect.soft(finishSuccessfulPackageSwitch()).resolves.toBeUndefined();

    const output = vi.mocked(defaultRuntime.log).mock.calls.flat().map(String).join("\n");
    expect.soft(output).toContain("Shell completion refresh failed");
    expect.soft(output).toContain("Resolve the reported error before retrying");
    expect.soft(output).not.toContain("session only");
    expect.soft(mocks.restartService).toHaveBeenCalledOnce();
    expect(mocks.restartService.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.checkCompletionStatus.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("restarts when completion cache refresh reports failure", async () => {
    const root = tempDirs.make("openclaw-completion-failure-");
    await fs.writeFile(
      path.join(root, "openclaw.mjs"),
      'process.stderr.write("injected completion cache failure"); process.exit(1);',
    );

    await finishSuccessfulPackageSwitch({
      packageRoot: root,
      restartEnvironment: process.env,
    });

    const logCalls = vi.mocked(defaultRuntime.log).mock.calls;
    const warningIndex = logCalls.findIndex((call) =>
      call.some((value) => String(value).includes("Completion cache update failed")),
    );
    expect(warningIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.restartService.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(defaultRuntime.log).mock.invocationCallOrder[warningIndex] ??
        Number.POSITIVE_INFINITY,
    );
    expect(logCalls[warningIndex]?.join(" ")).toContain("openclaw completion --write-state");
  });

  it("restarts when shell completion cache generation returns false", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.checkCompletionStatus.mockResolvedValueOnce({
      shell: "zsh",
      profileInstalled: true,
      cacheExists: true,
      cachePath: "/tmp/openclaw-completion.zsh",
      usesSlowPattern: true,
    });
    mocks.ensureCompletionCache.mockResolvedValueOnce(false);

    await finishSuccessfulPackageSwitch();

    const output = vi.mocked(defaultRuntime.log).mock.calls.flat().map(String).join("\n");
    expect(output).toContain("completion cache generation failed");
    expect(output).toContain("Resolve the reported error before retrying");
    expect(output).not.toContain("source /tmp/openclaw-completion.zsh");
    expect(output).toContain("openclaw completion --write-state --install");
    expect(mocks.restartService).toHaveBeenCalledOnce();
    expect(mocks.restartService.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.ensureCompletionCache.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("keeps JSON completion cache failures silent and restarts", async () => {
    const root = tempDirs.make("openclaw-json-completion-failure-");
    await fs.writeFile(path.join(root, "openclaw.mjs"), "process.exit(1);");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });

    await finishSuccessfulPackageSwitch({
      packageRoot: root,
      restartEnvironment: process.env,
      json: true,
    });

    expect(defaultRuntime.error).not.toHaveBeenCalled();
    expect(mocks.checkCompletionStatus).not.toHaveBeenCalled();
    expect(mocks.restartService).toHaveBeenCalledOnce();
  });

  it("skips interactive completion in non-TTY mode", async () => {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });

    await finishSuccessfulPackageSwitch();

    expect(mocks.checkCompletionStatus).not.toHaveBeenCalled();
    expect(mocks.restartService).toHaveBeenCalledOnce();
  });

  it.each(["failed", "restart-health-failed"] as const)(
    "keeps %s blocking before completion refresh",
    async (outcome) => {
      Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
      mocks.restartService.mockResolvedValueOnce(outcome);

      await expectUpdateFailure(finishSuccessfulPackageSwitch(), "restart-unhealthy");

      expect(mocks.printResult).toHaveBeenCalledOnce();
      expectFailureReport("restart-unhealthy");
      expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "restart-unhealthy" }),
      );
      expect(mocks.checkCompletionStatus).not.toHaveBeenCalled();
    },
  );

  it("reports elapsed time through restart and shell completion refresh", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    mocks.restartService.mockImplementationOnce(async () => {
      now += 200;
      return "ok";
    });
    mocks.checkCompletionStatus.mockImplementationOnce(async () => {
      now += 300;
      return { shell: "zsh", profileInstalled: true, cacheExists: true, usesSlowPattern: false };
    });
    mocks.writeSentinel
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        now += 100;
      });
    await finishSuccessfulPackageSwitch();

    expect(mocks.printResult).toHaveBeenCalledOnce();
    expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({ status: "ok", durationMs: 500 });
    expect(mocks.writeSentinel.mock.lastCall?.[0].result).toEqual(
      mocks.printResult.mock.lastCall?.[0],
    );
  });

  it("reports Windows autostart recovery failure before exiting", async () => {
    const restoreError = new Error("task restore failed");
    const restore = vi.fn(async () => {
      throw restoreError;
    });

    await expectUpdateFailure(
      finishSuccessfulPackageSwitch({
        restartEnvironment: process.env,
        json: true,
        windowsTaskAutoStartRecovery: {
          ...taskRecovery(),
          restore,
        },
      }),
      "windows-task-autostart-restore-failed",
      { cause: restoreError, detail: expect.stringContaining(restoreError.message) },
    );

    expect(restore).toHaveBeenCalledOnce();
    expect(mocks.restartService).not.toHaveBeenCalled();
    expect(mocks.printResult).toHaveBeenCalledOnce();
    expectFailureReport(
      "windows-task-autostart-restore-failed",
      expect.objectContaining({ json: true }),
    );
    expect(mocks.writeSentinel.mock.lastCall?.[0].result).toEqual(
      mocks.printResult.mock.lastCall?.[0],
    );
  });

  it.each([
    { name: "retires the wrapper before persisting and printing success", denied: false },
    {
      name: "recovers and retains the package before reporting failed wrapper retirement",
      denied: true,
    },
  ])("$name", async ({ denied }) => {
    const home = tempDirs.make("openclaw-finalize-wrapper-");
    const previousRoot = path.join(home, "old-root");
    const wrapper = path.join(home, ".local", "bin", "openclaw");
    await fs.mkdir(path.dirname(wrapper), { recursive: true });
    await fs.writeFile(
      wrapper,
      `#!/usr/bin/env bash\nset -euo pipefail\nexec /usr/bin/node ${previousRoot}/dist/entry.js "$@"\n`,
      { mode: 0o755 },
    );
    vi.stubEnv("PATH", path.dirname(wrapper));
    const unlink = vi.spyOn(fs, "unlink");
    if (denied) {
      unlink.mockRejectedValueOnce(new Error("unlink denied"));
    }
    const rollback = vi
      .spyOn(rollbackModule, "rollbackFailedUpdate")
      .mockImplementationOnce(async ({ result }) => ({ result, rolledBack: false }));
    const retained = {
      name: "package backup retained",
      command: "openclaw update",
      cwd: previousRoot,
      durationMs: 0,
      exitCode: 0,
      stderrTail: "Retained previous package for recovery.",
    };
    const complete = vi.fn<NonNullable<FinishUpdateParams["packageTransaction"]>["complete"]>(
      async ({ activationVerified }) => (activationVerified ? undefined : retained),
    );
    const finishing = finishSuccessfulPackageSwitch(
      { previousRoot, packageRoot: path.join(home, "package") },
      { packageTransaction: { backupRoot: previousRoot, rollback: vi.fn(), complete } },
    );
    if (denied) {
      await expectUpdateFailure(finishing, "wrapper-retirement-failed", {
        detail: expect.stringContaining("unlink denied"),
      });
      expect(rollback).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledExactlyOnceWith(
        { activationVerified: false },
        expect.any(Function),
      );
      expect(mocks.printResult).toHaveBeenCalledOnce();
      expect(mocks.printResult.mock.lastCall?.[0]).toMatchObject({
        status: "error",
        steps: expect.arrayContaining([retained]),
      });
      expect(mocks.writeSentinel).toHaveBeenCalledOnce();
      expectFailureReport("wrapper-retirement-failed");
      expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "wrapper-retirement-failed" }),
      );
    } else {
      await finishing;
      expect(mocks.writeSentinel).toHaveBeenCalledTimes(2);
      expect(unlink.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.writeSentinel.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
      );
      expect(mocks.writeSentinel.mock.invocationCallOrder[1]).toBeLessThan(
        mocks.printResult.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
    }
  });

  it("releases the plugin lifecycle lease before fresh doctor completion", async () => {
    const pluginInstallRecords = {
      demo: {
        source: "npm",
        spec: "@acme/demo",
        installPath: "/tmp/demo",
      },
    };
    const ownedManagedUpdateEnv = {
      ...process.env,
      OPENCLAW_LIFECYCLE_TEST_MARKER: "owned",
    };
    mocks.readConfig.mockImplementationOnce(async () => {
      expect(mocks.leaseActive).toBe(true);
      expect(process.env.OPENCLAW_LIFECYCLE_TEST_MARKER).toBe("owned");
      return validConfigSnapshot;
    });
    mocks.loadPluginRecords.mockImplementationOnce(async () => {
      expect(mocks.leaseActive).toBe(true);
      expect(process.env.OPENCLAW_LIFECYCLE_TEST_MARKER).toBe("owned");
      return pluginInstallRecords;
    });
    mocks.updatePlugins.mockImplementationOnce(
      async (params: { pluginInstallRecords: unknown }) => {
        expect(mocks.leaseActive).toBe(true);
        expect(process.env.OPENCLAW_LIFECYCLE_TEST_MARKER).toBe("owned");
        expect(params.pluginInstallRecords).toBe(pluginInstallRecords);
        return successfulPluginUpdate;
      },
    );
    mocks.completePluginUpdate.mockImplementationOnce(async () => {
      expect(mocks.leaseActive).toBe(false);
      expect(process.env.OPENCLAW_LIFECYCLE_TEST_MARKER).toBe("owned");
      return {
        pluginUpdate: successfulPluginUpdate,
        configSnapshot: validConfigSnapshot,
      };
    });

    await finishSuccessfulPackageSwitch(
      {},
      { installKindChanged: false, downgradeRisk: false, ownedManagedUpdateEnv },
    );

    expect(mocks.readConfig).toHaveBeenCalledOnce();
    expect(mocks.loadPluginRecords).toHaveBeenCalledOnce();
    expect(mocks.updatePlugins).toHaveBeenCalledOnce();
    expect(mocks.completePluginUpdate).toHaveBeenCalledOnce();
    expect(mocks.leaseActive).toBe(false);
  });

  it("removes operator overrides and process identity from the managed install environment", async () => {
    vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("package");
    const identity = createManagedServiceIdentityFixture(
      tempDirs.make("openclaw-post-update-service-home-"),
    );
    const managedEnvironment = {
      ANTHROPIC_API_KEY: "managed-provider",
      MANAGED_VALUE: "base",
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
      OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.work",
    };
    const effectiveEnvironment = {
      ...managedEnvironment,
      ANTHROPIC_API_KEY: "drop-in-provider",
      OPENAI_API_KEY: "operator-only-provider",
    };
    mocks.readServiceState.mockResolvedValueOnce(
      managedServiceState(effectiveEnvironment, {
        environment: effectiveEnvironment,
        managedDefinition: { programArguments, environment: managedEnvironment },
        managedOverrides: {
          environment: { keys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "UNSET_PROVIDER_KEY"] },
        },
      }),
    );
    vi.stubEnv("ANTHROPIC_API_KEY", effectiveEnvironment.ANTHROPIC_API_KEY);
    vi.stubEnv("OPENAI_API_KEY", effectiveEnvironment.OPENAI_API_KEY);
    vi.stubEnv("UNSET_PROVIDER_KEY", "removed-by-drop-in");
    vi.stubEnv("GEMINI_API_KEY", "allowed-runtime-credential");
    vi.stubEnv("OPENCLAW_PROFILE", "caller-only-profile");
    const callerStateDir = path.join(identity.home, ".openclaw-caller-only-profile");
    vi.stubEnv("OPENCLAW_STATE_DIR", callerStateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(callerStateDir, "openclaw.json"));
    try {
      const ownedUpdateEnvironment: NodeJS.ProcessEnv = { ...process.env, ...effectiveEnvironment };
      for (const key of ["OPENCLAW_PROFILE", "OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]) {
        delete ownedUpdateEnvironment[key];
      }
      await finishSuccessfulPackageSwitch({
        restartEnvironment: ownedUpdateEnvironment,
      });

      const installEnv = mocks.restartService.mock.lastCall?.[0].serviceInstallEnv;
      expect(installEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(installEnv?.UNSET_PROVIDER_KEY).toBeUndefined();
      expect(installEnv?.ANTHROPIC_API_KEY).toBe("managed-provider");
      expect(installEnv?.MANAGED_VALUE).toBe("base");
      expect(installEnv?.GEMINI_API_KEY).toBe("allowed-runtime-credential");
      expect(installEnv?.OPENCLAW_PROFILE).toBeUndefined();
      expect(installEnv?.OPENCLAW_STATE_DIR).toBeUndefined();
      expect(installEnv?.OPENCLAW_CONFIG_PATH).toBeUndefined();
      expect(installEnv?.OPENCLAW_SERVICE_MARKER).toBeUndefined();
      expect(installEnv?.OPENCLAW_SERVICE_KIND).toBeUndefined();
      expect(installEnv?.OPENCLAW_LAUNCHD_LABEL).toBe("ai.openclaw.work");
    } finally {
      vi.unstubAllEnvs();
      identity.restore();
    }
  });

  it("reads the preserved service config without using the caller config or writing state", async () => {
    const { createConfigIO } =
      await vi.importActual<typeof import("../../config/io.js")>("../../config/io.js");
    mocks.createServiceConfigIO.mockImplementation(createConfigIO);
    const home = tempDirs.make("openclaw-restart-config-");
    const configPath = path.join(home, "openclaw.json");
    await fs.writeFile(configPath, JSON.stringify({ gateway: { mode: "local", port: 19600 } }));
    expect(
      await resolveUpdatedGatewayRestartPort({
        config: { gateway: { port: 19601 } },
        processEnv: { OPENCLAW_GATEWAY_PORT: "19602" },
        serviceEnv: { HOME: home, OPENCLAW_STATE_DIR: home, OPENCLAW_CONFIG_PATH: configPath },
        serviceCommand: {
          programArguments: ["/usr/bin/node", "/srv/openclaw/dist/index.js", "gateway"],
        },
      }),
    ).toBe(19600);
    expect(await fs.readdir(home)).toEqual(["openclaw.json"]);
  });

  it.each([false, true])(
    "keeps a foreground no-op online and parks only actual same-SHA publication (published=%s)",
    async (published) => {
      const root = tempDirs.make("foreground-source-completion-");
      const env = {
        OPENCLAW_STATE_DIR: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_UPDATE_RUN_HANDOFF: undefined,
      };
      await withEnvAsync(env, async () => {
        const created = createUpdateRun({ trigger: "api" });
        const run: NonNullable<FinishUpdateParams["opts"]["run"]> = {
          runId: created.runId,
          env: { ...process.env },
          completionOwner: "gateway-restart",
        };
        const park = vi
          .spyOn(updateHandoff, "parkForegroundUpdateHandoff")
          .mockImplementation(async ({ run: parked }) => {
            parked.gatewayRestartRequired = true;
          });
        vi.mocked(sourceRuntime.completeSourceUpdateRuntime).mockImplementation(
          async ({ beforePublication }) => {
            if (published) await beforePublication?.();
            return { changed: published };
          },
        );
        await finishSuccessfulPackageSwitch(
          { packageRoot: root, run, json: true },
          {
            coreAlreadyCurrent: true,
            shouldRestart: false,
            result: {
              status: "skipped",
              reason: "already-current",
              mode: "git",
              root,
              before: { sha: "same", version: "1.0.0" },
              after: { sha: "same", version: "1.0.0" },
              steps: [],
              durationMs: 0,
            },
          },
        );
        expect(park).toHaveBeenCalledTimes(published ? 1 : 0);
        expect(run.gatewayRestartRequired).toBe(published ? true : undefined);
        expect(getUpdateRun(run.runId)).toMatchObject(
          published
            ? { status: "running", phase: "restarting" }
            : { status: "skipped", phase: "finished", reason: "already-current" },
        );
        expect(mocks.stopService).not.toHaveBeenCalled();
      });
    },
  );

  describe("managed service finalization", () => {
    let identity: ReturnType<typeof createManagedServiceIdentityFixture>;
    beforeEach(() => {
      identity = createManagedServiceIdentityFixture(
        tempDirs.make("openclaw-post-update-service-home-"),
      );
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      identity.restore();
    });

    it.each([
      "unchanged",
      "stale-version",
      "stale-build",
      "stale-foreground",
      "stale-native-command-failed",
      "stale-foreground-command-failed",
      "unreachable",
      "missing-build",
      "foreign-pid",
      "shared-source",
      "partial-parking-failed",
      "publication-refused",
      "restore-unverified",
    ] as const)(
      "keeps current-core plugin work local and selects only proven runtime obligations (%s)",
      async (outcome) => {
        const stale = outcome.startsWith("stale-");
        const foreground = outcome.includes("foreground");
        const commandFailed = outcome.endsWith("command-failed");
        const profiles: FinishUpdateParams["profiles"] = ["primary", "ops", "paused"].map(
          (name) => {
            const env = {
              ...process.env,
              OPENCLAW_PROFILE: name,
              OPENCLAW_STATE_DIR: path.join(identity.home, name),
            };
            return {
              configSnapshot: validConfigSnapshot,
              requestedChannel: null,
              storedChannel: null,
              preUpdatePluginInstallRecords: {},
              ownedManagedUpdateEnv: env,
              preManagedServiceStop: {
                inspected: true,
                runtimeInspected: true,
                running: name !== "paused",
                stopped: false,
                serviceEnv: env,
                serviceNodeRunner: `/nodes/${name}`,
                serviceUpdateVerdict: {
                  kind: "owned" as const,
                  root: "/tmp/openclaw-update",
                  fingerprint: name,
                  refreshDefinition: false,
                },
              },
            };
          },
        );
        if (foreground) {
          profiles[0]!.preManagedServiceStop = undefined;
        }
        const parkForeground = vi.spyOn(updateHandoff, "parkForegroundUpdateHandoff");
        const events: string[] = [];
        const publication =
          outcome === "shared-source" ||
          outcome === "partial-parking-failed" ||
          outcome === "publication-refused" ||
          outcome === "restore-unverified";
        const failed =
          outcome === "partial-parking-failed" ||
          outcome === "publication-refused" ||
          outcome === "restore-unverified";
        const recoveryProof = vi
          .spyOn(gitRecovery, "readCurrentGitUpdateRecovery")
          .mockResolvedValue({
            serviceRestartSafe: true,
            version: "2026.4.24",
            buildId: "current",
          });
        const service = await import("./update-command-service.js");
        if (commandFailed) {
          const native = await import("../../daemon/service.js");
          vi.spyOn(native, "resolveGatewayService").mockReturnValue({
            ...native.resolveGatewayService(),
            readRuntime: async () => ({ status: "stopped" }),
          });
          vi.spyOn(repairService, "repairUpdateService").mockImplementation(
            async ({ result }) => result,
          );
        }
        vi.spyOn(service, "maybeRestartServiceAfterFailedMutableUpdate").mockImplementation(
          async ({ preManagedServiceStop, nodeRunner }) => {
            if (!preManagedServiceStop?.stopped) {
              return undefined;
            }
            const name = preManagedServiceStop.serviceEnv?.OPENCLAW_PROFILE;
            expect(nodeRunner).toBe(`/nodes/${name}`);
            events.push(`recover:${name}`);
            return "healthy";
          },
        );
        vi.spyOn(sourceRuntime, "completeSourceUpdateRuntime").mockImplementation(
          async ({ beforePublication }) => {
            events.push("source-prepared");
            if (publication) {
              await beforePublication?.();
              if (outcome === "publication-refused") {
                throw new UpdatePreMutationError(
                  "runtime-artifact-publication",
                  "fixture consumer prevents publication",
                );
              }
              if (outcome === "restore-unverified") {
                throw new Error("fixture restoration unverified");
              }
              events.push("source-published");
            }
            return { changed: publication };
          },
        );
        vi.spyOn(servicePlan, "resolvePackageRuntimePreflight").mockImplementation(
          async ({ nodeRunner }) => ({ ok: true, value: { nodeRunner } }),
        );
        vi.spyOn(restartHealth, "inspectGatewayRestart").mockResolvedValue({
          runtime: { status: "running", pid: 44 },
          healthy: false,
          staleGatewayPids: [],
          portUsage: {
            port: 18789,
            status: "busy",
            listeners: [{ pid: outcome === "foreign-pid" ? 45 : 44 }],
            hints: [],
          },
          ...((stale && outcome !== "stale-build") || outcome === "foreign-pid"
            ? { versionMismatch: { expected: "2026.4.24", actual: "2026.4.23" } }
            : {}),
          ...(outcome === "stale-build"
            ? { buildIdMismatch: { expected: "current", actual: "previous" } }
            : {}),
          ...(outcome === "missing-build"
            ? { buildIdMismatch: { expected: "current", actual: null } }
            : {}),
          ...(outcome === "unreachable" ? { probeError: "fixture unreachable" } : {}),
        });
        mocks.stopService.mockImplementation(async ({ expectedService, onStopped }) => {
          const name = expectedService?.serviceEnv?.OPENCLAW_PROFILE;
          events.push(`stop:${name}`);
          const profile = profiles.find(
            (entry) => entry.ownedManagedUpdateEnv?.OPENCLAW_PROFILE === name,
          )!;
          const stopped = { ...profile.preManagedServiceStop!, stopped: true };
          onStopped?.(stopped);
          if (outcome === "partial-parking-failed" && name === "ops") {
            throw new Error("fixture native stop failed after parking");
          }
          return stopped;
        });
        mocks.readServiceState.mockImplementation(async () =>
          managedServiceState({ ...process.env }),
        );
        mocks.updatePlugins.mockImplementation(async () => {
          events.push(`plugins:${process.env.OPENCLAW_PROFILE}`);
          return successfulPluginUpdate;
        });
        mocks.restartService.mockImplementation(async (restart) => {
          const verificationRun =
            restart.recordGatewayVerification === false ? undefined : restart.opts.run;
          const name = process.env.OPENCLAW_PROFILE;
          expect(restart.nodeRunner).toBe(`/nodes/${name}`);
          if (stale) expect(restart.opts.run).toBe(runOptions);
          events.push(`restart:${name}`);
          if (commandFailed) {
            await service.recordFailedUpdateGatewayState(
              verificationRun,
              restart.serviceEnv ?? process.env,
            );
            return "failed";
          }
          if (stale) {
            recordUpdateGatewayHealth(
              verificationRun,
              {
                runtime: { status: "running", pid: 202 },
                healthy: true,
                gatewayVersion: "2026.4.24",
                gatewayBuildId: "current",
                expectedVersion: "2026.4.24",
                staleGatewayPids: [],
                portUsage: { port: 19102, status: "busy", listeners: [{ pid: 202 }], hints: [] },
              },
              19102,
              true,
            );
            restart.result.steps.push({
              name: "gateway verification",
              command: "gateway verification",
              cwd: restart.result.root!,
              durationMs: 1,
              exitCode: 0,
            });
            restart.onVerified?.(Date.now());
          }
          return "ok";
        });
        const runEnv = profiles[0]!.ownedManagedUpdateEnv!;
        const run =
          outcome === "shared-source" || stale
            ? createUpdateRun({ trigger: "api" }, { env: runEnv })
            : undefined;
        const originVerification = {
          serviceRunning: true,
          pid: 101,
          port: 19101,
          runningVersion: "2026.4.24",
          runningBuildId: "current",
          versionMatch: true,
          readyz: true,
          settled: true,
          channelsReady: true,
          pluginErrors: [],
        };
        if (run && stale) {
          recordUpdateRunVerification(run.runId, originVerification, { env: runEnv });
        }
        const runOptions: FinishUpdateParams["opts"]["run"] = run
          ? {
              runId: run.runId,
              env: runEnv,
              ...(foreground ? { completionOwner: "gateway-restart" } : {}),
            }
          : undefined;
        if (run && outcome === "shared-source") {
          const actual = await vi.importActual<typeof import("./update-command-result.js")>(
            "./update-command-result.js",
          );
          mocks.writeSentinel.mockImplementation(
            actual.writeControlPlaneUpdateRestartSentinelBestEffort,
          );
        }
        const finishing = finishSuccessfulPackageSwitch(
          {
            restartEnvironment: runEnv,
            ...(runOptions ? { run: runOptions } : {}),
          },
          {
            profiles,
            coreAlreadyCurrent: true,
            packageUpdateNodeRunner: "/nodes/unused-fallback",
            ...(run ? { controlPlaneUpdateSentinelMeta: { runId: run.runId } } : {}),
            result: {
              status: "skipped",
              reason: "already-current",
              mode: publication ? "git" : "npm",
              root: "/tmp/openclaw-update",
              before: { version: "2026.4.24", sha: "same-source-head" },
              after: { version: "2026.4.24", buildId: "current", sha: "same-source-head" },
              steps: [],
              durationMs: 0,
            },
          },
        );
        if (commandFailed) {
          await expect(finishing).rejects.toMatchObject({ result: { status: "error" } });
        } else if (failed) {
          await expect(finishing).rejects.toMatchObject({
            result: {
              status: "error",
              recovery: { serviceRestartSafe: outcome !== "restore-unverified" },
            },
          });
        } else {
          await finishing;
        }
        if (stale) {
          expect(getUpdateRun(run!.runId, { env: runEnv })?.verification).toEqual(
            originVerification,
          );
          expect(runOptions?.gatewayRestartRequired).toBeUndefined();
          expect(parkForeground).not.toHaveBeenCalled();
          if (!commandFailed) {
            expect(mocks.printResult.mock.lastCall?.[0].steps).toContainEqual(
              expect.objectContaining({ name: "profile 2: gateway verification", exitCode: 0 }),
            );
          }
        }
        expect(events.filter((event) => event.startsWith("plugins:"))).toEqual(
          failed ? [] : ["plugins:primary"],
        );
        expect(events.filter((event) => event.startsWith("stop:"))).toEqual(
          publication ? ["stop:primary", "stop:ops"] : stale ? ["stop:ops"] : [],
        );
        expect(events.filter((event) => event.startsWith("restart:"))).toEqual(
          outcome === "shared-source"
            ? ["restart:ops", "restart:primary"]
            : stale
              ? ["restart:ops"]
              : [],
        );
        if (outcome === "shared-source") {
          expect(getUpdateRun(run!.runId, { env: runEnv })).toMatchObject({ status: "succeeded" });
          expect((await readRestartSentinel(runEnv))?.payload).toMatchObject({
            status: "ok",
            stats: { runId: run!.runId },
          });
          expect(events.indexOf("source-prepared")).toBeLessThan(events.indexOf("stop:primary"));
          expect(events.indexOf("stop:ops")).toBeLessThan(events.indexOf("source-published"));
          expect(events.indexOf("source-published")).toBeLessThan(
            events.indexOf("plugins:primary"),
          );
        }
        expect(mocks.printResult.mock.lastCall?.[0].status).toBe(
          failed || commandFailed
            ? "error"
            : stale || outcome === "shared-source"
              ? "ok"
              : "skipped",
        );
        expect(events.filter((event) => event.startsWith("recover:"))).toEqual(
          failed && outcome !== "restore-unverified" ? ["recover:ops", "recover:primary"] : [],
        );
        expect(recoveryProof).toHaveBeenCalledTimes(
          failed && outcome !== "restore-unverified" ? 1 : 0,
        );
        expect(profiles[2]!.preManagedServiceStop!.stopped).toBe(false);
      },
    );

    it.each([
      "healthy",
      "offline-origin",
      "sibling-convergence-failed",
      "origin-verification-failed",
      "repair-both",
      "repair-healthy-then-failed",
      "repair-pending-then-failed",
    ] as const)(
      "finalizes one shared package only after every profile settles (%s)",
      async (outcome) => {
        const laterRepairFailure = outcome.endsWith("then-failed");
        const pendingRepair = outcome === "repair-pending-then-failed";
        const successful =
          outcome === "healthy" || outcome === "offline-origin" || outcome === "repair-both";
        if (outcome === "offline-origin" || laterRepairFailure) {
          const service = await import("../../daemon/service.js");
          vi.spyOn(service, "resolveGatewayService").mockReturnValue({
            ...service.resolveGatewayService(),
            readRuntime: async () => ({ status: "stopped" }),
          });
        }
        const enabled = new Set<string>();
        const activations: string[] = [];
        const windows = new Map(
          ["primary", "ops"].map(
            (name) =>
              [
                name,
                {
                  ...taskRecovery(),
                  restore: vi.fn(async () => {
                    if (!enabled.has(name)) activations.push(name);
                    enabled.add(name);
                  }),
                  complete: vi.fn(async (safe = true) => {
                    if (!safe) enabled.delete(name);
                  }),
                },
              ] as const,
          ),
        );
        const profiles = ["primary", "ops", "paused"].map((name) => {
          const running = name !== "paused" && (name !== "primary" || outcome !== "offline-origin");
          const stateDir = path.join(identity.home, `.openclaw-${name}`);
          const env = { ...process.env, OPENCLAW_PROFILE: name, OPENCLAW_STATE_DIR: stateDir };
          return {
            configSnapshot: { ...validConfigSnapshot, path: path.join(stateDir, "openclaw.json") },
            requestedChannel: null,
            storedChannel: null,
            preUpdatePluginInstallRecords: {},
            ownedManagedUpdateEnv: env,
            packageUpdateNodeRunner: `/nodes/${name}`,
            serviceRuntimeRefreshRequired: false,
            preManagedServiceStop: {
              inspected: true,
              runtimeInspected: true,
              running,
              stopped: running,
              serviceEnv: env,
              windowsTaskAutoStartRecovery: laterRepairFailure ? windows.get(name) : undefined,
              serviceUpdateVerdict: {
                kind: "owned" as const,
                root: "/tmp/openclaw-update",
                fingerprint: name,
                refreshDefinition: false,
              },
            },
          };
        });
        const env = profiles[0]!.ownedManagedUpdateEnv;
        const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
        const events: string[] = [];
        const complete = vi.fn(async () => {
          events.push("package-complete");
        });
        mocks.readServiceState.mockImplementation(async () =>
          managedServiceState({ ...process.env }),
        );
        mocks.updatePlugins.mockImplementation(async () => {
          const name = process.env.OPENCLAW_PROFILE;
          events.push(`plugins:${name}`);
          expect(mocks.restartService).not.toHaveBeenCalled();
          return outcome === "sibling-convergence-failed" && name === "ops"
            ? { ...successfulPluginUpdate, status: "error" }
            : { ...successfulPluginUpdate, changed: name === "primary" };
        });
        mocks.completePluginUpdate.mockImplementation(async ({ pluginUpdate }) => {
          events.push(`doctor:${process.env.OPENCLAW_PROFILE}`);
          expect(mocks.restartService).not.toHaveBeenCalled();
          return { pluginUpdate, configSnapshot: validConfigSnapshot };
        });
        mocks.restartService.mockImplementation(async (params) => {
          const name = process.env.OPENCLAW_PROFILE;
          events.push(`${params.shouldRestart ? "start" : "preserve"}:${name}`);
          expect(complete).not.toHaveBeenCalled();
          expect(mocks.printResult).not.toHaveBeenCalled();
          const running = name !== "paused" && (name !== "primary" || outcome !== "offline-origin");
          expect(params.shouldRestart).toBe(running);
          expect(params.requireRunningServiceAfterRestart).toBe(running);
          expect(params.nodeRunner).toBe(`/nodes/${name}`);
          expect(params.serviceRuntimeRefreshRequired).toBe(false);
          if (laterRepairFailure && name === "ops") {
            params.result.steps.push({
              name: "gateway verification",
              command: "gateway verification",
              cwd: params.result.root!,
              durationMs: 1,
              exitCode: 1,
            });
            params.onVerificationFailure?.("readyz-unhealthy");
            return "restart-health-failed";
          }
          if (
            (outcome === "origin-verification-failed" || outcome === "repair-both") &&
            name === "primary"
          ) {
            params.onVerificationFailure?.("readyz-unhealthy");
            return "restart-health-failed";
          }
          recordUpdateRunVerification(
            run.runId,
            { serviceRunning: name !== "paused", pid: name === "primary" ? 101 : 202 },
            { env },
          );
          return "ok";
        });
        if (outcome === "repair-both" || laterRepairFailure) {
          const repair = await import("./update-command-repair-service.js");
          vi.spyOn(repair, "repairUpdateService").mockImplementation(
            async ({ result, env: profileEnv, nodeRunner, onVerified }) => {
              const name = profileEnv.OPENCLAW_PROFILE;
              expect(nodeRunner).toBe(`/nodes/${name}`);
              events.push(`repair:${name}`);
              if (laterRepairFailure) {
                const preserved = name === "ops";
                const receipt: (typeof result.steps)[number] = {
                  name: "gateway verification",
                  command: "gateway verification",
                  cwd: result.root!,
                  durationMs: 1,
                  exitCode: preserved ? 0 : 1,
                  ...(preserved && pendingRepair
                    ? {
                        termination: "timeout",
                        advisory: {
                          kind: "recoverable-maintenance",
                          message: "Repaired ops Gateway is still starting; leave it running.",
                        },
                      }
                    : {}),
                };
                const previous = result.steps.findIndex((step) => step.name === receipt.name);
                if (previous === -1) result.steps.push(receipt);
                else result.steps[previous] = receipt;
                if (!preserved) return result;
                if (!pendingRepair) onVerified?.(Date.now());
                return { ...result, status: "ok", reason: undefined, recovery: undefined };
              }
              recordUpdateRunVerification(
                run.runId,
                { serviceRunning: true, pid: name === "primary" ? 101 : 202 },
                { env },
              );
              return { ...result, status: "ok", reason: undefined, recovery: undefined };
            },
          );
        }
        const rollback = vi
          .spyOn(rollbackModule, "rollbackFailedUpdate")
          .mockImplementation(async ({ result, profiles: admitted }) => {
            events.push("rollback");
            expect(admitted).toBe(profiles);
            expect(admitted.map((profile) => profile.preManagedServiceStop?.stopped)).toEqual([
              true,
              true,
              false,
            ]);
            if (outcome === "repair-both") {
              return {
                result: {
                  ...result,
                  recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
                },
                rolledBack: false,
              };
            }
            return {
              result: {
                ...result,
                recovery: {
                  serviceRestartSafe: true,
                  packageRollbackVerified: true,
                  version: "2026.4.23",
                  service: "healthy",
                },
              },
              rolledBack: true,
            };
          });
        const finishing = finishSuccessfulPackageSwitch(
          { run, restartEnvironment: env },
          {
            profiles,
            packageUpdateNodeRunner: "/nodes/shared-fallback",
            serviceRuntimeRefreshRequired: true,
            ...(laterRepairFailure
              ? {
                  coreAlreadyCurrent: true,
                  result: {
                    status: "skipped",
                    reason: "already-current",
                    mode: "npm",
                    root: "/tmp/openclaw-update",
                    before: { version: "2026.4.24" },
                    after: { version: "2026.4.24" },
                    steps: [],
                    durationMs: 0,
                  },
                }
              : {
                  packageTransaction: {
                    backupRoot: "/tmp/previous-openclaw",
                    rollback: vi.fn(),
                    complete,
                  },
                }),
          },
        );
        if (laterRepairFailure) {
          await expect(finishing).rejects.toMatchObject({ result: { status: "error" } });
          expect(events).toEqual([
            "plugins:primary",
            "doctor:primary",
            "start:ops",
            "repair:ops",
            "repair:primary",
          ]);
          expect(mocks.restartService).toHaveBeenCalledOnce();
          expect(mocks.stopService).not.toHaveBeenCalled();
          expect(rollback).not.toHaveBeenCalled();
          expect(complete).not.toHaveBeenCalled();
          expect(activations).toEqual(["primary", "ops"]);
          expect(windows.get("ops")!.complete).toHaveBeenLastCalledWith(true);
          expect(windows.get("primary")!.complete).toHaveBeenLastCalledWith(false);
          expect([...enabled]).toEqual(["ops"]);
          expect(getUpdateRun(run.runId, { env })?.status).toBe("failed");
          expect(mocks.printResult).toHaveBeenCalledOnce();
          expect(mocks.printResult.mock.lastCall?.[0].steps).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: "profile 2: gateway verification",
                exitCode: 0,
                ...(pendingRepair ? { termination: "timeout" } : {}),
              }),
              expect.objectContaining({ name: "profile 1: gateway verification", exitCode: 1 }),
            ]),
          );
          return;
        }
        if (successful) {
          await finishing;
          expect(rollback).toHaveBeenCalledTimes(outcome === "repair-both" ? 1 : 0);
          expect(getUpdateRun(run.runId, { env })).toMatchObject({
            status: "succeeded",
            verification: outcome === "offline-origin" ? { serviceRunning: false } : { pid: 101 },
          });
          if (outcome === "offline-origin") {
            expect(getUpdateRun(run.runId, { env })?.verification.pid).toBeUndefined();
          }
        } else {
          await expect(finishing).rejects.toMatchObject({ result: { status: "error" } });
          expect(rollback).toHaveBeenCalledOnce();
          expect(getUpdateRun(run.runId, { env })?.status).toBe("rolled-back");
        }
        expect(events).toEqual([
          "plugins:primary",
          "doctor:primary",
          "plugins:ops",
          "doctor:ops",
          ...(outcome === "sibling-convergence-failed"
            ? []
            : [
                "plugins:paused",
                "doctor:paused",
                "start:ops",
                "preserve:paused",
                outcome === "offline-origin" ? "preserve:primary" : "start:primary",
              ]),
          ...(outcome === "healthy" || outcome === "offline-origin" ? [] : ["rollback"]),
          ...(outcome === "repair-both" ? ["repair:ops", "repair:primary"] : []),
          "package-complete",
        ]);
        expect(complete).toHaveBeenCalledOnce();
        expect(mocks.printResult).toHaveBeenCalledOnce();
        expect(mocks.printResult.mock.lastCall?.[0].postUpdate?.plugins?.changed).toBe(true);
      },
    );

    it.each([
      { outcome: "unchanged", stoppedAtMs: 500, downtimeMs: 10_700 },
      { outcome: "restarted", stoppedAtMs: 500, downtimeMs: 11_000 },
      { outcome: "rolled-back", stoppedAtMs: 500, downtimeMs: 11_500 },
      { outcome: "rolled-back", stoppedAtMs: 0, downtimeMs: 12_000 },
      { outcome: "unverified", stoppedAtMs: 500, downtimeMs: null },
    ] as const)(
      "keeps plugin convergence stopped and measures the full interval through verification ($outcome, initial stop=$stoppedAtMs)",
      async ({ outcome, stoppedAtMs, downtimeMs }) => {
        const changed = outcome !== "unchanged";
        const restartFailed = outcome === "rolled-back" || outcome === "unverified";
        const serviceEnv = {
          ...process.env,
          HOME: identity.home,
          OPENCLAW_STATE_DIR: identity.home,
        };
        const run = {
          runId: createUpdateRun({ trigger: "cli" }, { env: serviceEnv }).runId,
          env: serviceEnv,
        };
        let now = 1_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        const events: string[] = [];
        const windowsEvents: string[] = [];
        const oldRecovery = taskRecovery((phase) => {
          if (phase === "complete") {
            windowsEvents.push("old-complete");
          }
        });
        mocks.readServiceState.mockResolvedValue(
          managedServiceState(serviceEnv, { environment: serviceEnv }),
        );
        const recordVerified = () => {
          recordUpdateRunVerification(
            run.runId,
            {
              serviceRunning: true,
              versionMatch: true,
              settled: true,
              readyz: true,
              channelsReady: true,
              pluginErrors: [],
            },
            { env: serviceEnv },
          );
        };
        mocks.restartService.mockImplementation(async (params) => {
          events.push("start");
          now += events.length === 1 ? 500 : 200;
          if (restartFailed && events.length > 1) {
            recordUpdateRunVerification(run.runId, { serviceRunning: false }, { env: serviceEnv });
            return "restart-health-failed";
          }
          recordVerified();
          params.onVerified?.(now);
          return "ok";
        });
        const plugins = { ...successfulPluginUpdate, changed };
        mocks.updatePlugins.mockImplementationOnce(async () => {
          events.push("plugins");
          now = 11_000;
          return plugins;
        });
        mocks.completePluginUpdate.mockImplementationOnce(
          async (params: { beforeDoctor?: () => Promise<void> }) => {
            if (changed) {
              await params.beforeDoctor?.();
              events.push("doctor");
              expect(windowsEvents).toEqual([]);
              now += 300;
            }
            return { pluginUpdate: plugins, configSnapshot: validConfigSnapshot };
          },
        );
        vi.spyOn(rollbackModule, "rollbackFailedUpdate").mockImplementationOnce(
          async ({ result }): ReturnType<typeof rollbackModule.rollbackFailedUpdate> => {
            events.push("rollback");
            expect(getUpdateRun(run.runId, { env: serviceEnv })?.confirmedAtMs).toBeNull();
            now = 12_000;
            if (outcome === "rolled-back") {
              recordVerified();
            }
            return {
              result: {
                ...result,
                after: result.before,
                recovery:
                  outcome === "rolled-back"
                    ? {
                        serviceRestartSafe: true,
                        version: "2026.4.23",
                        packageRollbackVerified: true,
                        service: "healthy",
                      }
                    : {
                        serviceRestartSafe: false,
                        packageRollbackVerified: true,
                        reason: "runtime-verification-failed",
                      },
              },
              rolledBack: outcome === "rolled-back",
              ...(outcome === "rolled-back" ? { verifiedAtMs: now } : {}),
            };
          },
        );
        const finishing = finishSuccessfulPackageSwitch(
          {
            restartEnvironment: serviceEnv,
            sealed: true,
            stoppedAtMs,
            run,
            windowsTaskAutoStartRecovery: oldRecovery,
          },
          restartFailed
            ? {
                packageTransaction: {
                  backupRoot: "/tmp/previous-openclaw",
                  rollback: vi.fn(),
                  complete: vi.fn(async () => undefined),
                },
              }
            : {},
        );
        if (restartFailed) {
          await expect(finishing).rejects.toMatchObject({
            result: {
              status: "error",
              recovery: { serviceRestartSafe: outcome === "rolled-back" },
            },
          });
        } else {
          await finishing;
        }
        expect(events).toEqual([
          "plugins",
          ...(changed ? ["doctor"] : []),
          "start",
          ...(restartFailed ? ["rollback"] : []),
        ]);
        expect(mocks.stopService).not.toHaveBeenCalled();
        expect(oldRecovery.restore).toHaveBeenCalledWith(
          true,
          expect.any(Function),
          expect.any(Function),
        );
        expect(oldRecovery.complete).toHaveBeenLastCalledWith(outcome !== "unverified");
        expect(windowsEvents.at(-1)).toBe("old-complete");
        expect(getUpdateRun(run.runId, { env: serviceEnv })).toMatchObject({
          status:
            outcome === "rolled-back" ? "rolled-back" : restartFailed ? "failed" : "succeeded",
          downtimeMs,
        });
      },
    );

    it.each([
      ["unknown", true],
      ["inline reset", { resetInline: true }],
      ["environment-file reset", { resetFiles: true }],
    ] as const)("skips unsafe metadata refresh for %s ownership", async (_, environment) => {
      const portArguments = [...programArguments, "--port", "19305"];
      mocks.readServiceState.mockResolvedValueOnce(
        managedServiceState(
          {},
          {
            programArguments: portArguments,
            managedDefinition: { programArguments: portArguments },
            managedOverrides: { environment },
          },
        ),
      );

      await finishSuccessfulPackageSwitch();

      expect(mocks.restartService).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldRestart: true,
          refreshServiceEnv: false,
          serviceInstallEnv: null,
          serviceUpdateVerdict: expect.objectContaining({ refreshDefinition: false }),
        }),
      );
      expect(mocks.restartService.mock.lastCall?.[0].gatewayPort).toBe(19305);
    });

    it.each([
      { source: "preserved ExecStart", sealed: true, args: ["--port", "19301"], expected: 19301 },
      { source: "preserved config", sealed: true, args: [], expected: 19304 },
      { source: "writable refresh", sealed: false, args: ["--port=19301"], expected: 19303 },
    ])("verifies the CLI service port for $source", async ({ sealed, args, expected }) => {
      const serviceEnv = { HOME: identity.home };
      mocks.readServiceState.mockResolvedValue(
        managedServiceState(serviceEnv, {
          programArguments: [...programArguments, ...args],
          environment: serviceEnv,
        }),
      );
      mocks.readConfig.mockResolvedValue({
        ...validConfigSnapshot,
        config: { gateway: { port: 19303 } },
      });
      mocks.completePluginUpdate.mockResolvedValue({
        pluginUpdate: successfulPluginUpdate,
        configSnapshot: { ...validConfigSnapshot, config: { gateway: { port: 19303 } } },
      });
      mocks.createServiceConfigIO.mockReturnValue({
        readBestEffortConfig: async () => ({ gateway: { port: 19304 } }),
      });
      vi.stubEnv("OPENCLAW_GATEWAY_PORT", "");
      await finishSuccessfulPackageSwitch({
        restartEnvironment: { ...process.env },
        sealed,
      });

      const restart = mocks.restartService.mock.calls.at(-1)?.[0];
      expect({ port: restart?.gatewayPort, refresh: restart?.refreshServiceEnv }).toEqual({
        port: expected,
        refresh: !sealed,
      });
      if (!sealed) {
        expect(mocks.prepareRestartScript).toHaveBeenCalledWith(
          serviceEnv,
          expected,
          expect.any(Array),
        );
        expect(mocks.createServiceConfigIO).not.toHaveBeenCalled();
      }
    });

    it.each(["inspection", "revalidation"] as const)(
      "does not restart a stopped sealed service when fresh %s fails",
      async (failure) => {
        let now = 1_000;
        vi.spyOn(Date, "now").mockImplementation(() => now);
        mocks.writeSentinel.mockImplementationOnce(async () => {
          now += 100;
        });
        const error = new Error("inspection-secret-canary");
        mocks.readServiceState.mockResolvedValue(managedServiceState());
        if (failure === "inspection") {
          mocks.readServiceState.mockRejectedValueOnce(error);
        } else {
          mocks.revalidateService.mockRejectedValueOnce(error);
        }
        await expectUpdateFailure(
          finishSuccessfulPackageSwitch({
            restartEnvironment: { ...process.env },
            sealed: true,
            json: true,
          }),
          "service-revalidation-failed",
        );

        expect(mocks.restartService).not.toHaveBeenCalled();
        expect(mocks.prepareRestartScript).not.toHaveBeenCalled();
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          "Stopped gateway service could not be revalidated; inspect it before restarting manually.",
        );
        expect(mocks.printResult).toHaveBeenCalledOnce();
        expectFailureReport("service-revalidation-failed", expect.objectContaining({ json: true }));
        expect(mocks.writeSentinel.mock.lastCall?.[0].result).toEqual(
          mocks.printResult.mock.lastCall?.[0],
        );
      },
    );

    it.each([
      { name: "finalizes only after healthy activation", activated: true, unloaded: false },
      {
        name: "marks failed activation without finalizing success",
        activated: false,
        unloaded: false,
      },
      {
        name: "preserves the native context of an unloaded git service",
        activated: true,
        unloaded: true,
      },
    ])("canonical sealed post-update $name", async ({ activated, unloaded }) => {
      const serviceEnv = { MANAGED_VALUE: "revalidated" };
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("update-retention-fact-") };
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      mocks.readServiceState.mockResolvedValueOnce(
        managedServiceState(serviceEnv, { environment: serviceEnv }, unloaded),
      );
      mocks.restartService.mockImplementationOnce(async (params) => {
        if (!activated) {
          params.onVerificationFailure?.("readyz-unhealthy");
        }
        return activated ? "ok" : "failed";
      });
      const finishing = finishSuccessfulPackageSwitch({
        restartEnvironment: { ...process.env },
        sealed: true,
        updateMode: unloaded ? "git" : "npm",
        stoppedForUpdate: !unloaded,
        run,
      });
      if (activated) {
        await finishing;
      } else {
        await expectUpdateFailure(finishing, "readyz-unhealthy");
      }

      expect(mocks.restartService).toHaveBeenCalledOnce();
      expect(mocks.prepareRestartScript).not.toHaveBeenCalled();
      expect(mocks.restartService).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshServiceEnv: false,
          serviceEnv,
          serviceUpdateVerdict: {
            kind: "owned",
            root: "/tmp/openclaw-update",
            refreshDefinition: false,
            fingerprint: "sealed",
          },
          result: expect.objectContaining({
            after: { version: "2026.4.24", ...(unloaded ? { buildId: "new-build" } : {}) },
          }),
          requireRunningServiceAfterRestart: !unloaded,
        }),
      );
      expect(mocks.revalidateService.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.restartService.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      if (activated) {
        expect(mocks.writeSentinel).toHaveBeenCalledTimes(2);
        expect(mocks.restartService.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.writeSentinel.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
        );
      } else {
        expect(mocks.writeSentinel).toHaveBeenCalledOnce();
        expect(mocks.printResult).toHaveBeenCalledOnce();
        expectFailureReport("readyz-unhealthy");
        expect(mocks.markSentinelFailure).toHaveBeenCalledWith(
          expect.objectContaining({ reason: "readyz-unhealthy" }),
        );
        expect(getUpdateRun(run.runId, { env })).toMatchObject({
          status: "failed",
          reason: "readyz-unhealthy",
          steps: expect.arrayContaining([
            expect.objectContaining({
              step: "package rollback",
              status: "skipped",
              detail:
                "No retained previous package transaction is available; automatic package restoration was not attempted.",
            }),
          ]),
        });
      }
    });

    it("leaves native service management blocked when HOME is relocated", async () => {
      const home = tempDirs.make("openclaw-post-update-relocated-home-");
      process.env.HOME = home;
      process.env.USERPROFILE = home;

      await finishSuccessfulPackageSwitch({
        packageRoot: home,
        restartEnvironment: { ...process.env },
        stoppedForUpdate: false,
      });

      expect(mocks.readServiceState).not.toHaveBeenCalled();
      expect(mocks.revalidateService).not.toHaveBeenCalled();
      expect(mocks.restartService).toHaveBeenCalledWith(
        expect.objectContaining({
          shouldRestart: false,
          serviceMutationSkipMessage: expect.stringContaining("HOME set to the OS account home"),
        }),
      );
    });
  });
});
