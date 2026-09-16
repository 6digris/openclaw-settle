import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { applyCliProfileEnv } from "../profile.js";
import type {
  LegacyMigratedUpdateFinalizationInput,
  MigratedUpdateFinalizationInput,
} from "./update-command-migrated-types.js";
import { continueMigratedUpdateInFreshProcess } from "./update-command-migrated.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const mocks = vi.hoisted(() => ({
  service: vi.fn<() => GatewayService>(),
  enabled: new Map<string, boolean>(),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));
vi.mock("../../daemon/schtasks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/schtasks.js")>()),
  suspendScheduledTaskAutoStartForUpdate: vi.fn<
    typeof import("../../daemon/schtasks.js").suspendScheduledTaskAutoStartForUpdate
  >(async (env, options) => {
    const serviceEnv = env === undefined ? process.env : env;
    const profile = serviceEnv.OPENCLAW_PROFILE ?? "default";
    const enabled = mocks.enabled.get(profile) ?? true;
    if (enabled) {
      await options?.beforeMutation?.();
    }
    mocks.enabled.set(profile, false);
    return enabled;
  }),
  resumeScheduledTaskAutoStartAfterUpdate: vi.fn<
    typeof import("../../daemon/schtasks.js").resumeScheduledTaskAutoStartAfterUpdate
  >(async (env, options) => {
    const serviceEnv = env === undefined ? process.env : env;
    await options?.beforeMutation?.();
    mocks.enabled.set(serviceEnv.OPENCLAW_PROFILE ?? "default", true);
    return true;
  }),
}));
vi.mock("../../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/exec.js")>()),
  runUtf8CommandWithTimeout: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  mockSystemAccountHome();
  mocks.enabled.clear();
});
afterEach(() => vi.restoreAllMocks());

