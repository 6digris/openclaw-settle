import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createConfigIO } from "../../config/config.js";
import { hashConfigRaw } from "../../config/io.read-helpers.js";
import type { OpenClawConfig } from "../../config/types.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE, withFileLock } from "../../infra/file-lock.js";
import * as replaceFile from "../../infra/replace-file.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import {
  captureUpdateDoctorConfigWrites,
  writeUpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { NativePackageRollbackError } from "../../infra/update-native-package-stage.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateProfileContext } from "./update-command-finish-types.js";
import type { PreManagedServiceStop } from "./update-command-service.js";
import { recordUpdateGatewayHealth } from "./update-command-verification.js";
import { createWindowsTaskAutoStartRecovery } from "./update-command-windows-task.js";

const mocks = vi.hoisted(() => ({
  stop: vi.fn(),
  restart: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(),
  serviceState: vi.fn<typeof import("../../daemon/service.js").readGatewayServiceState>(),
  revalidateService:
    vi.fn<
      typeof import("./update-command-service-maintenance.js").revalidateManagedGatewayServiceAfterUpdate
    >(),
  execSchtasks: vi.fn<typeof import("../../daemon/schtasks-exec.js").execSchtasks>(),
}));
vi.mock("../../daemon/schtasks-exec.js", () => ({ execSchtasks: mocks.execSchtasks }));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: mocks.serviceState,
}));
vi.mock("./update-command-service-maintenance.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-maintenance.js")>()),
  createWindowsTaskAutoStartGuard: () => async () => {},
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidateService,
}));
vi.mock("./update-command-service-command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-command.js")>()),
  runUpdatedInstallGatewayCommand: async () => "accepted",
}));
vi.mock("./update-command-service.js", () => ({
  maybeStopManagedServiceBeforeMutableUpdate: mocks.stop,
  maybeRestartService: mocks.restart,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate: async (
    stopped: PreManagedServiceStop | undefined,
    safe: boolean,
    guard?: () => Promise<void>,
  ) => stopped?.windowsTaskAutoStartRecovery?.restore(safe, guard),
  resolveUpdatedGatewayRestartPort: async () => 19101,
}));
import * as updateShared from "./shared.js";
import { inspectActivatedUpdateState } from "./update-command-migrated.js";
import * as packageModule from "./update-command-package.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import {
  createRollbackProfile,
  expectDoctorRollback,
  writeWithRefreshFailure,
} from "./update-command-rollback.test-support.js";
import { completeUpdateCommandRun } from "./update-command-run.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let candidateRoot: string;
let previousRoot: string;
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function readPreviousConfig(env: NodeJS.ProcessEnv) {
  return createConfigIO({ env, pluginValidation: "skip" }).readConfigFileSnapshot();
}
function setVersion(file: string, version: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
}

