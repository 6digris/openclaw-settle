import fs from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as doctorHealth from "../flows/doctor-health.js";
import * as packageRoot from "../infra/openclaw-root.js";
import { readProcessParentPidSync } from "../infra/restart-stale-pids.js";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import {
  assertNoUnresolvedUpdateRecoveryBackup,
  createUpdateRecoveryBackup,
  inspectUpdateRecoveryBackups,
  retireUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "../infra/update-recovery-backup.js";
import * as updateRunDriver from "../infra/update-run-driver.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  recordUpdateRunRecoveryCapture,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveCompletedDoctorUpdateRecovery } from "./doctor-update-recovery.js";
import { doctorCommand } from "./doctor.js";
const mocks = vi.hoisted(() => ({
  coordinator: vi.fn<() => string>(),
  afterClose: vi.fn<() => Promise<void>>(),
}));
vi.mock("../infra/tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: mocks.coordinator,
}));
vi.mock("../infra/update-run-driver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/update-run-driver.js")>()),
  inspectUpdateRunDriver: () => "dead",
}));
vi.mock("../flows/doctor-health.js", () => ({ runDoctorHealthFlow: async () => {} }));
vi.mock("./doctor-maintenance.js", () => ({
  beginDoctorMaintenance: async () => ({
    assertCurrent() {},
    closeStores: async () => {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabaseForTest();
      await mocks.afterClose();
    },
    release: async () => {},
  }),
}));

const authority = { assertOwned(this: void) {} };

async function prepareState(state: OpenClawTestState) {
  const coordinator = state.path("coordinator");
  await fs.mkdir(coordinator, { mode: 0o700 });
  mocks.coordinator.mockReturnValue(coordinator);
  await state.writeConfig({
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    plugins: { enabled: false },
  });
  const scope = { agentId: "main", sessionKey: "agent:main:retained", env: state.env };
  await upsertSessionEntryCore(scope, { sessionId: "before-update", updatedAt: 1 });
  await fs.mkdir(state.path("install"), { mode: 0o700 });
  return scope;
}

function output() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number) => {
      throw new ExitError(code);
    },
  } satisfies RuntimeEnv;
}

