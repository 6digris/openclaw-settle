// Install the fixture mocks before loading finalization and its dependencies.
import "./update-command-post-update-mocks.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRestartSentinel } from "../../infra/restart-sentinel.js";
import * as updateHandoff from "../../infra/update-managed-service-handoff.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import * as gitRecovery from "../../infra/update-runner-git-recovery.js";
import * as restartHealth from "../daemon-cli/restart-health.js";
import { UpdatePreMutationError } from "./shared.js";
import { finishUpdate } from "./update-command-post-update.js";
import {
  createManagedServiceIdentityFixture,
  finishSuccessfulPackageSwitch,
  managedServiceState,
  successfulPluginUpdate,
  taskRecovery,
  validConfigSnapshot,
} from "./update-command-post-update.test-support.js";
import * as repairService from "./update-command-repair-service.js";
import * as rollbackModule from "./update-command-rollback.js";
import * as sourceRuntime from "./update-command-runtime.js";
import * as servicePlan from "./update-command-service-plan.js";
import { recordFailedUpdateGatewayState } from "./update-command-service.js";
import { recordUpdateGatewayHealth } from "./update-command-verification.js";

const { mocks, tempDirs } = await import("./update-command-post-update-mocks.test-support.js");

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];

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

    it.each([1, 2])(
      "retains inspection diagnostics in the origin report for %i profiles",
      async (count) => {
        const message = servicePlan.GATEWAY_SERVICE_INSPECTION_WARNING;
        const profiles: FinishUpdateParams["profiles"] = Array.from(
          { length: count },
          (_, index) => ({
            configSnapshot: {
              ...validConfigSnapshot,
              path: path.join(identity.home, `profile-${index}.json`),
            },
            requestedChannel: null,
            storedChannel: null,
            preUpdatePluginInstallRecords: {},
            preManagedServiceStop: {
              stopped: false,
              inspected: false,
              runtimeInspected: false,
              running: false,
              serviceMutationAllowed: false,
              serviceMutationSkipMessage: message,
              serviceUpdateVerdict: {
                kind: "unavailable",
                message,
                inspectionReason: "service-manager-unavailable",
              },
            },
          }),
        );
        await finishSuccessfulPackageSwitch({ json: true }, { profiles, shouldRestart: false });
        const result = mocks.printResult.mock.calls.at(-1)?.[0];
        expect(result).toMatchObject({ status: "ok" });
        const warnings = result.steps.filter((step: { name: string }) =>
          step.name.endsWith("managed-service"),
        );
        expect(warnings.map((step: { name: string }) => step.name)).toEqual(
          count === 1
            ? ["managed-service"]
            : ["profile 1: managed-service", "profile 2: managed-service"],
        );
        for (const warning of warnings) {
          expect(warning).toMatchObject({
            exitCode: 0,
            advisory: { kind: "recoverable-maintenance", message },
            failureFacts: [{ check: "managed-service", code: "service-manager-unavailable" }],
          });
        }
        expect(mocks.writeSentinel.mock.calls.at(-1)?.[0].result.steps).toEqual(result.steps);
        expect(mocks.stopService).not.toHaveBeenCalled();
        for (const [params] of mocks.restartService.mock.calls) {
          expect(params.shouldRestart).toBe(false);
        }
      },
    );

    it("keeps origin-native credentials out of sibling installs during migrated finalization", async () => {
      const commonEnv: NodeJS.ProcessEnv = {
        ...process.env,
        UPDATE_TEST_COMMON_AUTH: "fresh-common-ref",
      };
      delete commonEnv.UPDATE_TEST_ORIGIN_AUTH;
      vi.stubEnv("UPDATE_TEST_ORIGIN_AUTH", "native-origin-ref");
      const nativeEnvs = new Map<string, Record<string, string>>();
      const profiles: FinishUpdateParams["profiles"] = ["primary", "ops"].map((name) => {
        const native: Record<string, string> = {
          HOME: identity.home,
          USERPROFILE: identity.home,
          PATH: `/native/${name}`,
          OPENCLAW_PROFILE: name,
          OPENCLAW_STATE_DIR: path.join(identity.home, `.openclaw-${name}`),
          OPENCLAW_CONFIG_PATH: path.join(identity.home, `.openclaw-${name}`, "openclaw.json"),
        };
        if (name === "primary") {
          native.UPDATE_TEST_ORIGIN_AUTH = "native-origin-ref";
        }
        nativeEnvs.set(name, native);
        const env = { ...commonEnv, ...native, UPDATE_TEST_COMMON_AUTH: "stale-common-ref" };
        return {
          configSnapshot: validConfigSnapshot,
          requestedChannel: null,
          storedChannel: null,
          preUpdatePluginInstallRecords: {},
          ownedManagedUpdateEnv: env,
          preManagedServiceStop: {
            inspected: true,
            runtimeInspected: true,
            running: true,
            stopped: true,
            serviceEnv: env,
            serviceDefinitionEnv: native,
            serviceUpdateVerdict: {
              kind: "owned",
              root: "/tmp/openclaw-update",
              fingerprint: name,
              refreshDefinition: true,
            },
          },
        };
      });
      mocks.readServiceState.mockImplementation(async () => {
        const environment = nativeEnvs.get(process.env.OPENCLAW_PROFILE!);
        const state = managedServiceState({ ...process.env }, { environment });
        state.command.managedDefinition = { ...state.command };
        return state;
      });
      const installs = new Map<string, NodeJS.ProcessEnv | null | undefined>();
      mocks.restartService.mockImplementation(async (params) => {
        expect(params.refreshServiceEnv).toBe(true);
        installs.set(process.env.OPENCLAW_PROFILE!, params.serviceInstallEnv);
        return "ok";
      });
      await finishUpdate(
        {
          mutationStarted: true,
          result: {
            status: "ok",
            mode: "npm",
            root: "/tmp/openclaw-update",
            steps: [],
            durationMs: 1,
          },
          root: "/tmp/openclaw-update",
          installKindChanged: false,
          channel: "stable",
          downgradeRisk: false,
          shouldRestart: true,
          opts: { json: true },
          profiles,
          controlPlaneUpdateSentinelMeta: null,
          startedAt: Date.now(),
          updateStepTimeoutMs: 1000,
        },
        commonEnv,
      );
      expect([...installs.keys()]).toEqual(["ops", "primary"]);
      for (const [name, installedEnv] of installs) {
        expect(installedEnv).toMatchObject({
          ...nativeEnvs.get(name),
          UPDATE_TEST_COMMON_AUTH: "fresh-common-ref",
        });
      }
      expect(installs.get("ops")).not.toHaveProperty("UPDATE_TEST_ORIGIN_AUTH");
      expect(process.env.UPDATE_TEST_ORIGIN_AUTH).toBe("native-origin-ref");
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
        const service = await import("./update-command-service-recovery.js");
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
          if (stale) {
            expect(restart.opts.run).toBe(runOptions);
          }
          events.push(`restart:${name}`);
          if (commandFailed) {
            await recordFailedUpdateGatewayState(
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
      "state-only-caller",
      "state-only-caller-repair",
    ] as const)(
      "finalizes one shared package only after every profile settles (%s)",
      async (outcome) => {
        const laterRepairFailure = outcome.endsWith("then-failed");
        const pendingRepair = outcome === "repair-pending-then-failed";
        const stateOnly = outcome.startsWith("state-only-caller");
        const stateOnlyRepair = outcome === "state-only-caller-repair";
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
                    if (!enabled.has(name)) {
                      activations.push(name);
                    }
                    enabled.add(name);
                  }),
                  complete: vi.fn(async (safe = true) => {
                    if (!safe) {
                      enabled.delete(name);
                    }
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
            preManagedServiceStop:
              stateOnly && name === "primary"
                ? undefined
                : {
                    inspected: true,
                    runtimeInspected: true,
                    running,
                    stopped: running,
                    serviceEnv: env,
                    windowsTaskAutoStartRecovery: laterRepairFailure
                      ? windows.get(name)
                      : undefined,
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
        const callerVerification = { noticeDelivered: true };
        if (stateOnly) {
          recordUpdateRunVerification(run.runId, callerVerification, { env });
        }
        const siblingHealth = {
          runtime: { status: "running" as const, pid: 202 },
          healthy: true,
          staleGatewayPids: [],
          portUsage: { port: 19102, status: "busy" as const, listeners: [{ pid: 202 }], hints: [] },
        };
        const events: string[] = [];
        const nativeReads: string[] = [];
        const complete = vi.fn(async () => {
          events.push("package-complete");
        });
        mocks.readServiceState.mockImplementation(async () => {
          nativeReads.push(process.env.OPENCLAW_PROFILE!);
          return managedServiceState({
            ...(stateOnly ? profiles[1]!.ownedManagedUpdateEnv : process.env),
          });
        });
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
          if (stateOnly) {
            if (stateOnlyRepair && name === "ops") {
              params.onVerificationFailure?.("readyz-unhealthy");
              return "restart-health-failed";
            }
            if (params.shouldRestart) {
              recordUpdateGatewayHealth(
                params.recordGatewayVerification === false ? undefined : params.opts.run,
                siblingHealth,
                19102,
                true,
              );
              params.onVerified?.(Date.now());
            }
            return "ok";
          }
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
        if (outcome === "repair-both" || laterRepairFailure || stateOnlyRepair) {
          const repair = await import("./update-command-repair-service.js");
          vi.spyOn(repair, "repairUpdateService").mockImplementation(
            async ({
              result,
              env: profileEnv,
              nodeRunner,
              onVerified,
              opts,
              recordGatewayVerification,
              expectedService,
            }) => {
              const name = profileEnv.OPENCLAW_PROFILE;
              expect(nodeRunner).toBe(`/nodes/${name}`);
              events.push(`repair:${name}`);
              if (stateOnlyRepair) {
                recordUpdateGatewayHealth(
                  recordGatewayVerification === false ? undefined : opts.run,
                  siblingHealth,
                  19102,
                  true,
                );
                if (name === "ops") {
                  expect(expectedService).toBe(profiles[1]!.preManagedServiceStop);
                }
                onVerified?.(Date.now());
                return { ...result, status: "ok", reason: undefined, recovery: undefined };
              }
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
                if (previous === -1) {
                  result.steps.push(receipt);
                } else {
                  result.steps[previous] = receipt;
                }
                if (!preserved) {
                  return result;
                }
                if (!pendingRepair) {
                  onVerified?.(Date.now());
                }
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
            ...(stateOnly ? { packageTransaction: undefined } : {}),
          },
        );
        if (stateOnly) {
          await finishing;
          expect(nativeReads).toEqual(["ops"]);
          expect(events.filter((event) => event.startsWith("start:"))).toEqual(["start:ops"]);
          expect(events.filter((event) => event.startsWith("repair:"))).toEqual(
            stateOnlyRepair ? ["repair:ops"] : [],
          );
          expect(mocks.stopService).not.toHaveBeenCalled();
          expect(rollback).not.toHaveBeenCalled();
          expect(complete).not.toHaveBeenCalled();
          expect(profiles[0]!.preManagedServiceStop).toBeUndefined();
          const recorded = getUpdateRun(run.runId, { env });
          expect(recorded?.status).toBe("succeeded");
          expect(recorded?.verification).toEqual(callerVerification);
          expect(mocks.printResult).toHaveBeenCalledOnce();
          return;
        }
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
  });
});
