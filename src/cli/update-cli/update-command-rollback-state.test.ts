// Install service mocks before loading the rollback owner and its dependencies.
import "./update-command-rollback-runtime.test-support.js";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { stopChildProcess } from "../../../test/helpers/stop-child-process.js";
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
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import * as updateShared from "./shared.js";
import type { UpdateProfileContext } from "./update-command-finish-types.js";
import { inspectActivatedUpdateState } from "./update-command-migrated.js";
import * as packageModule from "./update-command-package.js";
import { rollbackFailedUpdate } from "./update-command-rollback.js";
import {
  createRollbackProfile,
  expectDoctorRollback,
  writeWithRefreshFailure,
} from "./update-command-rollback.test-support.js";
import { resolveUpdateResultNextAction } from "./update-recovery-guidance.js";

const rollbackRuntime = await import("./update-command-rollback-runtime.test-support.js");
const { dirs, mocks, readPreviousConfig, setVersion } = rollbackRuntime;

describe("verified package rollback", () => {
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
        root: change === "unknown-runtime" ? undefined : rollbackRuntime.candidateRoot,
        before: { version: "2026.9.1" },
        after: { version: "2026.9.3" },
        steps: [],
        durationMs: 10,
      };
      const operatorEdit = () =>
        fs.appendFileSync(configPath, "\n// Operator edit after activation.\n");
      if (change.startsWith("doctor")) {
        fs.writeFileSync(path.join(rollbackRuntime.candidateRoot, "dist/entry.js"), "export {};\n");
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
            cwd: rollbackRuntime.candidateRoot,
            durationMs: 1,
            exitCode: doctorError ? 1 : 0,
            ...(doctorError ? { stderrTail: doctorError.message } : {}),
          };
        });
        const doctorStep = await packageModule.runPackageUpdateDoctor({
          root: rollbackRuntime.candidateRoot,
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
            root: rollbackRuntime.candidateRoot,
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
          activePackageRoot: rollbackRuntime.previousRoot,
          command: "restore",
          cwd: rollbackRuntime.previousRoot,
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
        const script = path.join(rollbackRuntime.candidateRoot, "config-writer.mjs");
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
                        root: rollbackRuntime.previousRoot,
                        fingerprint: "fixture",
                        refreshDefinition: true,
                      },
                    },
            }),
          ],

          result,
          previousRoot: rollbackRuntime.previousRoot,
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
          root: rollbackRuntime.previousRoot,
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
          root: rollbackRuntime.previousRoot,
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
          expect(outcome.result).toMatchObject({
            root: rollbackRuntime.previousRoot,
            after: result.before,
          });
        }
        if (change.startsWith("new-agent-previous-")) {
          expect(outcome.result).toMatchObject({
            root: rollbackRuntime.candidateRoot,
            after: result.after,
          });
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
        if (originalRaw !== null) {
          fs.writeFileSync(configPath, originalRaw);
        }
        const configSnapshot = await readPreviousConfig(env);
        run ??= {
          runId: createUpdateRun({ trigger: "cli" }, { env }).runId,
          env,
          executorFence: {
            assertCurrent() {
              if (!current) {
                throw new Error("original executor revoked after config restoration");
              }
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
        const result = await replace(params);
        if (revokeAfterRestore && params.filePath === profiles[0]!.configSnapshot.path) {
          historyAtRevocation = getUpdateRun(run!.runId, { env: run!.env });
          current = false;
        }
        return result;
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
          root: rollbackRuntime.candidateRoot,
          reason: "readyz-unhealthy",
          steps: [],
          durationMs: 1,
          before: { version: "2026.9.1" },
          after: { version: "2026.9.3" },
        },
        previousRoot: rollbackRuntime.previousRoot,
        timeoutMs: 1000,
        opts: { json: true, run },
        packageTransaction: {
          backupRoot: rollbackRuntime.previousRoot,
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
              cwd: rollbackRuntime.previousRoot,
              durationMs: 1,
              exitCode: 0,
              activePackageRoot: rollbackRuntime.previousRoot,
            };
          },
        },
      });
      expect(foreignWrite).toBe(false);
      expect(outcome.result).toMatchObject({
        root: rollbackRuntime.previousRoot,
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
});
