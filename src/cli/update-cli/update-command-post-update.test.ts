// Install the fixture mocks before loading finalization and its dependencies.
import "./update-command-post-update-mocks.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as updateCheck from "../../infra/update-check.js";
import * as updateHandoff from "../../infra/update-managed-service-handoff.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as postCoreModule from "./update-command-post-core.js";
import type { finishUpdate } from "./update-command-post-update.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  managedServiceState,
  programArguments,
  successfulPluginUpdate,
  taskRecovery,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import * as rollbackModule from "./update-command-rollback.js";
import * as sourceRuntime from "./update-command-runtime.js";
import { UpdateServiceLoadBoundaryError } from "./update-command-service-load.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service-plan.js";

const { expectFailureReport, expectUpdateFailure, mocks, tempDirs } =
  await import("./update-command-post-update-mocks.test-support.js");

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];

describe("successful update finalization ordering", () => {
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
            if (published) {
              await beforePublication?.();
            }
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
});
