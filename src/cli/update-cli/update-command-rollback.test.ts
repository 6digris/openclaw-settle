// Install service mocks before loading the rollback owner and its dependencies.
import "./update-command-rollback-runtime.test-support.js";
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { NativePackageRollbackError } from "../../infra/update-native-package-stage.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { createRollbackProfile } from "./update-command-rollback.test-support.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

const rollbackRuntime = await import("./update-command-rollback-runtime.test-support.js");
const { dirs, mocks, readPreviousConfig } = rollbackRuntime;

describe("verified package rollback", () => {
  it.each([false, true])(
    "records refused project rollback without an additional stop (during stop=%s)",
    async (duringStop) => {
      const env = { OPENCLAW_STATE_DIR: dirs.make("rollback-project-changed-") };
      const configSnapshot = await readPreviousConfig(env);
      const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
      const run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      const schemaVersions = await readUpdateStateSchemaVersions({
        stateDir: env.OPENCLAW_STATE_DIR,
        config,
        env,
      });
      const rollback = vi.fn(async () => ({
        name: "global install rollback",
        activePackageRoot: rollbackRuntime.candidateRoot,
        command: "restore",
        cwd: rollbackRuntime.candidateRoot,
        durationMs: 1,
        exitCode: 1,
        reason: "rollback-project-changed" as const,
        stderrTail: detail,
      }));
      const detail = "Global project changed since staging: sibling";
      const outcome = await rollbackFailedUpdate({
        profiles: [
          createRollbackProfile({
            schemaVersions,
            configSnapshot,
            preManagedServiceStop: {
              stopped: true,
              inspected: true,
              runtimeInspected: true,
              running: true,
              serviceEnv: env,
            },
          }),
        ],

        result: {
          status: "error",
          mode: "pnpm",
          root: rollbackRuntime.candidateRoot,
          reason: "readyz-unhealthy",
          steps: [],
          durationMs: 1,
        },
        previousRoot: rollbackRuntime.previousRoot,
        opts: { json: true, run },
        timeoutMs: 1_000,
        packageTransaction: {
          backupRoot: "/backup",
          assertRollbackSafe: async () => {
            if (!duringStop) {
              throw new NativePackageRollbackError(detail);
            }
          },
          rollback,
          complete: vi.fn(),
        },
      });
      expect(outcome.result).toMatchObject({
        status: "error",
        reason: "rollback-project-changed",
        root: rollbackRuntime.candidateRoot,
      });
      expect(rollback).toHaveBeenCalledTimes(duringStop ? 1 : 0);
      expect(mocks.stop).toHaveBeenCalledTimes(duringStop ? 1 : 0);
      expect(mocks.restart).not.toHaveBeenCalled();
      completeUpdateCommandRun(outcome.result, run);
      const row = getUpdateRun(run.runId, { env })!;
      expect(row).toMatchObject({
        status: "failed",
        reason: "rollback-project-changed",
        steps: expect.arrayContaining([
          expect.objectContaining({ step: "package rollback", status: "failed", detail }),
        ]),
      });
      const nextAction = resolveUpdateResultNextAction({
        result: outcome.result,
        env,
      });
      expect(renderUpdateRunReport(row, { nextAction }).markdown).toContain(
        "The new installation was left unchanged.",
      );
    },
  );
  it.each([
    { activated: false, healthy: true, stateChanged: false },
    { activated: false, healthy: false, stateChanged: false },
    { activated: true, healthy: true, stateChanged: false },
    { activated: true, healthy: false, stateChanged: false },
    { activated: true, healthy: false, stateChanged: true },
  ])(
    "retains Windows suspension through rollback (activated=$activated, healthy=$healthy, stateChanged=$stateChanged)",
    async ({ activated, healthy, stateChanged }) => {
      const stateDir = dirs.make("rollback-windows-owner-");
      const env = { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_WINDOWS_TASK_NAME: "rollback-fixture" };
      const configSnapshot = await readPreviousConfig(env);
      const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
      const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config, env });
      let enabled = true;
      const actions: string[] = [];
      mocks.execSchtasks.mockImplementation(async (args) => {
        if (args[0] === "/Query") {
          return {
            code: 0,
            stdout: `<Task><Settings><Enabled>${enabled}</Enabled></Settings></Task>`,
            stderr: "",
          };
        }
        const action = args[0] === "/Run" ? "/Run" : args.at(-1)!;
        actions.push(action);
        if (action === "/Run") {
          return { code: enabled ? 0 : 1, stdout: "", stderr: enabled ? "" : "task disabled" };
        }
        enabled = action === "/ENABLE";
        return { code: 0, stdout: "", stderr: "" };
      });
      const original = createWindowsTaskAutoStartRecovery({ serviceEnv: env });
      await original.suspended;
      original.beginMutation();
      if (activated) {
        await original.restore(true);
      }
      let fresh: ReturnType<typeof createWindowsTaskAutoStartRecovery> | undefined;
      const service = {
        stopped: true,
        inspected: true,
        runtimeInspected: true,
        running: false,
        serviceEnv: env,
        serviceUpdateVerdict: {
          kind: "owned" as const,
          root: rollbackRuntime.previousRoot,
          fingerprint: "fixture",
          refreshDefinition: false,
        },
      };
      mocks.stop.mockImplementationOnce(async () => {
        fresh = createWindowsTaskAutoStartRecovery({ serviceEnv: env });
        const suspended = await fresh.suspended;
        if (!suspended) {
          await fresh.complete();
        }
        if (stateChanged) {
          fs.writeFileSync(configSnapshot.path, "{}\n");
        }
        return { ...service, windowsTaskAutoStartRecovery: suspended ? fresh : undefined };
      });
      mocks.restart.mockImplementationOnce(async ({ refreshServiceEnv }) => {
        expect(refreshServiceEnv).toBe(false);
        const running = await mocks.execSchtasks(["/Run", "/TN", "rollback-fixture"]);
        if (running.code !== 0) {
          throw new Error(running.stderr);
        }
        return healthy ? "ok" : "restart-health-failed";
      });
      try {
        const profile = createRollbackProfile({
          schemaVersions,
          previousVerified: true,
          configSnapshot,
          preManagedServiceStop: { ...service, windowsTaskAutoStartRecovery: original },
        });
        const outcome = await rollbackFailedUpdate({
          profiles: [profile],
          result: {
            status: "error",
            mode: "npm",
            root: rollbackRuntime.candidateRoot,
            reason: "doctor-failed",
            before: { version: "2026.9.1" },
            after: { version: "2026.9.3" },
            steps: [],
            durationMs: 1,
          },
          previousRoot: rollbackRuntime.previousRoot,
          packageTransaction: {
            backupRoot: "/backup",
            complete: vi.fn(async () => {}),
            rollback: async () => ({
              name: "package rollback",
              activePackageRoot: rollbackRuntime.previousRoot,
              command: "restore",
              cwd: rollbackRuntime.previousRoot,
              exitCode: 0,
              durationMs: 1,
            }),
          },
          opts: { json: true },
          timeoutMs: 1_000,
        });
        expect(enabled).toBe(!stateChanged);
        expect(outcome.rolledBack).toBe(healthy);
        const retained = profile.preManagedServiceStop?.windowsTaskAutoStartRecovery;
        expect(retained).toBe(activated ? fresh : original);
        await retained?.complete(healthy);
        expect(enabled).toBe(healthy);
        if (stateChanged) {
          expect(mocks.stop).toHaveBeenCalledTimes(1);
          expect(mocks.restart).not.toHaveBeenCalled();
        } else {
          expect(actions.slice(-2)).toEqual(healthy ? ["/ENABLE", "/Run"] : ["/Run", "/DISABLE"]);
        }
      } finally {
        await fresh?.complete(false);
        await original.complete(false);
      }
    },
  );
  it("leaves the original task recovery with finalization when rollback is blocked", async () => {
    const complete = vi.fn(async () => {});
    const stopped = {
      stopped: true,
      windowsTaskAutoStartRecovery: {
        suspended: Promise.resolve(true),
        handoff: () => {},
        beginMutation: () => {},
        restore: vi.fn(async () => {}),
        complete,
        interrupted: () => false,
      },
    };
    const profile = createRollbackProfile({
      configSnapshot: await readPreviousConfig({
        OPENCLAW_STATE_DIR: dirs.make("rollback-blocked-config-"),
      }),
      preManagedServiceStop: {
        stopped: true,
        inspected: true,
        runtimeInspected: true,
        running: true,
        serviceEnv: { OPENCLAW_STATE_DIR: dirs.make("rollback-finalization-") },
        windowsTaskAutoStartRecovery: stopped.windowsTaskAutoStartRecovery,
      },
    });
    const outcome = await rollbackFailedUpdate({
      profiles: [profile],
      result: {
        status: "error",
        mode: "npm",
        reason: "readyz-unhealthy",
        root: rollbackRuntime.candidateRoot,
        steps: [],
        durationMs: 1,
      },
      previousRoot: rollbackRuntime.previousRoot,
      rollbackBlockedReason: "state-migrated-no-rollback",
      opts: { json: true },
      timeoutMs: 1_000,
    });
    expect(outcome).toMatchObject({ rolledBack: false });
    expect(profile.preManagedServiceStop?.windowsTaskAutoStartRecovery).toBe(
      stopped.windowsTaskAutoStartRecovery,
    );
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it.each([
    "source-failed",
    "restored-shims-failed",
    "partial-restore",
    "restart-unhealthy",
    "restart-refused",
    "restart-threw",
  ] as const)("retains active installation identity after %s", async (failure) => {
    const restoredPackage = failure !== "source-failed" && failure !== "partial-restore";
    const rollbackSucceeded = failure.startsWith("restart-");
    const activePackageRoot =
      failure === "partial-restore"
        ? null
        : restoredPackage
          ? rollbackRuntime.previousRoot
          : rollbackRuntime.candidateRoot;
    const stateDir = dirs.make("rollback-source-failed-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const configSnapshot = await readPreviousConfig(env);
    const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
    const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config, env });
    const result: UpdateRunResult = {
      status: "error",
      mode: "npm",
      root: rollbackRuntime.candidateRoot,
      reason: "readyz-unhealthy",
      steps: [],
      durationMs: 1,
      before: { version: "2026.9.1" },
      after: { version: "2026.9.3" },
    };
    if (failure === "restart-threw") {
      mocks.restart.mockRejectedValueOnce(new Error("Service restart transport failed"));
    } else {
      mocks.restart.mockResolvedValueOnce(
        failure === "restart-unhealthy" ? "restart-health-failed" : "failed",
      );
    }
    const outcome = await rollbackFailedUpdate({
      profiles: [
        createRollbackProfile({
          configSnapshot,
          schemaVersions,
          previousVerified: true,
          preManagedServiceStop: {
            stopped: true,
            inspected: true,
            runtimeInspected: true,
            running: true,
            serviceEnv: env,
          },
        }),
      ],

      result,
      previousRoot: rollbackRuntime.previousRoot,
      opts: { json: true },
      timeoutMs: 1_000,
      packageTransaction: {
        backupRoot: "/backup",
        complete: vi.fn(async () => {}),
        rollback: vi.fn(async () => ({
          name: "rollback",
          activePackageRoot,
          command: "restore",
          cwd: rollbackRuntime.previousRoot,
          exitCode: rollbackSucceeded ? 0 : 1,
          durationMs: 1,
        })),
      },
    });
    expect(outcome.result).toMatchObject({
      root: activePackageRoot ?? undefined,
      after:
        activePackageRoot === null ? undefined : restoredPackage ? result.before : result.after,
      reason: rollbackSucceeded ? result.reason : "source-rollback-failed",
      steps: [
        expect.objectContaining({
          name: "rollback",
          exitCode: rollbackSucceeded ? 0 : 1,
        }),
      ],
      ...(!rollbackSucceeded
        ? {}
        : {
            recovery: { serviceRestartSafe: true, packageRollbackVerified: true },
          }),
    });
    expect(outcome.rolledBack).toBe(false);
    expect(mocks.restart).toHaveBeenCalledTimes(rollbackSucceeded ? 1 : 0);
  });
});