const outcomes = [
  "launch failure",
  "failed terminal result",
  "replaced task",
  "changed protected task",
] as const;
it.each(outcomes.flatMap((outcome) => [false, true].map((grouped) => ({ outcome, grouped }))))(
  "keeps Windows autostart suspended across migrated finalizer $outcome (grouped=$grouped)",
  async ({ outcome, grouped }) => {
    const home = await fs.realpath(dirs.make("migrated-windows-"));
    await withEnvAsync(
      {
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData"),
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: undefined,
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_PROFILE: undefined,
        OPENCLAW_SUPERVISOR_MODE: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
      },
      async () => {
        mockProcessPlatform("win32");
        const root = process.cwd();
        const profileNames = grouped ? ["default", "ops"] : ["default"];
        const programArguments = new Map(
          profileNames.map((name) => [
            name,
            [process.execPath, path.join(root, "openclaw.mjs"), "gateway"],
          ]),
        );
        const signalListenersBefore = process.listenerCount("SIGTERM");
        mocks.service.mockReturnValue(
          createMockGatewayService({
            readCommand: async (env) => ({
              programArguments: programArguments.get(env.OPENCLAW_PROFILE ?? "default")!,
              environment: {
                HOME: home,
                ...(env.OPENCLAW_PROFILE ? { OPENCLAW_PROFILE: env.OPENCLAW_PROFILE } : {}),
              },
            }),
            readRuntime: async () => ({ status: "running" }),
            isLoaded: async () => true,
          }),
        );
        const stoppedProfiles = [];
        for (const name of profileNames) {
          const stopped = await withEnvAsync(
            {
              OPENCLAW_PROFILE: undefined,
              OPENCLAW_STATE_DIR: undefined,
              OPENCLAW_CONFIG_PATH: undefined,
            },
            () => {
              applyCliProfileEnv({ profile: name });
              return maybeStopManagedServiceBeforeMutableUpdate({
                root,
                updateInstallKind: "package",
                shouldRestart: true,
                jsonMode: true,
              });
            },
          );
          expect(stopped.windowsTaskAutoStartRecovery).toBeDefined();
          if (
            outcome === "changed protected task" &&
            stopped.serviceUpdateVerdict?.kind === "owned"
          ) {
            stopped.serviceUpdateVerdict.refreshDefinition = false;
          }
          stopped.windowsTaskAutoStartRecovery?.beginMutation();
          stoppedProfiles.push(stopped);
        }
        const activationTimeoutMs = 3_600_000;
        let enabledAtWorkerStart: boolean[] | undefined;
        const completed = {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
          cleanup: "normal",
        } as const;
        vi.mocked(runUtf8CommandWithTimeout).mockImplementation(async (argv, options) => {
          if (argv.at(-1) === "--check") {
            return { ...completed, stdout: JSON.stringify({ profileContexts: true }) };
          }
          assert(typeof options === "object");
          expect(options.timeoutMs).toBe(activationTimeoutMs);
          const input = JSON.parse(String(options.input)) as
            | MigratedUpdateFinalizationInput
            | LegacyMigratedUpdateFinalizationInput; // SAFETY: The real typed parent serializes this private worker input.
          expect(input.params.opts.run?.activationTimeoutMs).toBe(activationTimeoutMs);
          const contexts =
            "profiles" in input.params
              ? input.params.profiles
              : [
                  {
                    ...input.params,
                    windowsTaskAutoStartSuspended:
                      "windowsTaskAutoStartSuspended" in input
                        ? input.windowsTaskAutoStartSuspended
                        : undefined,
                  },
                ];
          expect(contexts).toHaveLength(profileNames.length);
          for (const context of contexts) {
            expect(context.windowsTaskAutoStartSuspended).toBe(true);
            expect(context.preManagedServiceStop).not.toHaveProperty(
              "windowsTaskAutoStartRecovery",
            );
          }
          enabledAtWorkerStart = profileNames.map((name) => mocks.enabled.get(name)!);
          if (outcome === "launch failure") {
            throw new Error("candidate finalizer unavailable");
          }
          if (outcome === "replaced task" || outcome === "changed protected task") {
            mocks.enabled.set("default", true);
            programArguments.set(
              "default",
              outcome === "replaced task"
                ? [process.execPath, path.join(home, "other-install", "openclaw.mjs"), "gateway"]
                : [...programArguments.get("default")!, "--port", "20000"],
            );
            throw new Error("candidate finalizer disappeared");
          }
          await fs.writeFile(
            input.resultPath,
            JSON.stringify({
              result: {
                ...input.params.result,
                status: "error",
                reason: "plugin-convergence-failed",
              },
              terminalRunId: "migrated-windows-run",
              exitCode: 1,
            }),
          );
          return completed;
        });
        const runId = "migrated-windows-run";
        const operation = continueMigratedUpdateInFreshProcess(
          {
            mutationStarted: true,
            root,
            result: { status: "ok", mode: "npm", root, runId, steps: [], durationMs: 0 },
            installKindChanged: false,
            profiles: stoppedProfiles.map((stopped, index) => ({
              configSnapshot: {
                path: path.join(home, `${profileNames[index]}.json`),
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
              preManagedServiceStop: stopped,
              preUpdatePluginInstallRecords: {},
            })),
            channel: "stable",
            downgradeRisk: false,
            shouldRestart: true,
            opts: { json: true, run: { runId, env: { ...process.env }, activationTimeoutMs } },
            controlPlaneUpdateSentinelMeta: null,
            startedAt: Date.now(),
            packageUpdateNodeRunner: process.execPath,
            updateStepTimeoutMs: 1_000,
            rollbackBlockedReason: "state-migrated-no-rollback",
          },
          [],
        );
        try {
          if (outcome === "launch failure") {
            await expect(operation).rejects.toThrow("candidate finalizer unavailable");
          } else if (outcome === "replaced task" || outcome === "changed protected task") {
            await expect(operation).rejects.toThrow(/ownership or manager identity changed/);
          } else {
            await expect(operation).resolves.toMatchObject({ exitCode: 1 });
          }
          expect(enabledAtWorkerStart).toEqual(profileNames.map(() => false));
          const replaced = outcome === "replaced task" || outcome === "changed protected task";
          expect(profileNames.map((name) => mocks.enabled.get(name))).toEqual(
            profileNames.map((_, index) => index === 0 && replaced),
          );
          expect(process.listenerCount("SIGTERM")).toBe(signalListenersBefore);
          for (const stopped of stoppedProfiles) {
            await stopped.windowsTaskAutoStartRecovery?.restore();
          }
          expect(profileNames.map((name) => mocks.enabled.get(name))).toEqual(
            profileNames.map((_, index) => index === 0 && replaced),
          );
        } finally {
          for (const stopped of stoppedProfiles) {
            await stopped.windowsTaskAutoStartRecovery?.complete(false);
          }
        }
      },
    );
  },
);
