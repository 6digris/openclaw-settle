// Install the fixture mocks before loading finalization and its dependencies.
import "./update-command-post-update-mocks.test-support.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
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

const { expectFailureReport, expectUpdateFailure, mocks, tempDirs } =
  await import("./update-command-post-update-mocks.test-support.js");

describe("successful update finalization ordering", () => {
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
