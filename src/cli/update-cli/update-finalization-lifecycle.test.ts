import { createHash } from "node:crypto";
import fsSync, { writeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readConfigFileSnapshot, transformConfigFile } from "../../config/config.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { UPDATE_RUN_ID_ENV } from "../../infra/update-control-plane-sentinel.js";
import { UpdateDoctorError } from "../../infra/update-doctor-result.js";
import { prepareUpdateFailureReport } from "../../infra/update-failure-report-prepare.js";
import type { UpdateRecoveryBackupRef } from "../../infra/update-recovery-backup-contract.js";
import {
  inspectUpdateRecoveryBackups,
  readUpdateRecoveryConfigState,
  verifyUpdateRecoveryBackup,
} from "../../infra/update-recovery-backup.js";
import { inspectUpdateRunAbandonment } from "../../infra/update-run-activity.js";
import * as ledger from "../../infra/update-run-ledger.js";
import { getUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import {
  ABANDONED_UPDATE_RUN_MS,
  UPDATE_RUN_HEARTBEAT_MS,
} from "../../infra/update-run-timeouts.js";
import { defaultRuntime } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withCliProcessScope } from "../runtime-cleanup-scope.js";
import * as shared from "./shared.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import * as freshDoctor from "./update-command-fresh-doctor.js";
import * as plugins from "./update-command-plugins.js";
import { UpdateFinalizationLifecycle } from "./update-finalization-lifecycle.js";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

const dirs = createTempDirTracker();

it("records a Doctor refusal before reporting standalone finalization", async () => {
  const lifecycle = new UpdateFinalizationLifecycle(false, 5_000, () => {});
  lifecycle.attachLedger();
  const message =
    "Doctor could not enter maintenance. Error: The update parent owns Gateway activation.";
  const privatePath = "/home/example/private-doctor-input";
  await expect(
    lifecycle.run("doctor", async () => {
      throw new UpdateDoctorError(`${message} ${privatePath}`, [
        { check: "doctor", code: "doctor-failed", message },
      ]);
    }),
  ).rejects.toThrow(message);
  lifecycle.fail();
  expect(vi.mocked(defaultRuntime.error).mock.calls.flat().join("\n")).not.toContain(privatePath);
  closeOpenClawStateDatabaseForTest();
  const run = listUpdateRuns()[0]!;
  expect(run).toMatchObject({
    status: "failed",
    reason: "doctor-failed",
  });
  const report = await prepareUpdateFailureReport({
    attemptId: run.runId,
    recordedRun: run,
    result: { status: "error", mode: "unknown", steps: [], durationMs: 1 },
  });
  expect(report.body).toContain("Reason code: doctor-failed");
  expect(report.body).toContain(`Failed phase finalize:doctor: ${message}`);
  expect(report.body).not.toContain("Failed phase finalize:doctor: exit unknown");
});

it.each([
  "preflight",
  "targetConfigValidation",
  "configSnapshot",
  "doctor",
  "plugins",
  "targetConfigConvergence",
  "completionCache",
] as const)("records the %s failure reason without finishing an inherited run", async (phase) => {
  const inherited = ledger.createUpdateRun({ trigger: "cli" });
  vi.stubEnv(UPDATE_RUN_ID_ENV, inherited.runId);
  const lifecycle = new UpdateFinalizationLifecycle(false, 5_000, () => {});
  lifecycle.attachLedger();
  await expect(
    lifecycle.run(phase, async () => {
      throw new Error("phase failed");
    }),
  ).rejects.toThrow("phase failed");
  lifecycle.fail();
  expect(getUpdateRun(inherited.runId)).toMatchObject({
    status: "running",
    reason: `finalize:${phase}`,
  });
  ledger.finishUpdateRun(inherited.runId, { status: "failed", reason: "parent-failure" });
  expect(getUpdateRun(inherited.runId)?.reason).toBe("parent-failure");
});

