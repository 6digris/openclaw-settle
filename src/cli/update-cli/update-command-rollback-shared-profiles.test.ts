// Install service mocks before loading the rollback owner and its dependencies.
import "./update-command-rollback-runtime.test-support.js";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { UpdateProfileContext } from "./update-command-finish-types.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import { createRollbackProfile } from "./update-command-rollback.test-support.js";
import { recordUpdateGatewayHealth } from "./update-command-verification.js";

const rollbackRuntime = await import("./update-command-rollback-runtime.test-support.js");
const { dirs, mocks, readPreviousConfig, setVersion } = rollbackRuntime;

describe("verified package rollback", () => {
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
              root: rollbackRuntime.previousRoot,
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
      root: rollbackRuntime.candidateRoot,
      reason: "readyz-unhealthy",
      before: { version: "2026.9.1" },
      after: { version: "2026.9.3" },
      steps: [],
      durationMs: 1,
    };
    const rollback = vi.fn(async () => ({
      name: "package rollback",
      activePackageRoot: rollbackRuntime.previousRoot,
      command: "restore",
      cwd: rollbackRuntime.previousRoot,
      exitCode: 0,
      durationMs: 1,
    }));
    const params = {
      profiles,
      result,
      previousRoot: rollbackRuntime.previousRoot,
      opts: { json: true },
      timeoutMs: 1000,
      packageTransaction: { backupRoot: rollbackRuntime.previousRoot, complete: vi.fn(), rollback },
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
      if (failure === "unverified") {
        profiles[1]!.previousVerified = false;
      }
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
        if (name === "secondary" && failure === "stop throws") {
          throw new Error("native inspection failed after stop");
        }
        return stopped;
      });
      rollback.mockImplementation(async () => {
        events.push("restore package");
        return {
          name: "package rollback",
          activePackageRoot: rollbackRuntime.previousRoot,
          command: "restore",
          cwd: rollbackRuntime.previousRoot,
          exitCode: 0,
          durationMs: 1,
        };
      });
      mocks.restart.mockImplementation(async (restart) => {
        const { result, serviceEnv, nodeRunner, serviceManagerUid, onVerified } = restart;
        if (originNotRestarted) {
          expect(restart.opts).toBe(opts);
        }
        const name = serviceEnv?.OPENCLAW_PROFILE;
        events.push(`restart ${name}`);
        expect(process.env.OPENCLAW_PROFILE).toBe(name);
        expect(nodeRunner).toBe(`/${name}/node`);
        expect(serviceManagerUid).toBe(name === "primary" ? 3001 : 3002);
        if (name === "secondary" && failure === "restart throws") {
          throw new Error("secondary native restart failed");
        }
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
            cwd: rollbackRuntime.previousRoot,
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
          if (index === -1) {
            result.steps.push(receipt);
          } else {
            result.steps[index] = receipt;
          }
          if (pending) {
            return "readiness-pending";
          }
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
      if (failure === "unverified") {
        expect(outcome.result.reason).toBe("previous-version-unverified");
      }
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
        if (change === "schema") {
          setVersion(path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"), 4);
        } else if (change === "include") {
          fs.writeFileSync(path.join(stateDir, "logging.json"), '{"level":"debug"}\n');
        } else {
          fs.appendFileSync(sibling.configSnapshot.path, "\n// operator edit\n");
        }
      };
      mocks.stop.mockImplementation(async ({ expectedService }) => {
        if (expectedService.serviceEnv.OPENCLAW_PROFILE === "secondary") {
          edit();
        }
        return { ...expectedService, stopped: true };
      });
      if (!duringStop) {
        edit();
      }
      const outcome = await rollbackFailedUpdate(params);
      expect(outcome).toMatchObject({
        rolledBack: false,
        result: { root: rollbackRuntime.candidateRoot, reason: "state-migrated-no-rollback" },
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
      if (refusal === "missing baseline") {
        profiles[1]!.schemaVersions = undefined;
      }
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
});