describe("verified package rollback", () => {
  beforeEach(() => {
    previousRoot = fs.realpathSync(dirs.make("rollback-previous-runtime-"));
    candidateRoot = fs.realpathSync(dirs.make("rollback-candidate-runtime-"));
    for (const [root, version] of [
      [previousRoot, "2026.9.1"],
      [candidateRoot, "2026.9.3"],
    ] as const) {
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ type: "module", version }),
      );
    }
    const worker = "dist/infra/update-candidate-state.worker.js";
    fs.mkdirSync(path.dirname(path.join(candidateRoot, worker)), { recursive: true });
    fs.writeFileSync(
      path.join(candidateRoot, worker),
      `import ${JSON.stringify(pathToFileURL(path.resolve(worker)).href)};\n`,
    );
    vi.resetAllMocks();
    mocks.serviceState.mockResolvedValue({
      installed: true,
      loadState: { status: "loaded" },
      running: false,
      env: {},
      command: {
        programArguments: [
          process.execPath,
          path.join(previousRoot, "dist", "index.js"),
          "gateway",
        ],
      },
    });
    mocks.revalidateService.mockResolvedValue({
      kind: "owned",
      root: previousRoot,
      fingerprint: "fixture",
      refreshDefinition: true,
    });
    mocks.stop.mockResolvedValue({
      stopped: true,
      stoppedAtMs: 100,
      serviceUpdateVerdict: {
        kind: "owned",
        root: candidateRoot,
        fingerprint: "fixture",
        refreshDefinition: true,
      },
    });
    mocks.restart.mockImplementation(async ({ onVerified }) => {
      onVerified?.(125);
      return "ok";
    });
  });

  async function sharedProfiles() {
    const profiles: UpdateProfileContext[] = [];
    for (const name of ["primary", "secondary", "offline"]) {
      const env = { OPENCLAW_STATE_DIR: dirs.make(`rollback-${name}-`), OPENCLAW_PROFILE: name };
      const configPath = path.join(env.OPENCLAW_STATE_DIR, "openclaw.json");
      fs.writeFileSync(configPath, '{"logging":{"$include":"./logging.json"}}\n');
      fs.writeFileSync(path.join(env.OPENCLAW_STATE_DIR, "logging.json"), '{"level":"info"}\n');
      const configSnapshot = await readPreviousConfig(env);
      const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
      setVersion(path.join(env.OPENCLAW_STATE_DIR, "agents/main/agent/openclaw-agent.sqlite"), 3);
      profiles.push(
        createRollbackProfile({
          configSnapshot,
          previousVerified: true,
          schemaVersions: await readUpdateStateSchemaVersions({
            stateDir: env.OPENCLAW_STATE_DIR,
            config,
            env,
          }),
          preManagedServiceStop: {
            inspected: true,
            runtimeInspected: true,
            running: name !== "offline",
            stopped: name !== "offline",
            serviceEnv: env,
            serviceNodeRunner: `/${name}/node`,
            serviceManagerUid: name === "primary" ? 3001 : 3002,
            serviceUpdateVerdict: {
              kind: "owned",
              root: previousRoot,
              fingerprint: name,
              refreshDefinition: false,
            },
          },
        }),
      );
    }
    const result: UpdateRunResult = {
      status: "error",
      mode: "npm",
      root: candidateRoot,
      reason: "readyz-unhealthy",
      before: { version: "2026.9.1" },
      after: { version: "2026.9.3" },
      steps: [],
      durationMs: 1,
    };
    const rollback = vi.fn(async () => ({
      name: "package rollback",
      activePackageRoot: previousRoot,
      command: "restore",
      cwd: previousRoot,
      exitCode: 0,
      durationMs: 1,
    }));
    const params = {
      profiles,
      result,
      previousRoot,
      opts: { json: true },
      timeoutMs: 1000,
      packageTransaction: { backupRoot: previousRoot, complete: vi.fn(), rollback },
    };
    return { profiles, params, rollback };
  }

  it.each([
    "none",
    "origin-not-restarted",
    "unverified",
    "restart throws",
    "stop throws",
    "readiness pending",
  ] as const)(
    "restores shared package once and recovers every eligible profile (%s)",
    async (failure) => {
      const { profiles, params, rollback } = await sharedProfiles();
      const originNotRestarted = failure === "origin-not-restarted";
      const healthy = failure === "none" || originNotRestarted;
      const originVerification = {
        serviceRunning: true,
        pid: 101,
        port: 19101,
        runningVersion: "2026.9.1",
        runningBuildId: "previous-build",
        versionMatch: true,
        settled: true,
        readyz: true,
        channelsReady: true,
        pluginErrors: [],
      };
      const opts: Parameters<typeof rollbackFailedUpdate>[0]["opts"] = params.opts;
      if (originNotRestarted) {
        profiles[0]!.preManagedServiceStop!.stopped = false;
        const env = profiles[0]!.preManagedServiceStop!.serviceEnv!;
        opts.run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
        recordUpdateRunVerification(opts.run.runId, originVerification, { env });
        profiles[0]!.schemaVersions = await readUpdateStateSchemaVersions({
          stateDir: env.OPENCLAW_STATE_DIR!,
          config: profiles[0]!.configSnapshot.sourceConfig,
          env,
        });
      }
      const events: string[] = [];
      const originalStops = profiles.map((profile) => profile.preManagedServiceStop!);
      if (failure === "unverified") profiles[1]!.previousVerified = false;
      mocks.stop.mockImplementation(async ({ expectedService, onStopped }) => {
        const name = expectedService.serviceEnv.OPENCLAW_PROFILE;
        events.push(`stop ${name}`);
        const stopped = {
          ...expectedService,
          stopped: true,
          stoppedAtMs: 100,
          serviceNodeRunner: "/candidate/node",
        };
        onStopped?.(stopped);
        if (name === "secondary" && failure === "stop throws")
          throw new Error("native inspection failed after stop");
        return stopped;
      });
      rollback.mockImplementation(async () => {
        events.push("restore package");
        return {
          name: "package rollback",
          activePackageRoot: previousRoot,
          command: "restore",
          cwd: previousRoot,
          exitCode: 0,
          durationMs: 1,
        };
      });
      mocks.restart.mockImplementation(async (restart) => {
        const { result, serviceEnv, nodeRunner, serviceManagerUid, onVerified } = restart;
        if (originNotRestarted) expect(restart.opts).toBe(opts);
        const name = serviceEnv?.OPENCLAW_PROFILE;
        events.push(`restart ${name}`);
        expect(process.env.OPENCLAW_PROFILE).toBe(name);
        expect(nodeRunner).toBe(`/${name}/node`);
        expect(serviceManagerUid).toBe(name === "primary" ? 3001 : 3002);
        if (name === "secondary" && failure === "restart throws")
          throw new Error("secondary native restart failed");
        if (originNotRestarted) {
          recordUpdateGatewayHealth(
            restart.recordGatewayVerification === false ? undefined : restart.opts.run,
            {
              runtime: { status: "running", pid: 202 },
              healthy: true,
              gatewayVersion: "2026.9.1",
              gatewayBuildId: "previous-build",
              expectedVersion: "2026.9.1",
              staleGatewayPids: [],
              portUsage: { port: 19102, status: "busy", listeners: [{ pid: 202 }], hints: [] },
            },
            19102,
            true,
          );
        }
        if (failure === "readiness pending" || originNotRestarted) {
          const pending = failure === "readiness pending" && name === "secondary";
          const receipt: UpdateRunResult["steps"][number] = {
            name: "rollback gateway verification",
            command: "verify restored gateway",
            cwd: previousRoot,
            durationMs: 100,
            exitCode: 0,
            ...(pending
              ? {
                  termination: "timeout",
                  advisory: {
                    kind: "recoverable-maintenance",
                    message: "Gateway is still starting.",
                  },
                }
              : {}),
          };
          const index = result.steps.findIndex((step) => step.name === receipt.name);
          if (index === -1) result.steps.push(receipt);
          else result.steps[index] = receipt;
          if (pending) return "readiness-pending";
        }
        onVerified?.(name === "primary" ? 140 : 120);
        return "ok";
      });
      const outcome = await rollbackFailedUpdate(params);
      expect(profiles[0]!.preManagedServiceStop).toMatchObject(
        originNotRestarted ? { stopped: false } : { stopped: true, stoppedAtMs: 100 },
      );
      expect(profiles[1]!.preManagedServiceStop).toMatchObject({ stopped: true, stoppedAtMs: 100 });
      expect(profiles[2]!.preManagedServiceStop).toBe(originalStops[2]);
      expect(outcome.rolledBack).toBe(healthy);
      expect(outcome.verifiedAtMs).toBe(healthy ? (originNotRestarted ? 120 : 140) : undefined);
      expect(rollback).toHaveBeenCalledTimes(failure === "stop throws" ? 0 : 1);
      expect(events).toEqual(
        failure === "stop throws"
          ? ["stop primary", "stop secondary"]
          : [
              ...(originNotRestarted ? [] : ["stop primary"]),
              "stop secondary",
              "restore package",
              ...(failure === "unverified" ? [] : ["restart secondary"]),
              ...(originNotRestarted ? [] : ["restart primary"]),
            ],
      );
      const recovery = outcome.result.recovery;
      expect(recovery?.serviceRestartSafe ? recovery.service : undefined).toBe(
        healthy ? "healthy" : undefined,
      );
      if (originNotRestarted) {
        expect(getUpdateRun(opts.run!.runId, { env: opts.run!.env })?.verification).toEqual(
          originVerification,
        );
        expect(outcome.result.steps).toContainEqual(
          expect.objectContaining({
            name: "profile 2: rollback gateway verification",
            exitCode: 0,
          }),
        );
      }
      if (failure === "unverified")
        expect(outcome.result.reason).toBe("previous-version-unverified");
      if (failure === "readiness pending") {
        expect(outcome.result).toMatchObject({ status: "error", reason: "readyz-unhealthy" });
        expect(outcome.result.steps).toContainEqual(
          expect.objectContaining({
            name: "profile 2: rollback gateway verification",
            termination: "timeout",
            advisory: { kind: "recoverable-maintenance", message: "Gateway is still starting." },
          }),
        );
        expect(
          outcome.result.steps.find((step) => step.name === "rollback gateway verification"),
        ).not.toHaveProperty("termination");
      }
    },
  );

  it.each([
    { change: "schema", duringStop: false },
    { change: "schema", duringStop: true },
    { change: "config", duringStop: false },
    { change: "config", duringStop: true },
    { change: "include", duringStop: false },
    { change: "include", duringStop: true },
  ])(
    "refuses shared package restore for a sibling $change change (during stop=$duringStop)",
    async ({ change, duringStop }) => {
      const { profiles, params, rollback } = await sharedProfiles();
      const sibling = profiles[1]!;
      const edit = () => {
        const stateDir = sibling.preManagedServiceStop!.serviceEnv!.OPENCLAW_STATE_DIR!;
        if (change === "schema")
          setVersion(path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"), 4);
        else if (change === "include")
          fs.writeFileSync(path.join(stateDir, "logging.json"), '{"level":"debug"}\n');
        else fs.appendFileSync(sibling.configSnapshot.path, "\n// operator edit\n");
      };
      mocks.stop.mockImplementation(async ({ expectedService }) => {
        if (expectedService.serviceEnv.OPENCLAW_PROFILE === "secondary") edit();
        return { ...expectedService, stopped: true };
      });
      if (!duringStop) edit();
      const outcome = await rollbackFailedUpdate(params);
      expect(outcome).toMatchObject({
        rolledBack: false,
        result: { root: candidateRoot, reason: "state-migrated-no-rollback" },
      });
      expect(rollback).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.stop).toHaveBeenCalledTimes(duringStop ? 2 : 0);
    },
  );
  it.each(["unavailable package", "missing baseline", "blocked rollback"] as const)(
    "leaves every profile service untouched after %s",
    async (refusal) => {
      const { profiles, params, rollback } = await sharedProfiles();
      const originalStops = profiles.map((profile) => profile.preManagedServiceStop);
      if (refusal === "missing baseline") profiles[1]!.schemaVersions = undefined;
      const outcome = await rollbackFailedUpdate({
        ...params,
        ...(refusal === "unavailable package" ? { packageTransaction: undefined } : {}),
        ...(refusal === "blocked rollback"
          ? { rollbackBlockedReason: "state-migrated-no-rollback" }
          : {}),
      });
      expect(outcome.rolledBack).toBe(false);
      expect(rollback).not.toHaveBeenCalled();
      expect(mocks.restart).not.toHaveBeenCalled();
      expect(mocks.stop).not.toHaveBeenCalled();
      expect(profiles.map((profile) => profile.preManagedServiceStop)).toEqual(originalStops);
    },
  );
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
        activePackageRoot: candidateRoot,
        command: "restore",
        cwd: candidateRoot,
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
          root: candidateRoot,
          reason: "readyz-unhealthy",
          steps: [],
          durationMs: 1,
        },
        previousRoot,
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
        root: candidateRoot,
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
        "The candidate installation was left unchanged.",
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
          root: previousRoot,
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
            root: candidateRoot,
            reason: "doctor-failed",
            before: { version: "2026.9.1" },
            after: { version: "2026.9.3" },
            steps: [],
            durationMs: 1,
          },
          previousRoot,
          packageTransaction: {
            backupRoot: "/backup",
            complete: vi.fn(async () => {}),
            rollback: async () => ({
              name: "package rollback",
              activePackageRoot: previousRoot,
              command: "restore",
              cwd: previousRoot,
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
  it.each([
    { change: "none", previousVerified: true, restored: true, service: "stopped" },
    ...(process.platform === "win32"
      ? []
      : [
          { change: "readonly-config", previousVerified: true, restored: true, service: "stopped" },
        ]),
    { change: "doctor", previousVerified: true, restored: true, service: "stopped" },
    { change: "doctor-unchanged", previousVerified: true, restored: true, service: "stopped" },
    { change: "doctor-compensated", previousVerified: true, restored: true, service: "stopped" },
    { change: "doctor-missing-input", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-include", previousVerified: true, restored: true, service: "stopped" },
    { change: "doctor-include-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-input-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-capture-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-operator-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-locked-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-stop-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "doctor-restore-edit", previousVerified: true, restored: false, service: "stopped" },
    { change: "new-agent", previousVerified: true, restored: true, service: "stopped" },
    { change: "new-agent-foreign", previousVerified: true, restored: false, service: "stopped" },
    {
      change: "new-agent-previous-incompatible",
      previousVerified: true,
      restored: false,
      service: "stopped",
    },
    {
      change: "new-agent-previous-unknown",
      previousVerified: true,
      restored: false,
      service: "stopped",
    },
    { change: "identity-read-failed", previousVerified: true, restored: true, service: "stopped" },
    { change: "shared", previousVerified: true, restored: false, service: "stopped" },
    { change: "new-shared-deferred", previousVerified: true, restored: false, service: "stopped" },
    { change: "agent", previousVerified: true, restored: false, service: "stopped" },
    { change: "during-stop", previousVerified: true, restored: false, service: "stopped" },
    { change: "unknown-runtime", previousVerified: true, restored: false, service: "stopped" },
    { change: "none", previousVerified: false, restored: false, service: "stopped" },
    { change: "none", previousVerified: true, restored: false, service: "absent" },
    { change: "none", previousVerified: true, restored: false, service: "no-restart" },
  ])(
    "$change schema change; previous verified=$previousVerified; service=$service",
    async ({ change, previousVerified, restored, service }) => {
      const stateDir = dirs.make("update-schema-rollback-");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const configPath = path.join(stateDir, "openclaw.json");
      const includePath = path.join(stateDir, "logging.json");
      const authored = {
        gateway: { mode: "local" },
        agents: { defaults: { models: { "openai/gpt-5.6-luna": {} } } },
        ...(change.startsWith("doctor-include") ? { logging: { $include: "./logging.json" } } : {}),
      };
      const originalRaw = `// Fresh install: Doctor has never run.\n${JSON.stringify(authored, null, 2)}\n`;
      if (change.startsWith("doctor-include")) {
        fs.writeFileSync(includePath, '{"level":"info"}\n');
      }
      if (change.startsWith("doctor") || change === "readonly-config") {
        fs.writeFileSync(configPath, originalRaw, { mode: 0o600 });
      }
      const configSnapshot = await createConfigIO({
        env: process.env,
        pluginValidation: "skip",
      }).readConfigFileSnapshot();
      const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
      let activationConfig: { path: string; raw: string | null; hash: string } | undefined;
      const shared = path.join(stateDir, "state/openclaw.sqlite");
      const agent = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
      if (change !== "new-shared-deferred") {
        setVersion(shared, 7);
      }
      if (!change.startsWith("new-agent")) {
        setVersion(agent, 3);
      }
      const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config: {} });
      if (change === "new-shared-deferred") {
        expect(schemaVersions.find((entry) => entry.path === shared)?.userVersion).toBeNull();
        setVersion(shared, 7);
        const database = new DatabaseSync(shared);
        try {
          database.exec(`
            CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);
            INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '8', 0);
          `);
        } finally {
          database.close();
        }
      }
      if (change.startsWith("new-agent")) {
        setVersion(agent, change === "new-agent-foreign" ? 4 : 3);
      }
      if (change === "shared") {
        setVersion(shared, 8);
      }
      if (change === "agent") {
        setVersion(agent, 4);
      }
      if (change === "during-stop") {
        mocks.stop.mockImplementationOnce(async () => {
          setVersion(agent, 4);
          return { stopped: true };
        });
      }
      const result: UpdateRunResult = {
        status: "error",
        reason: change === "doctor-compensated" ? "doctor-failed" : "version-mismatch",
        mode: "npm",
        root: change === "unknown-runtime" ? undefined : candidateRoot,
        before: { version: "2026.9.1" },
        after: { version: "2026.9.3" },
        steps: [],
        durationMs: 10,
      };
      const operatorEdit = () =>
        fs.appendFileSync(configPath, "\n// Operator edit after activation.\n");
      if (change.startsWith("doctor")) {
        fs.writeFileSync(path.join(candidateRoot, "dist/entry.js"), "export {};\n");
        vi.spyOn(updateShared, "runUpdateStep").mockImplementationOnce(async (step) => {
          let doctorError: Error | undefined;
          if (change === "doctor-input-edit") {
            fs.writeFileSync(
              configPath,
              JSON.stringify({ ...authored, logging: { level: "debug" } }),
            );
          }
          await captureUpdateDoctorConfigWrites(configPath, async (capture) => {
            const io = createConfigIO({ env: process.env, pluginValidation: "skip" });
            const input = await io.readConfigFileSnapshot();
            if (change !== "doctor-unchanged") {
              const nextConfig: OpenClawConfig = {
                ...(input.sourceConfigBeforeMigrations ?? input.sourceConfig),
                meta: {
                  migrations: { modelPolicyAllowlist: true },
                  lastTouchedVersion: "2026.9.3",
                },
                agents: {
                  defaults: {
                    ...authored.agents.defaults,
                    modelPolicy: { allow: ["openai/gpt-5.6-luna"] },
                  },
                },
                wizard: { lastRunVersion: "2026.9.3", lastRunCommand: "doctor" },
              };
              const writeOptions = {
                baseSnapshot: input,
                lastTouchedVersionOverride: "2026.9.3",
                skipPluginValidation: true,
              };
              if (change === "doctor-compensated") {
                doctorError = await writeWithRefreshFailure(nextConfig, writeOptions, originalRaw);
              } else {
                await io.writeConfigFile(nextConfig, writeOptions);
              }
            }
            if (change === "doctor-capture-edit") {
              operatorEdit();
            }
            await writeUpdatePostInstallDoctorResult({
              resultPath: step.env!.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH!,
              result: {
                status: doctorError ? "error" : "ok",
                configHash: capture.hash,
                ...(change === "doctor-missing-input"
                  ? {}
                  : { configInputHash: capture.inputHash }),
              },
            });
          });
          return {
            name: "openclaw doctor",
            command: "doctor",
            cwd: candidateRoot,
            durationMs: 1,
            exitCode: doctorError ? 1 : 0,
            ...(doctorError ? { stderrTail: doctorError.message } : {}),
          };
        });
        const doctorStep = await packageModule.runPackageUpdateDoctor({
          root: candidateRoot,
          timeoutMs: 1_000,
          progress: {},
          managedServiceEnv: process.env,
          onConfigSnapshot: (snapshot) => {
            activationConfig = snapshot;
          },
        });
        if (change === "doctor-compensated") {
          if (!doctorStep) {
            throw new Error("Doctor compensation did not return an update step");
          }
          expect(doctorStep).toMatchObject({
            exitCode: 1,
            stderrTail: expect.stringContaining("Doctor runtime activation refused"),
          });
          expect(doctorStep.advisory).toBeUndefined();
          result.steps.push(doctorStep);
        }
        expect(fs.readFileSync(`${configPath}.pre-update`, "utf8")).toBe(originalRaw);
        const inspected = { ...result, status: "ok" as const };
        expect(
          await inspectActivatedUpdateState({
            result: inspected,
            root: candidateRoot,
            schemaVersions,
            candidateSchemaVersions: { state: change === "new-shared-deferred" ? 8 : 7, agent: 3 },
            config,
            env: process.env,
          }),
        ).toBeUndefined();
        expect(inspected.status).toBe("ok");
        if (change === "doctor-include-edit") {
          fs.writeFileSync(includePath, '{"level":"debug"}\n');
        }
        if (change === "doctor-operator-edit") {
          operatorEdit();
        }
        if (change === "doctor-stop-edit") {
          mocks.stop.mockImplementationOnce(async () => {
            operatorEdit();
            return { stopped: true };
          });
        }
      }
      const rollback = vi.fn(async () => {
        if (change === "doctor-restore-edit") {
          operatorEdit();
        }
        return {
          name: "rollback",
          activePackageRoot: previousRoot,
          command: "restore",
          cwd: previousRoot,
          exitCode: 0,
          durationMs: 1,
        };
      });
      if (change === "identity-read-failed") {
        vi.spyOn(packageModule, "readPackageUpdateIdentity").mockRejectedValueOnce(
          new Error("Diagnostic identity read failed after verified restoration"),
        );
      }
      let finishWriter: (() => Promise<void>) | undefined;
      if (change === "doctor-locked-edit") {
        const script = path.join(candidateRoot, "config-writer.mjs");
        fs.writeFileSync(
          script,
          `
          import { withFileLock } from ${JSON.stringify(pathToFileURL(path.resolve("src/infra/file-lock.ts")).href)};
          import { appendFile } from "node:fs/promises";
          const commit = new Promise(resolve => process.once("message", resolve));
          await withFileLock(process.argv[2], {
            retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 }, stale: 30_000,
          }, async () => {
            process.send("locked");
            await commit;
            await appendFile(process.argv[2], "\\n// Operator edit after activation.\\n");
          });
          process.disconnect();
        `,
        );
        const writer = fork(script, [configPath], {
          execArgv: ["--import", path.resolve("scripts/tsx.mjs")],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        onTestFinished(() => stopChildProcess(writer, 1_000));
        const exited = once(writer, "exit");
        let requested = false;
        finishWriter = async () => {
          if (!requested && writer.connected) {
            requested = true;
            writer.send("commit");
          }
          const [code] = await exited;
          expect(code).toBe(0);
        };
        await Promise.race([
          once(writer, "message").then(([message]) => expect(message).toBe("locked")),
          exited.then(([code]) => {
            throw new Error(`Config writer exited before locking: ${code}`);
          }),
        ]);
        const open = fs.promises.open.bind(fs.promises);
        const rename = fs.promises.rename.bind(fs.promises);
        const lockPath = `${fs.realpathSync(configPath)}.lock`;
        // Commit at lock contention, or at an unprotected publication after its
        // final read. The operator holds the same cross-process lock as config set.
        vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
          if (String(args[0]) === lockPath) {
            await finishWriter?.();
          }
          return open(...args);
        });
        vi.spyOn(fs.promises, "rename").mockImplementation(async (...args) => {
          if (String(args[1]) === configPath) {
            await finishWriter?.();
          }
          return rename(...args);
        });
      }
      if (change === "readonly-config") {
        fs.chmodSync(stateDir, 0o500);
      }
      let outcome: Awaited<ReturnType<typeof rollbackFailedUpdate>>;
      try {
        outcome = await rollbackFailedUpdate({
          profiles: [
            createRollbackProfile({
              configSnapshot,
              activationConfig,
              schemaVersions,
              previousVerified,
              preManagedServiceStop:
                service === "absent"
                  ? undefined
                  : {
                      stopped: service === "stopped",
                      inspected: true,
                      runtimeInspected: true,
                      running: true,
                      serviceEnv: { OPENCLAW_STATE_DIR: stateDir },
                      serviceNodeRunner: "/previous/node",
                      serviceUpdateVerdict: {
                        kind: "owned",
                        root: previousRoot,
                        fingerprint: "fixture",
                        refreshDefinition: true,
                      },
                    },
            }),
          ],

          result,
          previousRoot,
          nodeRunner: process.execPath,
          candidateSchemaVersions: { state: change === "new-shared-deferred" ? 8 : 7, agent: 3 },
          previousSchemaVersions:
            change === "new-agent-previous-unknown"
              ? undefined
              : {
                  state: 7,
                  agent: change === "new-agent-previous-incompatible" ? 2 : 3,
                },
          packageTransaction: { backupRoot: "/backup", rollback, complete: vi.fn() },
          opts: { json: true, restart: service !== "no-restart" },
          timeoutMs: 1_000,
        });
      } finally {
        await finishWriter?.();
        if (change === "readonly-config") {
          const mode = fs.statSync(stateDir).mode & 0o777;
          fs.chmodSync(stateDir, 0o700);
          expect(mode).toBe(0o500);
        }
      }
      if (change === "readonly-config") {
        expect(rollback).toHaveBeenCalledOnce();
        expect(fs.readFileSync(configPath, "utf8")).toBe(originalRaw);
      }
      if (
        change === "doctor" ||
        change === "doctor-unchanged" ||
        change === "doctor-compensated" ||
        change === "doctor-include"
      ) {
        expect(fs.readFileSync(configPath, "utf8")).toBe(originalRaw);
        if (process.platform !== "win32") {
          expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
        }
      }
      if (change.startsWith("doctor-") && change.endsWith("edit")) {
        if (change === "doctor-input-edit") {
          expect(fs.readFileSync(configPath, "utf8")).toContain('"debug"');
        } else if (change === "doctor-include-edit") {
          expect(fs.readFileSync(includePath, "utf8")).toContain('"debug"');
        } else {
          expect(fs.readFileSync(configPath, "utf8")).toContain("Operator edit after activation");
        }
        expect(
          resolveUpdateResultNextAction({ result: outcome.result, env: process.env }),
        ).toContain(configPath);
      }
      expect(outcome.rolledBack, JSON.stringify(outcome)).toBe(restored);
      expect(rollback, JSON.stringify(outcome)).toHaveBeenCalledTimes(
        change === "none" ||
          change === "readonly-config" ||
          change === "doctor" ||
          change === "doctor-unchanged" ||
          change === "doctor-compensated" ||
          change === "doctor-include" ||
          change === "doctor-restore-edit" ||
          change === "identity-read-failed" ||
          change === "new-agent"
          ? 1
          : 0,
      );
      expect(mocks.restart).toHaveBeenCalledTimes(restored ? 1 : 0);
      if (service !== "stopped") {
        expect(mocks.stop).not.toHaveBeenCalled();
        expect(outcome.result).toMatchObject({
          root: previousRoot,
          after: result.before,
          reason: result.reason,
          recovery: { serviceRestartSafe: false, packageRollbackVerified: true },
        });
        return;
      }
      if (restored) {
        expect(outcome).toMatchObject({ verifiedAtMs: 125 });
        expect(mocks.restart).toHaveBeenCalledWith(
          expect.objectContaining({ nodeRunner: "/previous/node" }),
        );
        expect(outcome.result).toMatchObject({
          root: previousRoot,
          after: result.before,
          reason: change === "doctor-compensated" ? "doctor-failed" : "version-mismatch",
        });
        if (change === "doctor-compensated") {
          expectDoctorRollback(activationConfig, outcome.result, configPath, originalRaw);
        }
        expect(mocks.stop.mock.invocationCallOrder[0]).toBeLessThan(
          rollback.mock.invocationCallOrder[0]!,
        );
        expect(rollback.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.restart.mock.invocationCallOrder[0]!,
        );
      } else {
        expect(outcome.result.reason).toBe(
          change === "unknown-runtime" ||
            change === "new-shared-deferred" ||
            change.startsWith("new-agent-previous-")
            ? "rollback-state-unverified"
            : previousVerified
              ? "state-migrated-no-rollback"
              : "previous-version-unverified",
        );
        if (!previousVerified) {
          expect(outcome.result).toMatchObject({ root: previousRoot, after: result.before });
        }
        if (change.startsWith("new-agent-previous-")) {
          expect(outcome.result).toMatchObject({ root: candidateRoot, after: result.after });
          expect(mocks.stop).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each([false, true])(
    "holds every profile config lock and current executor across restores (revoked=%s)",
    async (revokeAfterRestore) => {
      const original = '{"gateway":{"mode":"local","port":19101}}\n';
      const candidate = '{"gateway":{"mode":"local","port":19102}}\n';
      const profiles: UpdateProfileContext[] = [];
      let current = true;
      let run: updateShared.UpdateCommandOptions["run"];
      for (const name of ["secondary", "primary"]) {
        const stateDir = dirs.make(`rollback-config-${name}-`);
        const env = { OPENCLAW_STATE_DIR: stateDir };
        const configPath = path.join(stateDir, "openclaw.json");
        const originalRaw = revokeAfterRestore && name === "primary" ? null : original;
        if (originalRaw !== null) fs.writeFileSync(configPath, originalRaw);
        const configSnapshot = await readPreviousConfig(env);
        run ??= {
          runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
          env,
          executorFence: {
            assertCurrent() {
              if (!current) throw new Error("original executor revoked after config restoration");
            },
          },
        };
        const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
        const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config, env });
        fs.writeFileSync(configPath, candidate);
        profiles.push(
          createRollbackProfile({
            configSnapshot,
            schemaVersions,
            ownedManagedUpdateEnv: env,
            activationConfig: {
              path: configPath,
              raw: originalRaw,
              hash: hashConfigRaw(candidate),
              doctorOwned: true,
            },
          }),
        );
      }
      const replace = replaceFile.replaceFileAtomic;
      let historyAtRevocation: ReturnType<typeof getUpdateRun>;
      vi.spyOn(replaceFile, "replaceFileAtomic").mockImplementation(async (params) => {
        await replace(params);
        if (revokeAfterRestore && params.filePath === profiles[0]!.configSnapshot.path) {
          historyAtRevocation = getUpdateRun(run!.runId, { env: run!.env });
          current = false;
        }
      });
      const lockOptions = {
        retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
        stale: 60_000,
      };
      let foreignWrite = false;
      const outcome = await rollbackFailedUpdate({
        profiles,
        result: {
          status: "error",
          mode: "npm",
          root: candidateRoot,
          reason: "readyz-unhealthy",
          steps: [],
          durationMs: 1,
          before: { version: "2026.9.1" },
          after: { version: "2026.9.3" },
        },
        previousRoot,
        timeoutMs: 1000,
        opts: { json: true, run },
        packageTransaction: {
          backupRoot: previousRoot,
          complete: async () => {},
          rollback: async () => {
            for (const {
              configSnapshot: { path: configPath },
            } of profiles) {
              try {
                await withFileLock(configPath, lockOptions, async () => {
                  foreignWrite = true;
                  fs.writeFileSync(configPath, '{"gateway":{"mode":"local","port":19103}}\n');
                });
              } catch (error) {
                if (
                  !(
                    error instanceof Error &&
                    "code" in error &&
                    error.code === FILE_LOCK_TIMEOUT_ERROR_CODE
                  )
                ) {
                  throw error;
                }
              }
            }
            return {
              name: "package rollback",
              command: "restore",
              cwd: previousRoot,
              durationMs: 1,
              exitCode: 0,
              activePackageRoot: previousRoot,
            };
          },
        },
      });
      expect(foreignWrite).toBe(false);
      expect(outcome.result).toMatchObject({
        root: previousRoot,
        recovery: revokeAfterRestore
          ? { serviceRestartSafe: false }
          : { packageRollbackVerified: true },
      });
      expect(mocks.restart).not.toHaveBeenCalled();
      if (revokeAfterRestore) {
        expect(current).toBe(false);
        expect(outcome.pendingRecoveryReason).toBe(
          "original executor revoked after config restoration",
        );
        expect(getUpdateRun(run!.runId, { env: run!.env })).toEqual(historyAtRevocation);
        expect(fs.readFileSync(profiles[0]!.configSnapshot.path, "utf8")).toBe(original);
        expect(fs.readFileSync(profiles[1]!.configSnapshot.path, "utf8")).toBe(candidate);
        return;
      }
      for (const {
        configSnapshot: { path: configPath },
      } of profiles) {
        expect(fs.readFileSync(configPath, "utf8")).toBe(original);
        await withFileLock(configPath, lockOptions, async () => {
          fs.writeFileSync(configPath, candidate);
        });
        expect(fs.readFileSync(configPath, "utf8")).toBe(candidate);
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
        root: candidateRoot,
        steps: [],
        durationMs: 1,
      },
      previousRoot,
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
      failure === "partial-restore" ? null : restoredPackage ? previousRoot : candidateRoot;
    const stateDir = dirs.make("rollback-source-failed-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const configSnapshot = await readPreviousConfig(env);
    const config = configSnapshot.sourceConfigBeforeMigrations ?? configSnapshot.sourceConfig;
    const schemaVersions = await readUpdateStateSchemaVersions({ stateDir, config, env });
    const result: UpdateRunResult = {
      status: "error",
      mode: "npm",
      root: candidateRoot,
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
      previousRoot,
      opts: { json: true },
      timeoutMs: 1_000,
      packageTransaction: {
        backupRoot: "/backup",
        complete: vi.fn(async () => {}),
        rollback: vi.fn(async () => ({
          name: "rollback",
          activePackageRoot,
          command: "restore",
          cwd: previousRoot,
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