it("records a returned failed outcome without requiring an exception", async () => {
  const lifecycle = new UpdateFinalizationLifecycle(false, 5_000, () => {});
  lifecycle.attachLedger();
  await lifecycle.run(
    "plugins",
    async () => undefined,
    () => ({
      outcome: "failed",
      failureFacts: [{ check: "plugin-update", code: "plugin-update-failed" }],
    }),
  );
  lifecycle.complete(1);
  expect(listUpdateRuns()[0]).toMatchObject({ status: "failed", reason: "plugin-update-failed" });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("openclaw-finalize-heartbeat-"));
  vi.stubEnv(UPDATE_RUN_ID_ENV, undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  dirs.cleanup();
});

it.each(["doctor", "targetConfigConvergence"] as const)(
  "keeps default %s work owned without writing to its child's maintenance database",
  async (phase) => {
    const stopChildren = vi.fn();
    const lifecycle = new UpdateFinalizationLifecycle(false, undefined, stopChildren);
    expect(lifecycle.budget(phase)).toBeUndefined();
    lifecycle.attachLedger();
    const [initial] = listUpdateRuns();
    if (!initial) {
      throw new Error("Finalization did not create its update run.");
    }
    const work = createDeferredCore();
    const entered = createDeferredCore();
    const timerCount = vi.getTimerCount();
    const running = withCliProcessScope(() =>
      lifecycle.run(phase, () => {
        entered.resolve();
        return work.promise;
      }),
    );
    await entered.promise;
    try {
      const admitted = getUpdateRun(initial.runId);
      expect(admitted?.origin.driver?.pid).toBe(process.pid);

      await vi.advanceTimersByTimeAsync(ABANDONED_UPDATE_RUN_MS + UPDATE_RUN_HEARTBEAT_MS);
      expect(stopChildren).not.toHaveBeenCalled();
      const observed = getUpdateRun(initial.runId);
      expect(observed).toEqual(admitted);
      if (!observed) {
        throw new Error("Finalization lost its update run.");
      }
      expect(inspectUpdateRunAbandonment(observed)).toBeUndefined();
    } finally {
      work.resolve();
      await expect(running).resolves.toBeUndefined();
    }
    expect(vi.getTimerCount()).toBe(timerCount);
    lifecycle.complete(0);
    expect(getUpdateRun(initial.runId)?.status).toBe("succeeded");
  },
);

it("uses generous state and plugin budgets while preserving explicit operator budgets", () => {
  const defaults = new UpdateFinalizationLifecycle(false, undefined, () => {});
  const explicit = new UpdateFinalizationLifecycle(false, 5_000, () => {});
  for (const [phase, budget] of [
    ["preflight", 300_000],
    ["targetConfigValidation", 300_000],
    ["configSnapshot", 300_000],
    ["plugins", 1_200_000],
    ["completionCache", 300_000],
    ["doctor", undefined],
    ["targetConfigConvergence", undefined],
  ] as const) {
    expect(defaults.budget(phase)).toBe(budget);
    expect(explicit.budget(phase)).toBe(5_000);
  }
});

it("reports the retained capture and recovery command on an explicit finalization deadline", async () => {
  const stopChildren = vi.fn();
  const lifecycle = new UpdateFinalizationLifecycle(true, 1_000, stopChildren);
  lifecycle.attachLedger();
  const directory = path.join(process.env.OPENCLAW_STATE_DIR!, "retained-capture");
  const manifestPath = path.join(directory, "manifest.json");
  lifecycle.updateRecoveryBackup = {
    directory,
    manifestPath,
    manifestSha256: "a".repeat(64),
  };
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  const json = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const write = vi.mocked(writeSync).mockClear();
  const work = createDeferredCore();
  const entered = createDeferredCore<AbortSignal>();
  const running = withCliProcessScope(() =>
    lifecycle.run("doctor", (scope) => {
      entered.resolve(scope.signal);
      return work.promise;
    }),
  );
  const settled = expect(running).rejects.toMatchObject({
    result: { reason: "finalization-timeout" },
  });
  const signal = await entered.promise;
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signal.aborted).toBe(true);
    // Cancellation retains ownership until work settles; the caller publishes
    // the terminal failure only after recovery, not from the timer callback.
    expect(exit).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  } finally {
    work.resolve();
    await settled;
  }
  lifecycle.complete(1);
  expect(json).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      status: "failed",
      stuckPhase: "doctor",
      recovery: { manifestPath, command: "npx openclaw@latest doctor --fix" },
    }),
  );
  const stderr = write.mock.calls
    .filter(([fd]) => fd === 2)
    .map(([, chunk]) => chunk)
    .join("");
  expect(stderr).toContain(manifestPath);
  expect(stderr).toContain("npx openclaw@latest doctor --fix");
  expect(listUpdateRuns()[0]).toMatchObject({ status: "failed" });
});

