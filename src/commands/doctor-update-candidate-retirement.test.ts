import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createUpdateCommandBackup } from "../cli/update-cli/update-command-backup-lifecycle.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as packageRoot from "../infra/openclaw-root.js";
import * as temporaryRoot from "../infra/tmp-openclaw-dir.js";
import { verifyUpdateRecoveryBackup } from "../infra/update-recovery-backup.js";
import * as drivers from "../infra/update-run-driver.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../infra/update-run-ledger.js";
import { defaultRuntime } from "../runtime.js";
import {
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../state/openclaw-agent-db-lease.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reconcileCandidateUpdateCaptureRetirement } from "./doctor-update-candidate-retirement.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  "settled",
  "parent-alive",
  "executor-settling",
  "parent-unknown",
  "readiness-missing",
  "current-parent",
  "wrong-runtime",
  "late-writer",
  "cancelled",
] as const)(
  "reconciles legacy capture only after parent settlement with live authority: %s",
  async (scenario) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await state.writeConfig({ plugins: { enabled: false } });
      const root = state.path("install");
      await fs.mkdir(root);
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: scenario === "wrong-runtime" ? "2026.9.3" : "2026.9.4",
        }),
      );
      const temporary = state.path("coordinator");
      await fs.mkdir(temporary, { mode: 0o700 });
      vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(temporary);
      vi.spyOn(packageRoot, "resolveOpenClawPackageRoot").mockResolvedValue(root);
      const run = {
        runId: createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
        env: state.env,
      };
      const backup = await withUpdateCommandExecutor(run.runId, async (executor) =>
        createUpdateCommandBackup({
          opts: { run: { ...run, executorFence: await executor.enter(root) } },
          root,
          env: state.env,
        }),
      );
      const manifestBytes = await fs.readFile(backup.manifestPath);
      if (scenario !== "current-parent") {
        recordUpdateRunStep(run.runId, {
          step: "finalize:capture-retirement",
          status: "completed",
          detail: "candidate-reconciliation-v1",
        });
      }
      recordUpdateRunStep(run.runId, { step: "post-update verification", status: "completed" });
      recordUpdateRunStep(run.runId, { step: "gateway verification", status: "completed" });
      recordUpdateRunVerification(run.runId, {
        serviceRunning: true,
        versionMatch: true,
        runningVersion: "2026.9.4",
        readyz: scenario !== "readiness-missing",
        settled: true,
        channelsReady: true,
        pluginErrors: [],
      });
      finishUpdateRun(run.runId, { status: "succeeded", after: { version: "2026.9.4" } });
      const liveness = vi
        .spyOn(drivers, "inspectUpdateRunDriver")
        .mockReturnValue(
          scenario === "parent-alive"
            ? "alive"
            : scenario === "parent-unknown"
              ? "unknown"
              : "dead",
        );
      const lateLease =
        scenario === "late-writer"
          ? claimOpenClawAgentDatabaseLease({
              agentId: "independent",
              path: state.path("late.sqlite"),
              env: state.env,
            })
          : undefined;
      const controller = new AbortController();
      if (scenario === "cancelled") {
        controller.abort();
      }
      const runtime = { ...defaultRuntime, log: vi.fn(), error: vi.fn() };
      try {
        const reconcile = () =>
          reconcileCandidateUpdateCaptureRetirement({
            runtime,
            signal: controller.signal,
          });
        const pending =
          scenario === "executor-settling"
            ? await withUpdateCommandExecutor("settling-helper", async (executor) => {
                await executor.enter(root);
                return await reconcile();
              })
            : await reconcile();
        expect(pending).toBe(scenario === "parent-alive" || scenario === "executor-settling");
        if (scenario === "settled") {
          await expect(fs.stat(backup.directory)).rejects.toMatchObject({ code: "ENOENT" });
          expect(runtime.error).not.toHaveBeenCalled();
        } else {
          expect(await fs.readFile(backup.manifestPath)).toEqual(manifestBytes);
          await expect(verifyUpdateRecoveryBackup(backup)).resolves.toMatchObject({
            runId: run.runId,
          });
        }
        if (scenario === "parent-alive" || scenario === "executor-settling") {
          liveness.mockReturnValue("dead");
          expect(
            await reconcileCandidateUpdateCaptureRetirement({ runtime, signal: controller.signal }),
          ).toBe(false);
          await expect(fs.stat(backup.directory)).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        if (lateLease) {
          releaseOpenClawAgentDatabaseLease(lateLease, { env: state.env });
        }
      }
    });
  },
);