function recordVerifiedCompletion(runId: string) {
  for (const step of ["openclaw doctor", "post-update verification", "verifying"]) {
    recordUpdateRunStep(runId, { step, status: "completed", endedAtMs: Date.now() });
  }
  recordUpdateRunVerification(runId, {
    booted: true,
    serviceRunning: true,
    runningVersion: "2026.9.3",
    runningBuildId: "synthetic-upgrade",
    versionMatch: true,
    pluginErrors: [],
    channelsReady: true,
    readyz: true,
    settled: true,
  });
  finishUpdateRun(runId, {
    status: "succeeded",
    after: { version: "2026.9.3", buildId: "synthetic-upgrade" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.afterClose.mockReset();
});

describe("Doctor recovery ledger reconciliation", () => {
  it.each([
    { version: "2026.9.3", fault: "none" },
    { version: "2026.9.4", fault: "none" },
    { version: "2026.9.4", fault: "foreign driver" },
    { version: "2026.9.4", fault: "live prior Doctor" },
    { version: "2026.9.4", fault: "restore-failed" },
    { version: "2026.9.4", fault: "corrupt payload" },
    { version: "2026.9.4", fault: "partial settlement" },
  ])("continues the retained $version post-core capture: $fault", async ({ version, fault }) => {
    // This core capture fixture owns no plugin stores. Full-package acceptance
    // separately inventories the shipped bundled migration owners.
    await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const scope = await prepareState(state);
        const driver = updateRunDriver.readUpdateRunDriver(
          readProcessParentPidSync(process.ppid) ?? 0,
        );
        const parent = updateRunDriver.readUpdateRunDriver(process.ppid);
        expect(driver).toBeDefined();
        expect(parent).toBeDefined();
        if (!driver || !parent) {
          throw new Error("Missing published updater ancestry");
        }
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        recordUpdateRunPhase(run.runId, "activating", {
          before: { version },
          target: { kind: "package" },
          origin: { driver },
        });
        recordUpdateRunStep(run.runId, { step: "openclaw doctor", status: "completed" });
        recordUpdateRunStep(run.runId, { step: "post-update verification", status: "in_progress" });

        const ref = await createUpdateRecoveryBackup({
          ...authority,
          runId: run.runId,
          installRoot: state.path("install"),
          drivers: [fault === "foreign driver" ? parent : driver],
        });

        const manifest = await verifyUpdateRecoveryBackup(ref);
        const rawManifest = await fs.readFile(ref.manifestPath);

        await upsertSessionEntryCore(scope, { sessionId: "first-doctor-result", updatedAt: 2 });
        recordUpdateRunRecoveryCapture(
          run.runId,
          { manifestSha256: ref.manifestSha256, doctorCompleted: true },
          authority.assertOwned,
        );
        if (version === "2026.9.4" && fault === "none") {
          // The shipped parent serializes its older origin schema between Doctors.
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare(
              "UPDATE update_runs SET origin_json = json_remove(origin_json, '$.updateRecoveryCapture') WHERE run_id = ?",
            )
            .run(run.runId);
        }
        if (fault === "live prior Doctor") {
          vi.spyOn(updateRunDriver, "inspectUpdateRunDriver").mockReturnValue("alive");
        }
        if (fault === "restore-failed") {
          await writeUpdateRecoveryBackupOutcome(
            ref,
            { status: "restore-failed", error: "prior Doctor failed" },
            authority,
          );
        }
        if (fault === "partial settlement") {
          await fs.mkdir(path.join(ref.directory, "candidate"));
        }
        if (fault === "corrupt payload") {
          const entry = manifest.entries.find((candidate) => candidate.kind === "file");
          if (!entry) {
            throw new Error("Missing baseline payload");
          }
          await fs.appendFile(path.join(ref.directory, entry.archivePath), "corrupt");
        }
        const beforeContinuation = getUpdateRun(run.runId);
        const continuation = createUpdateRecoveryBackup({
          ...authority,
          runId: run.runId,
          installRoot: state.path("install"),
          resumeFromDriver: driver,
        });
        if (fault === "none") {
          await expect(continuation).resolves.toEqual(ref);
        } else {
          await expect(continuation).rejects.toThrow(
            /cannot continue|payload hash or size mismatch/,
          );
        }
        expect(await fs.readFile(ref.manifestPath)).toEqual(rawManifest);
        expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("first-doctor-result");
        expect((await inspectUpdateRecoveryBackups()).map((capture) => capture.ref)).toEqual([ref]);
        expect(getUpdateRun(run.runId)?.origin.updateRecoveryCapture?.restored).not.toBe(true);
        // Reusing B does not fabricate a Doctor-completion or terminal receipt.
        expect(getUpdateRun(run.runId)).toEqual(beforeContinuation);
      });
    });
  });
  it.each(["owned", "foreign ancestry"] as const)(
    "reuses the first Doctor capture through an adopted migrated worker: %s",
    async (ownership) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        await withOpenClawTestState(
          { layout: "state-only", scenario: "minimal" },
          async (state) => {
            const scope = await prepareState(state);
            const original = updateRunDriver.readUpdateRunDriver(
              readProcessParentPidSync(process.ppid) ?? 0,
            );
            const worker = updateRunDriver.readUpdateRunDriver(process.ppid);
            if (!original || !worker) {
              throw new Error("Missing migrated-worker ancestry");
            }
            const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
            recordUpdateRunPhase(run.runId, "activating", {
              before: { version: "2026.9.3" },
              target: { kind: "package" },
              origin: { driver: original },
            });
            const ref = await createUpdateRecoveryBackup({
              ...authority,
              runId: run.runId,
              installRoot: state.path("install"),
              drivers: [original],
            });
            const baseline = await fs.readFile(ref.manifestPath);
            await upsertSessionEntryCore(scope, { sessionId: "first-doctor-result", updatedAt: 2 });
            recordUpdateRunRecoveryCapture(
              run.runId,
              { manifestSha256: ref.manifestSha256, doctorCompleted: true },
              authority.assertOwned,
            );
            // The shipped migrated worker adopts the existing run before plugin
            // convergence; its Doctor has no POST_CORE marker or explicit backup.
            recordUpdateRunPhase(run.runId, "activating", {
              origin: {
                driver: worker,
                previousDrivers: [
                  ownership === "owned"
                    ? original
                    : { ...original, startIdentity: String(Number(original.startIdentity) + 1) },
                ],
              },
            });
            recordUpdateRunStep(run.runId, { step: "openclaw doctor", status: "completed" });
            recordUpdateRunStep(run.runId, {
              step: "post-update verification",
              status: "in_progress",
            });
            vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(
              state.path("install"),
            );
            const flow = vi.spyOn(doctorHealth, "runDoctorHealthFlow");
            await withEnvAsync(
              {
                OPENCLAW_UPDATE_IN_PROGRESS: "1",
                OPENCLAW_UPDATE_RUN_ID: run.runId,
                OPENCLAW_UPDATE_POST_CORE: undefined,
                OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
              },
              async () => {
                const command = doctorCommand(output(), { repair: true, nonInteractive: true });
                if (ownership === "owned") {
                  await expect(command).resolves.toBeUndefined();
                  expect(flow).toHaveBeenCalledOnce();
                } else {
                  await expect(command).rejects.toThrow(
                    /cannot continue|another protected mutation/,
                  );
                  expect(flow).not.toHaveBeenCalled();
                }
              },
            );
            expect(await fs.readFile(ref.manifestPath)).toEqual(baseline);
            expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("first-doctor-result");
            expect((await inspectUpdateRecoveryBackups()).map((capture) => capture.ref)).toEqual([
              ref,
            ]);
            expect(getUpdateRun(run.runId)?.origin.updateRecoveryCapture?.restored).not.toBe(true);
          },
        );
      });
    },
  );
  it("settles a completed 9.2 capture under the next updater's executor without restoring newer sessions", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const installRoot = state.path("install");
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot,
      });
      recordVerifiedCompletion(run.runId);
      // Tagged 9.2 drops unknown fields and records confirmation without newer readiness fields.
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare(
          "UPDATE update_runs SET origin_json = '{}', after_json = json_remove(after_json, '$.buildId'), verification_json = json_remove(verification_json, '$.channelsReady', '$.readyz', '$.settled') WHERE run_id = ?",
        )
        .run(run.runId);
      const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
      await upsertSessionEntryCore(newer, { sessionId: "after-upgrade", updatedAt: 2 });
      const config = await fs.readFile(state.configPath, "utf8");
      const next = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const runtime = output();

      await withUpdateCommandExecutor(next.runId, async (executor) => {
        const executorFence = await executor.enter(installRoot);
        await resolveCompletedDoctorUpdateRecovery({ installRoot, executorFence, runtime });
        await expect(assertNoUnresolvedUpdateRecoveryBackup()).resolves.toBeUndefined();
        executorFence.assertCurrent();
      });

      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-upgrade");
      expect(await fs.readFile(state.configPath, "utf8")).toBe(config);
      expect(getUpdateRun(next.runId)?.status).toBe("running");
      expect(getUpdateRun(run.runId)).toMatchObject({
        status: "succeeded",
        origin: { updateRecoveryCapture: { retirement: { outcome: "committed" } } },
      });
      await expect(fs.lstat(ref.directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(runtime.log).toHaveBeenCalledWith(
        `Resolved update capture retired: ${ref.manifestPath}`,
      );
    });
  });

  it.each([
    "unfinished Doctor",
    "unverified repair",
    "mismatched build",
    "readyz",
    "settled",
    "channelsReady",
    "restored",
    "restore-failed",
    "another install",
  ] as const)(
    "retains %s captures for explicit recovery when the next updater is admitted",
    async (scenario) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        await prepareState(state);
        const installRoot = state.path("install");
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const ref = await createUpdateRecoveryBackup({
          ...authority,
          runId: run.runId,
          installRoot,
        });
        if (scenario === "unfinished Doctor") {
          recordUpdateRunRecoveryCapture(
            run.runId,
            { manifestSha256: ref.manifestSha256, doctorCompleted: true },
            () => authority.assertOwned(),
          );
        } else if (scenario === "another install") {
          recordVerifiedCompletion(run.runId);
        } else if (scenario === "unverified repair") {
          finishUpdateRun(run.runId, { status: "succeeded" });
        } else if (scenario === "mismatched build") {
          recordVerifiedCompletion(run.runId);
          recordUpdateRunVerification(run.runId, { runningBuildId: "another-build" });
        } else if (
          scenario === "readyz" ||
          scenario === "settled" ||
          scenario === "channelsReady"
        ) {
          recordVerifiedCompletion(run.runId);
          recordUpdateRunVerification(run.runId, { [scenario]: false });
        } else {
          await writeUpdateRecoveryBackupOutcome(ref, { status: scenario }, authority);
          finishUpdateRun(run.runId, { status: "failed" });
        }
        const original = getUpdateRun(run.runId);
        const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
        await upsertSessionEntryCore(newer, { sessionId: "after-capture", updatedAt: 2 });
        const next = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const selectedRoot = scenario === "another install" ? state.path("elsewhere") : installRoot;

        await withUpdateCommandExecutor(next.runId, async (executor) => {
          const executorFence = await executor.enter(selectedRoot);
          await resolveCompletedDoctorUpdateRecovery({
            installRoot: selectedRoot,
            executorFence,
            runtime: output(),
          });
          await expect(assertNoUnresolvedUpdateRecoveryBackup()).rejects.toThrow(
            /another protected mutation is refused.*openclaw update status --json.*npx openclaw@latest doctor --fix/s,
          );
        });

        expect(getUpdateRun(run.runId)).toEqual(original);
        expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-capture");
        await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId: run.runId });
      });
    },
  );

  it("keeps a completed capture while its prior owner is still alive", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const installRoot = state.path("install");
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot,
      });
      recordVerifiedCompletion(run.runId);
      const next = createUpdateRun({ trigger: "cli" }, { env: state.env });
      vi.spyOn(updateRunDriver, "inspectUpdateRunDriver").mockReturnValue("alive");

      await withUpdateCommandExecutor(next.runId, async (executor) => {
        const executorFence = await executor.enter(installRoot);
        await expect(
          resolveCompletedDoctorUpdateRecovery({ installRoot, executorFence, runtime: output() }),
        ).rejects.toThrow("live or unobservable owner");
        executorFence.assertCurrent();
      });

      await expect(fs.lstat(path.join(ref.directory, "outcome.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId: run.runId });
    });
  });

  it.each([
    { extra: undefined, marked: false },
    { extra: "requested", marked: false },
    { extra: "openclaw doctor", marked: true },
  ] as const)(
    "binds legacy Doctor capture to its active step and parent (extra=$extra, marked=$marked)",
    async ({ extra, marked }) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const original = await prepareState(state);
        // Exercise this fixture's installation, not the development checkout's
        // dependency/build inventory. Capacity accounting itself remains real.
        vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(
          state.path("install"),
        );
        const current = createUpdateRun({ trigger: "cli" }, { env: state.env });
        recordUpdateRunStep(
          current.runId,
          {
            step: "openclaw doctor",
            status: "in_progress",
            startedAtMs: Date.now(),
          },
          { env: state.env },
        );
        const other = extra ? createUpdateRun({ trigger: "cli" }, { env: state.env }) : undefined;
        if (other && extra === "openclaw doctor") {
          recordUpdateRunStep(
            other.runId,
            {
              step: extra,
              status: "in_progress",
              startedAtMs: Date.now(),
            },
            { env: state.env },
          );
        }
        const unrelated = other && getUpdateRun(other.runId, { env: state.env });
        expect(getUpdateRun(current.runId, { env: state.env })?.origin).toEqual({});
        const migrated = {
          agentId: "main",
          sessionKey: "agent:main:legacy-migration",
          env: state.env,
        };
        vi.spyOn(doctorHealth, "runDoctorHealthFlow").mockImplementationOnce(async () => {
          await upsertSessionEntryCore(migrated, { sessionId: "migration-created", updatedAt: 2 });
          throw new Error("synthetic legacy Doctor migration failure");
        });
        await withEnvAsync(
          {
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            [UPDATE_RUN_ID_ENV]: marked ? current.runId : undefined,
          },
          async () => {
            await expect(
              doctorCommand(output(), { repair: true, nonInteractive: true }),
            ).rejects.toThrow("Rollback publication is unavailable");
          },
        );
        const captures = await inspectUpdateRecoveryBackups();
        expect(captures).toHaveLength(1);
        const capture = captures[0];
        expect(capture?.runId).toBe(current.runId);
        if (!capture) {
          throw new Error("Expected the legacy Doctor recovery capture");
        }
        const manifest = await verifyUpdateRecoveryBackup(capture.ref);
        expect(manifest.drivers).toContainEqual({
          host: hostname(),
          pid: process.ppid,
          startIdentity: expect.stringMatching(/^\d+$/),
        });
        expect(loadSessionEntryReadOnly(migrated)?.sessionId).toBe("migration-created");
        expect(getUpdateRun(current.runId)?.origin.updateRecoveryCapture?.restored).not.toBe(true);
        expect(capture.captureStatus).toBe("restore-failed");
        for (const generation of ["candidate", "prepared"]) {
          expect(
            (await fs.stat(path.join(capture.ref.directory, generation, "manifest.json"))).isFile(),
          ).toBe(true);
        }
        expect(loadSessionEntryReadOnly(original)?.sessionId).toBe("before-update");
        expect(listUpdateRuns({}, { env: state.env })).toHaveLength(other ? 2 : 1);
        if (other) {
          expect(getUpdateRun(other.runId, { env: state.env })).toEqual(unrelated);
        }
      });
    },
  );

  it.each(["no Doctor", "completed Doctor", "two Doctors", "wrong marker"] as const)(
    "refuses uncorrelated legacy capture before migration: %s",
    async (scenario) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const original = await prepareState(state);
        const current = createUpdateRun({ trigger: "cli" }, { env: state.env });
        if (scenario !== "no Doctor") {
          recordUpdateRunStep(
            current.runId,
            {
              step: "openclaw doctor",
              status: scenario === "completed Doctor" ? "completed" : "in_progress",
              startedAtMs: Date.now(),
            },
            { env: state.env },
          );
        }
        if (scenario === "two Doctors") {
          const other = createUpdateRun({ trigger: "cli" }, { env: state.env });
          recordUpdateRunStep(
            other.runId,
            {
              step: "openclaw doctor",
              status: "in_progress",
              startedAtMs: Date.now(),
            },
            { env: state.env },
          );
        }
        const before = listUpdateRuns({}, { env: state.env });
        const config = await fs.readFile(state.configPath, "utf8");
        const flow = vi.spyOn(doctorHealth, "runDoctorHealthFlow");
        await withEnvAsync(
          {
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            [UPDATE_RUN_ID_ENV]: scenario === "wrong marker" ? "missing-update-run" : undefined,
          },
          async () => {
            await expect(
              doctorCommand(output(), { repair: true, nonInteractive: true }),
            ).rejects.toThrow(/identify.*openclaw update status --json/s);
          },
        );
        expect(flow).not.toHaveBeenCalled();
        expect(await inspectUpdateRecoveryBackups()).toEqual([]);
        expect(listUpdateRuns({}, { env: state.env })).toEqual(before);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(config);
        expect(loadSessionEntryReadOnly(original)?.sessionId).toBe("before-update");
      });
    },
  );

  it("reports retained captures during plain Doctor without restoring or publishing outcomes", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      finishUpdateRun(run.runId, { status: "failed" }, { env: state.env });
      const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
      await upsertSessionEntryCore(newer, { sessionId: "after-failure", updatedAt: 2 });
      const savedRun = getUpdateRun(run.runId, { env: state.env });
      const config = await fs.readFile(state.configPath, "utf8");
      const manifest = await fs.readFile(ref.manifestPath, "utf8");
      const runtime = output();

      await doctorCommand(runtime, { nonInteractive: true });

      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(ref.manifestPath));
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("openclaw update status --json"),
      );
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("npx openclaw@latest doctor --fix"),
      );
      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-failure");
      expect(getUpdateRun(run.runId, { env: state.env })).toEqual(savedRun);
      expect(await fs.readFile(state.configPath, "utf8")).toBe(config);
      expect(await fs.readFile(ref.manifestPath, "utf8")).toBe(manifest);
      await expect(fs.lstat(path.join(ref.directory, "outcome.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId: run.runId });
    });
  });
  it("resumes interrupted terminal capture retirement through Doctor without restoring newer sessions", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      finishUpdateRun(run.runId, { status: "succeeded" }, { env: state.env });
      await writeUpdateRecoveryBackupOutcome(ref, { status: "committed" }, authority);
      const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
      await upsertSessionEntryCore(newer, { sessionId: "after-terminal-update", updatedAt: 2 });
      const rmdir = fs.rmdir;
      const interruption = vi.spyOn(fs, "rmdir").mockImplementation(async (target) => {
        if (String(target) === ref.directory) {
          throw new Error("synthetic retirement directory removal failure");
        }
        await rmdir(target);
      });
      try {
        await expect(retireUpdateRecoveryBackup(ref, authority)).rejects.toThrow(
          "synthetic retirement directory removal failure",
        );
      } finally {
        interruption.mockRestore();
      }
      expect(await fs.readdir(ref.directory)).toEqual([]);
      const retainedRun = getUpdateRun(run.runId, { env: state.env });
      expect(retainedRun?.origin.updateRecoveryCapture?.retirement).toMatchObject({
        directory: ref.directory,
        outcome: "committed",
      });
      const config = await fs.readFile(state.configPath, "utf8");
      const runtime = output();

      await doctorCommand(runtime, { repair: true, nonInteractive: true });

      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-terminal-update");
      expect(getUpdateRun(run.runId, { env: state.env })).toMatchObject({
        status: "succeeded",
        reason: retainedRun?.reason,
        finishedAtMs: retainedRun?.finishedAtMs,
        origin: { updateRecoveryCapture: retainedRun?.origin.updateRecoveryCapture },
      });
      expect(await fs.readFile(state.configPath, "utf8")).toBe(config);
      await expect(fs.lstat(ref.directory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(path.dirname(ref.directory))).rejects.toMatchObject({ code: "ENOENT" });
      expect(runtime.log).toHaveBeenCalledWith(
        `Resolved update capture retired: ${ref.manifestPath}`,
      );
    });
  });

  it.each(["legacy updater", "manual recovery"] as const)(
    "honors a historical restored receipt when outcome publication failed during %s",
    async (mode) => {
      await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
        const original = await prepareState(state);
        const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
        const ref = await createUpdateRecoveryBackup({
          ...authority,
          runId: run.runId,
          installRoot: state.path("install"),
        });
        // Seed a shipped driver's already-completed restoration. Current Doctor
        // must consume its receipt, never replay a destructive restore to create it.
        recordUpdateRunRecoveryCapture(
          run.runId,
          { manifestSha256: ref.manifestSha256, restored: true },
          authority.assertOwned,
        );
        recordUpdateRunStep(run.runId, {
          step: "state rollback",
          status: "completed",
          endedAtMs: Date.now(),
        });
        const restored = getUpdateRun(run.runId, { env: state.env });
        const link = fs.link;
        const publication = vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
          if (String(to) === path.join(ref.directory, "outcome.json")) {
            throw new Error("synthetic restored outcome publication failure");
          }
          await link(from, to);
        });
        try {
          await expect(
            writeUpdateRecoveryBackupOutcome(ref, { status: "restored" }, authority),
          ).rejects.toThrow("synthetic restored outcome publication failure");
        } finally {
          publication.mockRestore();
        }
        finishUpdateRun(run.runId, { status: "failed" }, { env: state.env });
        if (mode === "legacy updater") {
          // Tagged 9.2 strips unknown origin fields but preserves completed steps.
          openOpenClawStateDatabase({ env: state.env })
            .db.prepare("UPDATE update_runs SET origin_json = '{}' WHERE run_id = ?")
            .run(run.runId);
        }
        await expect(fs.lstat(path.join(ref.directory, "outcome.json"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        const newer = { agentId: "main", sessionKey: "agent:main:after-restore", env: state.env };
        await upsertSessionEntryCore(newer, { sessionId: "after-restored-session", updatedAt: 3 });
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawStateDatabaseForTest();
        const runtime = output();
        await doctorCommand(runtime, { repair: true, nonInteractive: true });
        expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-restored-session");
        expect(loadSessionEntryReadOnly(original)?.sessionId).toBe("before-update");
        expect(restored?.origin.updateRecoveryCapture).toMatchObject({
          manifestSha256: ref.manifestSha256,
          restored: true,
        });
        expect(restored?.steps).toContainEqual(
          expect.objectContaining({ step: "state rollback", status: "completed" }),
        );
        expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("stale"));
        expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(ref.manifestPath));
        await expect(fs.lstat(ref.directory)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it("preserves new sessions after successful update outcome publication fails", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      finishUpdateRun(run.runId, { status: "succeeded" }, { env: state.env });
      const link = fs.link;
      const publication = vi.spyOn(fs, "link").mockImplementation(async (from, to) => {
        if (to === path.join(ref.directory, "outcome.json")) {
          throw new Error("synthetic outcome publication failure");
        }
        await link(from, to);
      });
      try {
        await expect(
          writeUpdateRecoveryBackupOutcome(ref, { status: "committed" }, authority),
        ).rejects.toThrow("synthetic outcome publication failure");
      } finally {
        publication.mockRestore();
      }
      await expect(fs.lstat(path.join(ref.directory, "outcome.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
      await upsertSessionEntryCore(newer, { sessionId: "after-update", updatedAt: 2 });
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabaseForTest();
      const runtime = output();
      await doctorCommand(runtime, { repair: true, nonInteractive: true });
      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-update");
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(ref.manifestPath));
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("stale"));
      await expect(fs.lstat(ref.directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("Resolved update capture retired"),
      );
    });
  });

  it("retains and reports unresolved recovery when three later protected updates are refused", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      await writeUpdateRecoveryBackupOutcome(
        ref,
        { status: "restore-failed", error: "synthetic restore failure" },
        authority,
      );
      finishUpdateRun(run.runId, { status: "failed" }, { env: state.env });
      const configBefore = await fs.readFile(state.configPath, "utf8");
      for (let index = 0; index < 3; index++) {
        const later = createUpdateRun({ trigger: "cli" }, { env: state.env });
        await expect(
          createUpdateRecoveryBackup({
            ...authority,
            runId: later.runId,
            installRoot: state.path("install"),
          }),
        ).rejects.toThrow(
          /another protected mutation is refused.*openclaw update status --json.*npx openclaw@latest doctor --fix/s,
        );
        finishUpdateRun(later.runId, { status: "failed" }, { env: state.env });
        await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId: run.runId });
        expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
      }
      const retained = await inspectUpdateRecoveryBackups();
      expect(retained).toHaveLength(1);
      expect(retained[0]).toMatchObject({
        ref,
        status: "unresolved",
        message: expect.stringContaining(ref.manifestPath),
        nextAction: "npx openclaw@latest doctor --fix",
      });
    });
  });

  it.each([
    { name: "terminal rollback", status: "rolled-back", step: undefined },
    { name: "state restored before later failure", status: "failed", step: "state rollback" },
    {
      name: "generation restored before later failure",
      status: "failed",
      step: "previous generation restoration",
    },
  ] as const)("refuses stale restoration after $name", async ({ status, step }) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      if (step) {
        recordUpdateRunStep(
          run.runId,
          { step, status: "completed", endedAtMs: Date.now() },
          { env: state.env },
        );
      }
      finishUpdateRun(run.runId, { status }, { env: state.env });
      const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
      await upsertSessionEntryCore(newer, { sessionId: "after-recovery", updatedAt: 2 });
      await doctorCommand(output(), { repair: true, nonInteractive: true });
      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("after-recovery");
      await expect(fs.lstat(ref.directory)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("refuses a pending set without its exact ledger run", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const scope = await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare("DELETE FROM update_runs WHERE run_id = ?")
        .run(run.runId);
      const runtime = output();
      await expect(doctorCommand(runtime, { repair: true, nonInteractive: true })).rejects.toThrow(
        "no matching update run exists",
      );
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("openclaw update status --json"),
      );
      expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("before-update");
      await expect(fs.lstat(path.join(ref.directory, "outcome.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId: run.runId });
    });
  });

  it("repairs an unresolved failed update forward without replacing newer sessions", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const original = await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      const migrated = { agentId: "main", sessionKey: "agent:main:migrated", env: state.env };
      await upsertSessionEntryCore(migrated, { sessionId: "migration-created", updatedAt: 2 });
      finishUpdateRun(run.runId, { status: "failed" }, { env: state.env });
      await doctorCommand(output(), { repair: true, nonInteractive: true });
      expect(loadSessionEntryReadOnly(migrated)?.sessionId).toBe("migration-created");
      expect(
        getUpdateRun(run.runId)?.origin.updateRecoveryCapture?.forwardResolution,
      ).toBeDefined();
      expect(getUpdateRun(run.runId)?.status).toBe("failed");
      expect(loadSessionEntryReadOnly(original)?.sessionId).toBe("before-update");
      await expect(verifyUpdateRecoveryBackup(ref)).resolves.toMatchObject({ runId: run.runId });
    });
  });

  it("rechecks settlement after maintenance drains stores before restoration", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await prepareState(state);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const ref = await createUpdateRecoveryBackup({
        ...authority,
        runId: run.runId,
        installRoot: state.path("install"),
      });
      const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
      await upsertSessionEntryCore(newer, { sessionId: "settled-update", updatedAt: 2 });
      finishUpdateRun(run.runId, { status: "failed" }, { env: state.env });
      mocks.afterClose.mockImplementationOnce(async () => {
        await writeUpdateRecoveryBackupOutcome(ref, { status: "committed" }, authority);
      });
      await expect(doctorCommand(output(), { repair: true, nonInteractive: true })).rejects.toThrow(
        "no longer eligible",
      );
      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("settled-update");
      expect(
        JSON.parse(await fs.readFile(path.join(ref.directory, "outcome.json"), "utf8")),
      ).toMatchObject({ status: "committed" });
    });
  });
});