it("sizes finalization state without blocking the parent on database metadata", async () => {
  const database = resolveOpenClawStateSqlitePath(process.env);
  fsSync.mkdirSync(path.dirname(database), { recursive: true });
  fsSync.writeFileSync(database, "");
  fsSync.truncateSync(database, 2 * 1024 ** 3);
  const parentStat = vi.spyOn(fsSync, "statSync");
  const lifecycle = new UpdateFinalizationLifecycle(false, undefined, () => {});
  await lifecycle.run("preflight", async () => undefined);
  expect(lifecycle.budget("preflight")).toBe(2_860_000);
  expect(
    parentStat.mock.calls.filter(([file]) =>
      [database, `${database}-wal`, `${database}-shm`, `${database}-journal`].includes(
        String(file),
      ),
    ),
  ).toEqual([]);
});

it.each([
  ["preflight", 30_001],
  ["targetConfigValidation", 30_001],
  ["configSnapshot", 30_001],
  ["completionCache", 30_001],
  ["plugins", 600_001],
] as const)(
  "allows %s to finish beyond its former aggregate deadline",
  async (phase, elapsedMs) => {
    const databasePath = resolveOpenClawStateSqlitePath(process.env);
    fsSync.mkdirSync(path.dirname(databasePath), { recursive: true });
    for (const file of [databasePath, `${databasePath}-wal`]) {
      fsSync.writeFileSync(file, "");
      fsSync.truncateSync(file, 1024 ** 3);
    }
    const stopChildren = vi.fn();
    vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
      throw new Error("Finalization exited before the measured work completed");
    });
    const lifecycle = new UpdateFinalizationLifecycle(false, undefined, stopChildren);
    const work = createDeferredCore();
    const entered = createDeferredCore();
    const running = withCliProcessScope(() =>
      lifecycle.run(phase, () => {
        entered.resolve();
        return work.promise;
      }),
    );
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(elapsedMs);
      expect(stopChildren).not.toHaveBeenCalled();
    } finally {
      work.resolve();
      await running;
    }
    if (phase !== "plugins") {
      expect(lifecycle.budget(phase)).toBe(2_860_000);
    }
    expect(lifecycle.phaseTimings).toContainEqual(
      expect.objectContaining({ phase, outcome: "completed" }),
    );
  },
);

