import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as metadata from "../infra/update-recovery-backup-metadata.js";
import {
  assertNoUnresolvedUpdateRecoveryBackup,
  createUpdateRecoveryBackup,
  preserveUpdateRecoveryCandidate,
  prepareUpdateRecoveryGeneration,
} from "../infra/update-recovery-backup.js";
import { prepareUpdateRecoveryForwardResolution } from "../infra/update-recovery-forward.js";
import * as runtimeIdentity from "../infra/update-recovery-repair-runtime.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../infra/update-run-ledger.js";
import * as ledger from "../infra/update-run-ledger.js";
import * as readiness from "../state/openclaw-database-preflight.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const coordinator = vi.hoisted(() => vi.fn<() => string>());
vi.mock("../infra/tmp-openclaw-dir.js", async (original) => ({
  ...(await original<typeof import("../infra/tmp-openclaw-dir.js")>()),
  resolvePreferredOpenClawTmpDir: coordinator,
}));
vi.mock("../infra/update-run-driver.js", async (original) => ({
  ...(await original<typeof import("../infra/update-run-driver.js")>()),
  inspectUpdateRunDriver: () => "dead",
}));
afterEach(() => vi.restoreAllMocks());
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function inventory(root: string) {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(file);
      } else {
        files[path.relative(root, file)] = hash(fs.readFileSync(file));
      }
    }
  };
  walk(root);
  return files;
}
function replacement(file: string, aside: string) {
  fs.renameSync(file, aside);
  fs.cpSync(aside, file, { recursive: true });
}

