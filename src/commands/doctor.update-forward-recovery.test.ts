import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as health from "../flows/doctor-health.js";
import {
  assertNoUnresolvedUpdateRecoveryBackup,
  createUpdateRecoveryBackup,
  preserveUpdateRecoveryCandidate,
  prepareUpdateRecoveryGeneration,
  inspectUpdateRecoveryBackups,
  verifyUpdateRecoveryBackup,
} from "../infra/update-recovery-backup.js";
import { prepareUpdateRecoveryForwardResolution } from "../infra/update-recovery-forward.js";
import {
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  recordUpdateRunRecoveryCapture,
} from "../infra/update-run-ledger.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import * as readiness from "../state/openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as preparation from "../state/openclaw-state-recovery-preparation.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { doctorCommand } from "./doctor.js";

const coordinator = vi.hoisted(() => vi.fn<() => string>());
vi.mock("../infra/tmp-openclaw-dir.js", async (original) => ({
  ...(await original<typeof import("../infra/tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: coordinator,
}));
vi.mock("../infra/update-run-driver.js", async (original) => ({
  ...(await original<typeof import("../infra/update-run-driver.js")>()),
  inspectUpdateRunDriver: () => "dead",
}));
vi.mock("../flows/doctor-health.js", () => ({ runDoctorHealthFlow: async () => {} }));
vi.mock("./doctor-maintenance.js", () => ({
  beginDoctorMaintenance: async () => ({
    assertCurrent() {},
    closeStores: async () => {
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabaseForTest();
    },
    release: async () => {},
  }),
}));
afterEach(() => vi.restoreAllMocks());
const authority = { assertOwned: () => {} };
function runtime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit(code) {
      throw new ExitError(code);
    },
  };
}
async function setup(state: OpenClawTestState) {
  await fs.mkdir(state.path("coordinator"));
  coordinator.mockReturnValue(state.path("coordinator"));
  await state.writeConfig({
    agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
    plugins: { enabled: false },
  });
  const old = { agentId: "main", sessionKey: "agent:main:old", env: state.env };
  await upsertSessionEntryCore(old, { sessionId: "before-failure", updatedAt: 1 });
  const installRoot = state.path("install");
  await fs.mkdir(installRoot);
  const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
  const ref = await createUpdateRecoveryBackup({ ...authority, runId: run.runId, installRoot });
  finishUpdateRun(run.runId, { status: "failed", reason: "retained original failure" });
  const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
  await upsertSessionEntryCore(newer, { sessionId: "must-survive-forward-repair", updatedAt: 2 });
  return { ref, run, newer, installRoot };
}

it("repairs forward through Doctor then admits a second protected update without deleting newer data or captures", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    const { ref, run, newer, installRoot } = await setup(state);
    const manifest = await fs.readFile(ref.manifestPath);
    await expect(assertNoUnresolvedUpdateRecoveryBackup()).rejects.toThrow(
      "another protected mutation",
    );
    await doctorCommand(runtime(), { repair: true, nonInteractive: true });
    expect(getUpdateRun(run.runId)).toMatchObject({
      status: "failed",
      origin: { updateRecoveryCapture: { forwardResolution: { kind: "forward-resolved" } } },
    });
    expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("must-survive-forward-repair");
    expect(await fs.readFile(ref.manifestPath)).toEqual(manifest);
    expect(await inspectUpdateRecoveryBackups()).toEqual([
      expect.objectContaining({ status: "forward-resolved", terminalOutcome: undefined }),
    ]);
    const next = createUpdateRun({ trigger: "cli" }, { env: state.env });
    await withUpdateCommandExecutor(next.runId, async (executor) => {
      const fence = await executor.enter(installRoot);
      const second = await createUpdateRecoveryBackup({
        runId: next.runId,
        installRoot,
        assertOwned: () => fence.assertCurrent(),
      });
      expect(second.directory).not.toBe(ref.directory);
      await verifyUpdateRecoveryBackup(second);
      fence.assertCurrent();
    });
    expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("must-survive-forward-repair");
    expect(getUpdateRun(run.runId)?.status).toBe("failed");
    expect(await fs.readFile(ref.manifestPath)).toEqual(manifest);
  });
});

it("does not resolve a partial Doctor repair or restore over newer data", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    const { run, newer } = await setup(state);
    vi.spyOn(health, "runDoctorHealthFlow").mockRejectedValueOnce(new Error("partial repair"));
    await expect(doctorCommand(runtime(), { repair: true, nonInteractive: true })).rejects.toThrow(
      "partial repair",
    );
    expect(
      getUpdateRun(run.runId)?.origin.updateRecoveryCapture?.forwardResolution,
    ).toBeUndefined();
    expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("must-survive-forward-repair");
    await expect(assertNoUnresolvedUpdateRecoveryBackup()).rejects.toThrow(
      "another protected mutation",
    );
  });
});

