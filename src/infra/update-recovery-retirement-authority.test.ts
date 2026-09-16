import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { UPDATE_CAPTURE_PRIVACY_MARKER } from "./update-capture-privacy-marker.js";
import {
  createUpdateRecoveryBackup,
  preserveUpdateRecoveryCandidate,
  prepareUpdateRecoveryGeneration,
  verifyUpdateRecoveryBackup,
  retireUpdateRecoveryBackup,
  writeUpdateRecoveryBackupOutcome,
} from "./update-recovery-backup.js";
import { createUpdateRun } from "./update-run-ledger.js";

const temporaryRoot = vi.hoisted(() => vi.fn<() => string>());
vi.mock("./tmp-openclaw-dir.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: temporaryRoot,
}));
afterEach(() => __setFsSafeTestHooksForTest(undefined));

it.each([
  "baseline payload",
  "candidate payload",
  "prepared payload",
  "prepared manifest",
  "baseline manifest",
  "store marker",
  "normal",
] as const)(
  "retains the next retirement artifact after actual executor release: %s",
  async (phase) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      const coordinator = state.path("coordinator");
      const installRoot = state.path("install");
      await fs.mkdir(coordinator);
      await fs.mkdir(installRoot);
      temporaryRoot.mockReturnValue(coordinator);
      await state.writeConfig({ plugins: { enabled: false } });
      const configBefore = await fs.readFile(state.configPath);
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      await withUpdateCommandExecutor(run.runId, async (executor) => {
        const fence = await executor.enter(installRoot, { preflight: true });
        const authority = { assertOwned: () => fence.assertCurrent() };
        const baseline = await createUpdateRecoveryBackup({
          ...authority,
          installRoot,
          runId: run.runId,
        });
        let selected = baseline;
        if (phase.startsWith("candidate") || phase.startsWith("prepared") || phase === "normal") {
          const candidate = await preserveUpdateRecoveryCandidate(baseline, authority);
          selected =
            phase.startsWith("prepared") || phase === "normal"
              ? await prepareUpdateRecoveryGeneration(baseline, candidate, authority)
              : candidate;
        }
        const manifest = await verifyUpdateRecoveryBackup(selected);
        const first = manifest.entries.find((entry) => entry.kind === "file");
        if (first?.kind !== "file") throw new Error("Missing retirement payload fixture");
        const target =
          phase === "store marker"
            ? path.join(path.dirname(baseline.directory), UPDATE_CAPTURE_PRIVACY_MARKER)
            : phase.endsWith("manifest")
              ? selected.manifestPath
              : path.join(selected.directory, first.archivePath);
        const before = await fs.readFile(target);
        await writeUpdateRecoveryBackupOutcome(baseline, { status: "committed" }, authority);
        let revoked = false;
        __setFsSafeTestHooksForTest({
          async beforeRootFallbackMutation(operation, filename) {
            if (phase !== "normal" && operation === "remove" && filename === target && !revoked) {
              // Release the real lease/WeakMap owner after fs-safe has begun its
              // asynchronous preparation, immediately before its final effect.
              releaseUpdateCommandPreflightForHandoff(fence);
              revoked = true;
              await Promise.resolve();
            }
          },
        });
        try {
          if (phase === "normal") {
            await retireUpdateRecoveryBackup(baseline, authority);
            expect(revoked).toBe(false);
            await expect(fs.lstat(baseline.directory)).rejects.toMatchObject({ code: "ENOENT" });
          } else {
            await expect(retireUpdateRecoveryBackup(baseline, authority)).rejects.toThrow();
            expect(revoked).toBe(true);
            expect(fence.assertCurrent).toThrow();
            expect(await fs.readFile(target)).toEqual(before);
          }
          expect(await fs.readFile(state.configPath)).toEqual(configBefore);
        } finally {
          __setFsSafeTestHooksForTest(undefined);
        }
      });
    });
  },
);