it.each([false, true])(
  "renews a long finalization phase and releases its heartbeat (failure=%s)",
  async (fails) => {
    const lifecycle = new UpdateFinalizationLifecycle(false, ABANDONED_UPDATE_RUN_MS * 2, () => {});
    lifecycle.attachLedger();
    const [initial] = listUpdateRuns();
    if (!initial) {
      throw new Error("Finalization did not create its update run.");
    }
    expect(initial.origin.driver?.pid).toBe(process.pid);
    const phase = createDeferredCore();
    const timerCount = vi.getTimerCount();
    const running = lifecycle.run("plugins", () => phase.promise);
    const settled = fails
      ? expect(running).rejects.toThrow("plugin repair failed")
      : expect(running).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(ABANDONED_UPDATE_RUN_MS + UPDATE_RUN_HEARTBEAT_MS);
    const observed = getUpdateRun(initial.runId);
    expect(observed?.status).toBe("running");
    expect(observed?.updatedAtMs).toBeGreaterThan(initial.updatedAtMs + ABANDONED_UPDATE_RUN_MS);
    if (fails) {
      phase.reject(new Error("plugin repair failed"));
    } else {
      phase.resolve();
    }
    await settled;
    expect(vi.getTimerCount()).toBe(timerCount);
    const finishedPhase = getUpdateRun(initial.runId);
    if (fails) {
      expect(finishedPhase?.steps).toContainEqual(
        expect.objectContaining({
          step: "finalize:plugins",
          status: "failed",
          failureFacts: [
            { check: "plugins", code: "finalization-failed", message: "plugin repair failed" },
          ],
        }),
      );
    }
    await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
    expect(getUpdateRun(initial.runId)).toEqual(finishedPhase);
    lifecycle.complete(fails ? 1 : 0);
  },
);

it("continues finalization after heartbeat errors and warns once for the run", async () => {
  const stopChildren = vi.fn();
  const lifecycle = new UpdateFinalizationLifecycle(
    false,
    ABANDONED_UPDATE_RUN_MS * 2,
    stopChildren,
  );
  lifecycle.attachLedger();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(ledger, "heartbeatUpdateRun").mockImplementation(() => {
    throw new Error("SQLITE_BUSY: database is locked");
  });
  for (const phase of ["plugins", "completionCache"] as const) {
    const work = createDeferredCore();
    const running = lifecycle.run(phase, () => work.promise);
    await vi.advanceTimersByTimeAsync(UPDATE_RUN_HEARTBEAT_MS * 2);
    expect(stopChildren).not.toHaveBeenCalled();
    work.resolve();
    await expect(running).resolves.toBeUndefined();
  }
  lifecycle.complete(0);
  expect(listUpdateRuns()[0]?.status).toBe("succeeded");
  expect(warning).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("SQLITE_BUSY"));
});