it.each(["missing", "wrong-baseline", "changed-run", "new-generation"] as const)(
  "refuses %s forward-resolution evidence before another protected update",
  async (fault) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const { ref, run } = await setup(state);
      await doctorCommand(runtime(), { repair: true, nonInteractive: true });
      if (fault === "new-generation") {
        await fs.mkdir(path.join(ref.directory, "candidate"));
        await fs.writeFile(path.join(ref.directory, "candidate", "manifest.json"), "{}");
      } else if (fault === "changed-run") {
        openOpenClawStateDatabase()
          .db.prepare("UPDATE update_runs SET status = ? WHERE run_id = ?")
          .run("rolled-back", run.runId);
      } else {
        const record = getUpdateRun(run.runId);
        if (!record?.origin.updateRecoveryCapture?.forwardResolution) {
          throw new Error("Missing successful repair");
        }
        if (fault === "missing") {
          delete record.origin.updateRecoveryCapture.forwardResolution;
        } else {
          record.origin.updateRecoveryCapture.forwardResolution.binding.manifestSha256 = "0".repeat(
            64,
          );
        }
        openOpenClawStateDatabase()
          .db.prepare("UPDATE update_runs SET origin_json = ? WHERE run_id = ?")
          .run(JSON.stringify(record.origin), run.runId);
      }
      await expect(assertNoUnresolvedUpdateRecoveryBackup()).rejects.toThrow();
      expect(await fs.readFile(ref.manifestPath, "utf8")).toContain(run.runId);
    });
  },
);

it.each(["readiness", "lost-claim"] as const)(
  "does not publish forward settlement after %s failure",
  async (fault) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const { ref, run, newer, installRoot } = await setup(state);
      await fs.writeFile(
        path.join(installRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "test" }),
      );
      let owned = true;
      const repairRoot = fileURLToPath(new URL("../../", import.meta.url));
      const complete = await prepareUpdateRecoveryForwardResolution(ref, repairRoot, {
        assertOwned() {
          if (!owned) {
            throw new Error("lost maintenance claim");
          }
        },
      });
      if (fault === "lost-claim") {
        owned = false;
      } else {
        vi.spyOn(readiness, "assertOpenClawDatabasesReady").mockRejectedValueOnce(
          new Error("current schema is not ready"),
        );
      }
      await expect(complete()).rejects.toThrow(
        fault === "lost-claim" ? "lost maintenance claim" : "current schema is not ready",
      );
      expect(
        getUpdateRun(run.runId)?.origin.updateRecoveryCapture?.forwardResolution,
      ).toBeUndefined();
      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("must-survive-forward-repair");
      await expect(assertNoUnresolvedUpdateRecoveryBackup()).rejects.toThrow(
        "another protected mutation",
      );
    });
  },
);

it("repairs forward after a completed Doctor step without granting reverse-restoration selection", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    const { ref, run, newer } = await setup(state);
    recordUpdateRunRecoveryCapture(
      run.runId,
      {
        manifestSha256: ref.manifestSha256,
        doctorCompleted: true,
      },
      authority.assertOwned,
    );
    expect(await inspectUpdateRecoveryBackups()).toEqual([
      expect.objectContaining({ status: "ambiguous" }),
    ]);
    await doctorCommand(runtime(), { repair: true, nonInteractive: true });
    expect(getUpdateRun(run.runId)).toMatchObject({
      status: "failed",
      reason: "retained original failure",
      origin: {
        updateRecoveryCapture: {
          doctorCompleted: true,
          forwardResolution: { kind: "forward-resolved" },
        },
      },
    });
    await expect(assertNoUnresolvedUpdateRecoveryBackup()).resolves.toBeUndefined();
    expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("must-survive-forward-repair");
    expect(await fs.readFile(ref.manifestPath, "utf8")).toContain(run.runId);
  });
});

it.each(["missing", "empty", "truncated"] as const)(
  "repairs forward after interrupted generation preparation with a %s manifest without deleting retained artifacts",
  async (manifestState) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const { ref, run, newer } = await setup(state);
      const candidate = await preserveUpdateRecoveryCandidate(ref, authority);
      const interrupted = new Error("reverse preparation interrupted");
      const prepare = vi
        .spyOn(preparation, "prepareOpenClawStateRecoveryCopy")
        .mockRejectedValueOnce(interrupted);
      await expect(prepareUpdateRecoveryGeneration(ref, candidate, authority)).rejects.toBe(
        interrupted,
      );
      prepare.mockRestore();
      const incomplete = path.join(ref.directory, "prepared");
      await expect(fs.lstat(path.join(incomplete, "manifest.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const partialManifest = manifestState === "empty" ? "" : '{"schemaVersion":2,';
      if (manifestState !== "missing") {
        await fs.writeFile(path.join(incomplete, "manifest.json"), partialManifest);
      }
      const evidence = path.join(incomplete, "interrupted-payload");
      await fs.writeFile(evidence, "first\n");
      const retained = await fs.readdir(incomplete, { recursive: true });
      expect(retained.length).toBeGreaterThan(0);
      await doctorCommand(runtime(), { repair: true, nonInteractive: true });
      expect(getUpdateRun(run.runId)).toMatchObject({
        status: "failed",
        reason: "retained original failure",
        origin: { updateRecoveryCapture: { forwardResolution: { kind: "forward-resolved" } } },
      });
      expect(loadSessionEntryReadOnly(newer)?.sessionId).toBe("must-survive-forward-repair");
      expect(await fs.readdir(incomplete, { recursive: true })).toEqual(retained);
      if (manifestState !== "missing") {
        expect(await fs.readFile(path.join(incomplete, "manifest.json"), "utf8")).toBe(
          partialManifest,
        );
      }
      expect(await fs.readFile(evidence, "utf8")).toBe("first\n");
      await verifyUpdateRecoveryBackup(ref);
      await verifyUpdateRecoveryBackup(candidate);
      await expect(assertNoUnresolvedUpdateRecoveryBackup()).resolves.toBeUndefined();
      // A later edit to the incomplete evidence invalidates the receipt, just as a changed seal does.
      await fs.writeFile(evidence, "later\n");
      await expect(assertNoUnresolvedUpdateRecoveryBackup()).rejects.toThrow("stale");
      expect(await fs.readFile(evidence, "utf8")).toBe("later\n");
    });
  },
);
