import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  createUpdateRecoveryBackup,
  restoreUpdateRecoveryBackup,
  verifyUpdateRecoveryBackup,
} from "./update-recovery-backup.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunDiagnostic,
  recordUpdateRunRecoveryCapture,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";

const temporaryRoot = vi.hoisted(() => vi.fn<() => string>());
vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: temporaryRoot,
}));

it("refuses baseline restoration without losing post-capture history or newer failed runs", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    const coordinator = state.path("coordinator");
    const installRoot = state.path("install");
    await fs.mkdir(coordinator);
    await fs.mkdir(installRoot);
    temporaryRoot.mockReturnValue(coordinator);
    await state.writeConfig({
      agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
    });
    const authority = { assertOwned() {} };
    const options = { env: state.env };
    const run = createUpdateRun({ trigger: "cli" }, options);
    const baseline = await createUpdateRecoveryBackup({
      ...authority,
      installRoot,
      runId: run.runId,
    });
    const baselineBytes = await fs.readFile(baseline.manifestPath);
    recordUpdateRunRecoveryCapture(
      run.runId,
      { manifestSha256: baseline.manifestSha256 },
      authority.assertOwned,
      options,
    );
    recordUpdateRunStep(
      run.runId,
      {
        step: "post-capture-diagnostic",
        status: "completed",
        detail: "retained operator evidence",
      },
      options,
    );
    recordUpdateRunVerification(
      run.runId,
      {
        booted: true,
        serviceRunning: true,
        versionMatch: false,
        runningVersion: "2026.9.4",
      },
      options,
    );
    finishUpdateRun(run.runId, { status: "failed", reason: "version-mismatch" }, options);
    recordUpdateRunDiagnostic(run.runId, "late child exit after capture", options);
    const newer = createUpdateRun({ trigger: "cli" }, options);
    finishUpdateRun(newer.runId, { status: "failed", reason: "newer-failed-operation" }, options);
    const databasePath = state.statePath("state", "openclaw.sqlite");
    const readHistory = () => {
      closeOpenClawStateDatabaseForTest();
      const db = new (requireNodeSqlite().DatabaseSync)(databasePath, { readOnly: true });
      try {
        return db.prepare("SELECT * FROM update_runs ORDER BY run_id").all();
      } finally {
        db.close();
      }
    };
    const history = readHistory();
    expect(history).toHaveLength(2);
    let refusal: unknown;
    try {
      await restoreUpdateRecoveryBackup(baseline, authority);
    } catch (error) {
      refusal = error;
    }
    expect
      .soft(readHistory(), "every complete ledger row must survive recovery admission")
      .toEqual(history);
    expect.soft(refusal).toBeInstanceOf(Error);
    expect.soft(String(refusal)).toContain("Rollback publication is unavailable");
    expect(await fs.readFile(baseline.manifestPath)).toEqual(baselineBytes);
    await verifyUpdateRecoveryBackup(baseline);
  });
});