it.each([
  "root",
  "dist",
  "code",
  "code-inode",
  "build",
  "node",
  "node-content",
  "late-code",
  "unchanged",
])(
  "binds forward repair artifacts and refuses %s replacement without changing failed B/C/T",
  async (fault) => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      fs.mkdirSync(state.path("coordinator"));
      coordinator.mockReturnValue(state.path("coordinator"));
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
      });
      const root = state.path("repair");
      const installRoot = state.path("failed-install");
      fs.mkdirSync(installRoot);
      fs.mkdirSync(path.join(root, "dist"), { recursive: true });
      fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"same"}');
      const code = path.join(root, "dist/forward.mjs");
      const entry = path.join(root, "dist/doctor.mjs");
      const build = path.join(root, "dist/build-info.json");
      const node = state.path("private-node-identity");
      fs.writeFileSync(code, "export const generation = 1;");
      fs.writeFileSync(entry, "export const doctor = 1;");
      fs.writeFileSync(build, '{"commit":"same-build"}');
      fs.writeFileSync(node, "private executable identity fixture");
      const originalCapture = runtimeIdentity.captureUpdateRecoveryRepairRuntime;
      const readRuntime = () =>
        originalCapture(root, pathToFileURL(code).href, pathToFileURL(entry).href, node);
      const expectedRuntime = readRuntime();
      // The artifact-location seam uses real physical/content capture on private
      // files. The forward owner, ledger, generations and executor fence are real.
      // Actual emitted Doctor/module URLs remain a separate built-entry proof gate.
      vi.spyOn(runtimeIdentity, "captureUpdateRecoveryRepairRuntime").mockImplementation(
        (_root, moduleUrl, entryUrl) => {
          expect(moduleUrl).toContain("update-recovery-forward");
          expect(entryUrl).toBe(moduleUrl);
          return readRuntime();
        },
      );
      // Seed the agent database before B; newer session rows remain post-capture writes.
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:baseline", env: state.env },
        { sessionId: "baseline-session", updatedAt: 1 },
      );
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      await withUpdateCommandExecutor(randomUUID(), async (executor) => {
        const fence = await executor.enter(installRoot);
        const authority = { assertOwned: () => fence.assertCurrent() };
        const ref = await createUpdateRecoveryBackup({
          ...authority,
          runId: run.runId,
          installRoot,
        });
        finishUpdateRun(run.runId, { status: "failed", reason: "preserve exact failure" });
        const newer = { agentId: "main", sessionKey: "agent:main:newer", env: state.env };
        await upsertSessionEntryCore(newer, { sessionId: "newer-must-survive", updatedAt: 2 });
        const candidate = await preserveUpdateRecoveryCandidate(ref, authority);
        const prepared = await prepareUpdateRecoveryGeneration(ref, candidate, authority);
        const failed = getUpdateRun(run.runId);
        const generations = inventory(ref.directory);
        const newerRow = loadSessionEntryReadOnly(newer);
        const packageBytes = fs.readFileSync(path.join(root, "package.json"));
        const complete = await prepareUpdateRecoveryForwardResolution(ref, root, authority);
        const mutate = () => {
          if (fault === "root") {
            replacement(root, state.path("held-root"));
          } else if (fault === "dist") {
            replacement(path.join(root, "dist"), state.path("held-dist"));
          } else if (fault === "code-inode") {
            replacement(code, state.path("held-code"));
          } else if (fault === "node") {
            replacement(node, state.path("held-node"));
          } else if (fault === "build") {
            fs.writeFileSync(build, '{"commit":"other-build"}');
          } else if (fault === "node-content") {
            fs.writeFileSync(node, "changed executable bytes");
          } else if (fault !== "unchanged") {
            fs.writeFileSync(code, "export const generation = 2;");
          }
        };
        const boundaryEvents: string[] = [];
        let mutations = 0;
        let ledgerCallbackRefusals = 0;
        if (fault === "late-code") {
          const originalMetadata = metadata.withRecoveryMetadata;
          const originalRecord = ledger.recordUpdateRunRecoveryCapture;
          const originalCode = fs.readFileSync(code);
          let armed = false;
          let metadataDepth = 0;
          let outerSelected = false;
          let nestedPinsResolved = 0;
          const ready = readiness.assertOpenClawDatabasesReady;
          vi.spyOn(readiness, "assertOpenClawDatabasesReady").mockImplementation(
            async (...args) => {
              await ready(...args);
              armed = true;
              boundaryEvents.push("ready");
            },
          );
          vi.spyOn(metadata, "withRecoveryMetadata").mockImplementation(
            (metadataRef, owner, operation, options) =>
              originalMetadata(
                metadataRef,
                owner,
                async (scope) => {
                  // Select the completion operation, not its nested readBinding. Keep
                  // the actual scope, pin object and authority; delegate every check.
                  const isOuter = armed && metadataDepth === 0;
                  metadataDepth++;
                  const actualAssertCurrent = scope.pin.assertCurrent.bind(scope.pin);
                  if (isOuter) {
                    expect(outerSelected).toBe(false);
                    outerSelected = true;
                    boundaryEvents.push("outer-enter");
                    vi.spyOn(scope.pin, "assertCurrent").mockImplementation(async () => {
                      expect(mutations).toBe(0);
                      expect(nestedPinsResolved).toBe(1);
                      expect(fs.readFileSync(code)).toEqual(originalCode);
                      boundaryEvents.push("outer-pin-enter");
                      await actualAssertCurrent();
                      boundaryEvents.push("outer-pin-resolved");
                      expect(mutations).toBe(0);
                      expect(fs.readFileSync(code)).toEqual(originalCode);
                      armed = false;
                      mutate();
                      mutations++;
                      boundaryEvents.push("mutated");
                    });
                  } else if (armed) {
                    expect(metadataDepth).toBe(2);
                    vi.spyOn(scope.pin, "assertCurrent").mockImplementation(async () => {
                      expect(mutations).toBe(0);
                      expect(fs.readFileSync(code)).toEqual(originalCode);
                      await actualAssertCurrent();
                      expect(mutations).toBe(0);
                      expect(fs.readFileSync(code)).toEqual(originalCode);
                      nestedPinsResolved++;
                      boundaryEvents.push("nested-pin-resolved");
                    });
                  }
                  try {
                    return await operation(scope);
                  } finally {
                    metadataDepth--;
                  }
                },
                options,
              ),
          );
          vi.spyOn(ledger, "recordUpdateRunRecoveryCapture").mockImplementation(
            (runId, patch, assertCurrent, options) => {
              expect(runId).toBe(run.runId);
              expect(patch.forwardResolution).toBeDefined();
              expect(mutations).toBe(1);
              expect(boundaryEvents.at(-1)).toBe("mutated");
              boundaryEvents.push("ledger-enter");
              try {
                // Invoke the real write transaction. It, not this spy, calls the
                // original synchronous settlement guard before merge/persist.
                return originalRecord(
                  runId,
                  patch,
                  () => {
                    boundaryEvents.push("ledger-authority-enter");
                    try {
                      assertCurrent();
                    } catch (error) {
                      expect(error).toBeInstanceOf(Error);
                      expect((error as Error).message).toContain("repair runtime changed");
                      ledgerCallbackRefusals++;
                      boundaryEvents.push("ledger-authority-refused");
                      throw error;
                    }
                  },
                  options,
                );
              } catch (error) {
                boundaryEvents.push("ledger-refused");
                throw error;
              }
            },
          );
        } else {
          mutate();
        }
        if (fault === "unchanged") {
          await complete();
          const after = getUpdateRun(run.runId);
          expect(after?.status).toBe("failed");
          expect(after?.reason).toBe(failed?.reason);
          expect(after?.finishedAtMs).toBe(failed?.finishedAtMs);
          expect(after?.origin.updateRecoveryCapture?.forwardResolution?.repair).toMatchObject(
            expectedRuntime,
          );
          expect(after?.origin.updateRecoveryCapture?.forwardResolution?.binding).toMatchObject({
            candidateSha256: candidate.manifestSha256,
            preparedSha256: prepared.manifestSha256,
          });
          await expect(assertNoUnresolvedUpdateRecoveryBackup()).resolves.toBeUndefined();
        } else {
          await expect(complete()).rejects.toThrow(/runtime/);
          if (fault === "late-code") {
            expect(mutations).toBe(1);
            expect(ledgerCallbackRefusals).toBe(1);
            expect(boundaryEvents).toEqual([
              "ready",
              "outer-enter",
              "nested-pin-resolved",
              "outer-pin-enter",
              "outer-pin-resolved",
              "mutated",
              "ledger-enter",
              "ledger-authority-enter",
              "ledger-authority-refused",
              "ledger-refused",
            ]);
          }
          expect(getUpdateRun(run.runId)).toEqual(failed);
          await expect(assertNoUnresolvedUpdateRecoveryBackup()).rejects.toThrow(
            "another protected mutation",
          );
        }
        expect(fs.readFileSync(path.join(root, "package.json"))).toEqual(packageBytes);
        expect(inventory(ref.directory)).toEqual(generations);
        expect(loadSessionEntryReadOnly(newer)).toEqual(newerRow);
        expect(newerRow?.sessionId).toBe("newer-must-survive");
        fence.assertCurrent();
      });
    });
  },
);