it.each([false, true])(
  "finalization protects both Doctor phases with one capture (post-Doctor failure=%s)",
  async (fails) => {
    vi.useRealTimers();
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
        update: { channel: "stable" },
      });
      const initialConfig = await fs.readFile(state.configPath, "utf8");
      const original = {
        agentId: "main",
        sessionKey: "agent:main:before-finalize",
        env: state.env,
      };
      const migrated = {
        agentId: "main",
        sessionKey: "agent:main:finalize-migration",
        env: state.env,
      };
      await upsertSessionEntryCore(original, { sessionId: "original-session", updatedAt: 1 });
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabaseForTest();
      const root = state.path("install");
      await fs.mkdir(root, { mode: 0o700 });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.3" }),
      );
      const coordinator = state.path("coordinator");
      await fs.mkdir(coordinator, { mode: 0o700 });
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(coordinator);
      vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(root);
      vi.spyOn(shared, "tryWriteCompletionCache").mockResolvedValue("completed");
      vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      const references: UpdateRecoveryBackupRef[] = [];
      const checkCapture = async (ref: UpdateRecoveryBackupRef | undefined) => {
        expect(ref, "every finalizer Doctor needs its parent's verified capture").toBeDefined();
        if (!ref) {
          throw new Error("Missing finalizer-owned update capture");
        }
        references.push(ref);
        const manifest = await verifyUpdateRecoveryBackup(ref);
        const configEntry = manifest.entries.find(
          (entry) => entry.sourcePath === state.configPath && entry.kind === "file",
        );
        if (configEntry?.kind !== "file") {
          throw new Error("Expected captured config before requested-channel mutation");
        }
        expect(await fs.readFile(path.join(ref.directory, configEntry.archivePath), "utf8")).toBe(
          initialConfig,
        );
        const raw = await fs.readFile(state.configPath, "utf8");
        const receipts = await readUpdateRecoveryConfigState(ref, { assertOwned() {} });
        expect(receipts.configWrites).toContainEqual(
          expect.objectContaining({
            path: state.configPath,
            beforeHash: createHash("sha256").update(initialConfig).digest("hex"),
            afterHash: createHash("sha256").update(raw).digest("hex"),
            contiguous: true,
          }),
        );
      };
      vi.spyOn(freshDoctor, "runUpdateFinalizationDoctorInFreshProcess").mockImplementation(
        async (params) => {
          await checkCapture(params.updateRecoveryBackup);
          expect(params.phase).toBe("pre-plugin");
          expect((await readConfigFileSnapshot()).config.update?.channel).toBe("beta");
          await upsertSessionEntryCore(migrated, { sessionId: "doctor-migration", updatedAt: 2 });
          await closeOpenClawAgentDatabasesAsync();
        },
      );
      const pluginUpdate: Awaited<ReturnType<typeof plugins.updatePluginsAfterCoreUpdate>> = {
        assessment: { kind: "no-payload-repair" },
        status: "ok",
        changed: true,
        sync: {
          changed: false,
          switchedToBundled: [],
          switchedToNpm: [],
          warnings: [],
          errors: [],
        },
        npm: { changed: false, outcomes: [] },
        integrityDrifts: [],
        warnings: [],
      };
      vi.spyOn(plugins, "updatePluginsAfterCoreUpdate").mockImplementation(async () => {
        await transformConfigFile({
          base: "source",
          writeOptions: {
            skipPluginValidation: true,
            skipRuntimeSnapshotRefresh: true,
            skipOutputLogs: true,
          },
          transform: (config) => ({
            nextConfig: { ...config, logging: { ...config.logging, level: "debug" } },
          }),
        });
        return pluginUpdate;
      });
      vi.spyOn(freshDoctor, "completePostCorePluginUpdate").mockImplementation(async (params) => {
        expect(params.freshDoctorRequired).toBe(true);
        await params.beforeDoctor?.();
        await checkCapture(params.updateRecoveryBackup);
        if (fails) {
          throw new Error("synthetic post-plugin Doctor failure");
        }
        return { pluginUpdate, configSnapshot: await readConfigFileSnapshot() };
      });
      const operation = updateFinalizeCommand({ yes: true, json: true, channel: "beta" });
      if (fails) {
        await expect(operation).rejects.toThrow("synthetic post-plugin Doctor failure");
      } else {
        await expect(operation).resolves.toBeUndefined();
      }
      expect(references).toHaveLength(2);
      expect(references[1]).toEqual(references[0]);
      const captures = await inspectUpdateRecoveryBackups();
      expect(captures).toHaveLength(1);
      expect(captures[0]?.ref).toEqual(references[0]);
      expect(loadSessionEntryReadOnly(original)?.sessionId).toBe("original-session");
      const run = listUpdateRuns()[0];
      expect(run?.status).toBe(fails ? "failed" : "succeeded");
      if (fails) {
        // Plugin/Doctor writes after capture are newer state, not rollback input.
        expect(loadSessionEntryReadOnly(migrated)?.sessionId).toBe("doctor-migration");
        expect((await readConfigFileSnapshot()).config).toMatchObject({
          update: { channel: "beta" },
          logging: { level: "debug" },
        });
        expect(run?.origin.updateRecoveryCapture?.restored).not.toBe(true);
        expect(captures[0]?.terminalOutcome).toBeUndefined();
      } else {
        expect(loadSessionEntryReadOnly(migrated)?.sessionId).toBe("doctor-migration");
        expect(defaultRuntime.error).toHaveBeenCalledWith(
          expect.stringContaining("npx openclaw@latest doctor --fix"),
        );
        const ref = references[0];
        if (!ref) {
          throw new Error("Expected retained finalization capture");
        }
        await expect(fs.stat(path.join(ref.directory, "outcome.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    });
  },
);
