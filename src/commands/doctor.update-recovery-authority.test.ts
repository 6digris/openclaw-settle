import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUpdateCommandBackup } from "../cli/update-cli/update-command-backup-lifecycle.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  runCoreContributionHealth,
  runStructuredHealthRepairs,
} from "../flows/doctor-health-contribution-core.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import { createDoctorHealthContribution } from "../flows/doctor-health-contribution.js";
import { runDoctorHealthContributionList } from "../flows/doctor-health-contributions.test-support.js";
import { runDoctorHealthRepairs } from "../flows/doctor-repair-flow.js";
import { clearHealthChecksForTest, registerHealthCheck } from "../flows/health-check-registry.js";
import type { DoctorHealthCheck } from "../flows/health-check-runner-types.js";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  noteMainSessionRecoveryIntegrity,
  inspectMainSessionRecoveryEntry,
} from "./doctor-main-session-recovery.js";
import * as maintenanceModule from "./doctor-maintenance.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  captureDoctorUpdateRecoveryGuard,
  prepareDoctorUpdateRecovery,
  withDoctorUpdateRecovery,
} from "./doctor-update-recovery.js";

// Check registration and installation discovery select task-local fixtures. Both
// caller adapters, maintenance, capture, executor and session mutation owners stay real.
const registered = vi.hoisted(() => ({ checks: [] as DoctorHealthCheck[], root: "" }));
vi.mock("../infra/openclaw-root.js", async (original) => ({
  ...(await original<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => registered.root,
}));
vi.mock("../flows/doctor-core-checks.js", () => ({ CORE_HEALTH_CHECKS: registered.checks }));
vi.mock("../flows/bundled-health-checks.js", () => ({ registerBundledHealthChecks() {} }));

const runtime: RuntimeEnv = {
  log() {},
  error() {},
  exit(code) {
    throw new ExitError(code);
  },
};
const beginMaintenance = maintenanceModule.beginDoctorMaintenance;
afterEach(() => {
  vi.restoreAllMocks();
  registered.checks.splice(0);
  clearHealthChecksForTest();
});

async function withPreparedDoctor(
  run: (params: {
    release: () => Promise<void>;
    guard: () => void;
    context: DoctorHealthFlowContext;
    observe: <T>(operation: () => T) => T;
    runInExecutor: <T>(operation: () => T) => T;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      layout: "state-only",
      scenario: "minimal",
      env: { OPENCLAW_SERVICE_REPAIR_POLICY: "external" },
    },
    async (state) => {
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: { workspace: state.workspaceDir } },
        },
        plugins: { enabled: false },
        gateway: { mode: "local" as const },
      };
      await state.writeConfig(cfg);
      const root = state.path("installation");
      registered.root = root;
      await fs.mkdir(path.join(root, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.9.4", type: "module" }),
      );
      await fs.writeFile(path.join(root, "dist", "index.js"), "export {};\n");
      const observed: NonNullable<Awaited<ReturnType<typeof beginMaintenance>>>[] = [];
      vi.spyOn(maintenanceModule, "beginDoctorMaintenance").mockImplementation(async (params) => {
        const owner = await beginMaintenance(params);
        if (owner) {
          observed.push(owner);
        }
        return owner;
      });
      const observe = AsyncLocalStorage.snapshot();
      const record = createUpdateRun({ trigger: "cli" });
      try {
        await withUpdateCommandExecutor(record.runId, async (executor) => {
          const fence = await executor.enter(root);
          const ref = await createUpdateCommandBackup({
            opts: { run: { runId: record.runId, env: state.env, executorFence: fence } },
            root,
            env: state.env,
          });
          // A replacement interval retains executor custody, not the old interval.
          const runInExecutor = AsyncLocalStorage.snapshot();
          const updating = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
          process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
          try {
            await withDoctorUpdateRecovery(runtime, async () => {
              await prepareDoctorUpdateRecovery({
                repair: true,
                updateRecoveryOwner: "driver",
                updateRecoveryBackup: JSON.stringify(ref),
              });
              const owner = observed.at(-1);
              const guard = captureDoctorUpdateRecoveryGuard();
              if (!owner || !guard) {
                throw new Error("real Doctor producer did not bind recovery");
              }
              const options = { repair: true, nonInteractive: true };
              const context: DoctorHealthFlowContext = {
                runtime,
                options,
                prompter: createDoctorPrompter({ runtime, options }),
                configResult: { cfg },
                cfg,
                cfgForPersistence: cfg,
                sourceConfigValid: true,
                configPath: state.configPath,
                env: state.env,
              };
              // Admit resources in the real interval, but keep the fixture's
              // revocation orchestrator outside the interval's pending set: it
              // explicitly releases that same owner while the leaf is suspended.
              let operation: Promise<void> | undefined;
              owner.run(() => {
                operation = run({
                  release: async () => {
                    await owner.release();
                  },
                  guard,
                  context,
                  observe,
                  runInExecutor,
                });
              });
              await operation;
            });
          } finally {
            if (updating === undefined) {
              delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
            } else {
              process.env.OPENCLAW_UPDATE_IN_PROGRESS = updating;
            }
          }
        });
      } finally {
        finishUpdateRun(record.runId, {
          status: "failed",
          reason: "authority fixture settled without package transport",
        });
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawStateDatabaseForTest();
      }
    },
  );
}

function check(id: string, hooks: Partial<DoctorHealthCheck> = {}): DoctorHealthCheck {
  return {
    id,
    kind: "core",
    description: id,
    detect: async () => [{ checkId: id, severity: "warning", message: "repair pending" }],
    repair: async () => ({ changes: [] }),
    ...hooks,
  };
}
function caught(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("Doctor original invocation authority", () => {
  it.each(["detect", "repair", "validation"] as const)(
    "keeps %s await revocation hard across rejection and a later healthy owner",
    async (phase) => {
      let first: unknown;
      let repeated: unknown;
      let dispatcherFailure: unknown;
      let settlementFailure: unknown;
      let laterHealthy = false;
      let sibling = false;
      const result = withPreparedDoctor(async ({ release, guard, context, runInExecutor }) => {
        let detects = 0;
        const revoke = async () => {
          await release();
          first = caught(guard);
          await runInExecutor(async () => {
            const later = await beginMaintenance({
              root: null,
              options: { repair: true },
              runtime,
            });
            try {
              if (!later) {
                throw new Error("missing later real maintenance");
              }
              later.assertCurrent();
              laterHealthy = true;
              repeated = caught(guard);
              // The leaf catches the first refusal and rejects with another value.
              // Neither that error nor the healthy later owner may replace it.
              throw new Error("ordinary leaf rejection after authority refusal");
            } finally {
              await later?.release();
            }
          });
        };
        const run = runDoctorHealthRepairs(
          { mode: "fix", runtime, cfg: context.cfg },
          {
            checks: [
              check("revoking", {
                detect: async () => {
                  detects++;
                  if (
                    (phase === "detect" && detects === 1) ||
                    (phase === "validation" && detects === 2)
                  ) {
                    await revoke();
                  }
                  return [{ checkId: "revoking", severity: "warning", message: "pending" }];
                },
                repair: async () => {
                  if (phase === "repair") {
                    await revoke();
                  }
                  return { changes: [] };
                },
              }),
              check("sibling", {
                detect: async () => {
                  sibling = true;
                  return [];
                },
              }),
            ],
          },
        );
        try {
          await run;
        } catch (error) {
          dispatcherFailure = error;
        }
      });
      try {
        await result;
      } catch (error) {
        settlementFailure = error;
      }
      // Assert outside recovery: its primary refusal must not mask an assertion.
      expect(
        first,
        `dispatcher=${String(dispatcherFailure)}; settlement=${String(settlementFailure)}`,
      ).toBeInstanceOf(Error);
      expect(repeated).toBe(first);
      expect(dispatcherFailure).toBe(first);
      expect(settlementFailure).toBe(first);
      expect(laterHealthy).toBe(true);
      expect(sibling).toBe(false);
    },
  );

  it.each(["structured", "core-contribution"] as const)(
    "binds the real %s caller without an injected guard option",
    async (route) => {
      let first: unknown;
      let sibling = false;
      let rejected: unknown;
      let settlementFailure: unknown;
      let warnings: string[] | undefined;
      try {
        await withPreparedDoctor(async ({ release, guard, context }) => {
          const checks = [
            check("f1/first", {
              repair: async () => {
                await release();
                first = caught(guard);
                return { changes: ["must not be accepted"] };
              },
            }),
            check("f1/sibling", {
              detect: async () => {
                sibling = true;
                return [];
              },
            }),
          ];
          registered.checks.push(...checks);
          try {
            if (route === "structured") {
              for (const entry of checks) {
                registerHealthCheck({ ...entry, kind: "plugin" });
              }
              await runStructuredHealthRepairs(context, async () => []);
            } else {
              await runCoreContributionHealth(
                context,
                checks.map((entry) => entry.id),
              );
            }
          } catch (error) {
            rejected = error;
          }
          warnings = context.updateWarnings;
        });
      } catch (error) {
        settlementFailure = error;
      }
      expect(first).toBeInstanceOf(Error);
      expect(rejected).toBe(first);
      expect(settlementFailure).toBe(first);
      expect(sibling).toBe(false);
      expect(warnings).toBeUndefined();
    },
  );

  it("retains valid-owner optional warnings and accepted repairs", async () => {
    await withPreparedDoctor(async ({ guard, context }) => {
      let detects = 0;
      const result = await runDoctorHealthRepairs(
        { mode: "fix", runtime, cfg: context.cfg },
        {
          checks: [
            check("optional-detect", {
              detect: async () => {
                throw new Error("optional detect");
              },
            }),
            check("optional-repair", {
              repair: async () => {
                throw new Error("optional repair");
              },
            }),
            check("optional-validation", {
              detect: async () => {
                if (++detects === 2) {
                  throw new Error("optional validation");
                }
                return [
                  { checkId: "optional-validation", severity: "warning", message: "pending" },
                ];
              },
            }),
            check("healthy", {
              detect: async (candidate) =>
                candidate.cfg.gateway?.mode === "remote"
                  ? []
                  : [{ checkId: "healthy", severity: "warning", message: "mode repair pending" }],
              repair: async (candidate) => ({
                config: { ...candidate.cfg, gateway: { ...candidate.cfg.gateway, mode: "remote" } },
                changes: ["repaired mode"],
              }),
            }),
          ],
        },
      );
      guard();
      expect(result.warnings.join("\n")).toContain("optional detect");
      expect(result.warnings.join("\n")).toContain("optional repair");
      expect(result.warnings.join("\n")).toContain("optional validation");
      expect(result.checksRun).toBe(4);
      expect(result.config.gateway?.mode).toBe("remote");
      expect(result.checksValidated).toBe(1);
      expect(result.changes).toContain("repaired mode");
    });
  });

  it("does not fabricate authority for an ordinary diagnostic caller", async () => {
    expect(captureDoctorUpdateRecoveryGuard()).toBeUndefined();
    const result = await runDoctorHealthRepairs(
      { mode: "fix", cfg: {}, runtime },
      {
        checks: [
          check("ordinary", {
            detect: async () => {
              throw new Error("optional");
            },
          }),
        ],
      },
    );
    expect(result.warnings).toHaveLength(1);
  });

  it.each([
    { route: "leaf", revoke: true, reject: false },
    { route: "leaf", revoke: true, reject: true },
    { route: "leaf", revoke: false, reject: false },
    { route: "leaf", revoke: false, reject: true },
    { route: "outer contribution", revoke: true, reject: false },
    { route: "outer contribution", revoke: false, reject: false },
  ])(
    "real non-structured session repair via $route: revoke=$revoke reject=$reject",
    async ({ route, revoke, reject }) => {
      let before: InternalSessionEntry | undefined;
      let after: InternalSessionEntry | undefined;
      let first: unknown;
      let leafFailure: unknown;
      let changes: string[] = [];
      let writesObserved = false;
      let settlementFailure: unknown;
      let later: unknown;
      let laterAdmitted = false;
      const confirmationError = new Error("confirmation rejected");
      try {
        await withPreparedDoctor(async ({ release, guard, context, observe }) => {
          const scope = { agentId: "main", sessionKey: "agent:main:wedged-main", env: context.env };
          const entry: InternalSessionEntry = {
            sessionId: "wedged",
            updatedAt: 1,
            status: "failed",
            abortedLastRun: true,
            mainRestartRecovery: {
              cycleId: "cycle",
              revision: 4,
              chargedAttempts: 3,
              tombstone: { reason: "exhausted" },
            },
          };
          await upsertSessionEntryCore(scope, entry);
          before = loadSessionEntryReadOnly(scope) as InternalSessionEntry;
          const candidate = inspectMainSessionRecoveryEntry(scope.sessionKey, before);
          if (!candidate) {
            throw new Error("missing real tombstone fixture");
          }
          const databasePath = resolveOpenClawAgentSqlitePath(scope);
          // An independent read-only connection observes committed writes even if
          // later compensated, without adding triggers to the canonical schema.
          const audit = new DatabaseSync(databasePath, { readOnly: true });
          let versionBefore = audit.prepare("PRAGMA data_version").get()?.data_version;
          try {
            changes = [];
            try {
              const repair = () =>
                noteMainSessionRecoveryIntegrity({
                  storePath: resolveSessionStorePathCore(undefined, scope),
                  wedged: [candidate],
                  warnings: [],
                  changes,
                  countLabel: (count, label) => `${count} ${label}`,
                  confirmRepair: async () => {
                    if (revoke) {
                      await release();
                      // Closing owned resources can commit maintenance metadata.
                      // Measure the leaf's writes after that permitted settlement.
                      versionBefore = audit.prepare("PRAGMA data_version").get()?.data_version;
                      first = caught(guard);
                    }
                    if (reject) {
                      throw confirmationError;
                    }
                    return true;
                  },
                });
              if (route === "outer contribution") {
                await runDoctorHealthContributionList(context, [
                  createDoctorHealthContribution({
                    id: "doctor:state-integrity",
                    label: "Session repair",
                    run: repair,
                  }),
                  createDoctorHealthContribution({
                    id: "doctor:later",
                    label: "Later session repair",
                    run: async () => {
                      await closeOpenClawAgentDatabasesAsync();
                      const owner = await beginMaintenance({
                        root: null,
                        options: { repair: true },
                        runtime,
                      });
                      try {
                        if (!owner) {
                          throw new Error("missing later real owner");
                        }
                        owner.assertCurrent();
                        laterAdmitted = true;
                        const target = {
                          agentId: "later",
                          sessionKey: "agent:later:late-after-refusal",
                          env: context.env,
                        };
                        await owner.run(async () => {
                          await upsertSessionEntryCore(target, {
                            sessionId: "late-write",
                            updatedAt: 2,
                          });
                          later = loadSessionEntryReadOnly(target);
                        });
                      } finally {
                        await owner?.release();
                      }
                    },
                  }),
                ]);
              } else {
                await repair();
              }
            } catch (error) {
              leafFailure = error;
            }
            // Only a revoked scope needs an independent observation. A live
            // owner's cached handle must remain owned until its normal drain.
            after = (
              revoke
                ? observe(() => loadSessionEntryReadOnly(scope))
                : loadSessionEntryReadOnly(scope)
            ) as InternalSessionEntry;
            writesObserved =
              audit.prepare("PRAGMA data_version").get()?.data_version !== versionBefore;
          } finally {
            audit.close();
          }
        });
      } catch (error) {
        settlementFailure = error;
      }
      console.log(
        JSON.stringify({
          fixture: "f1-nonstructured-write-boundary",
          route,
          later,
          laterAdmitted,
          first: String(first),
          leafFailure: String(leafFailure),
          before,
          after,
          changes,
          writesObserved,
          revoke,
          reject,
        }),
      );
      if (revoke || reject) {
        if (revoke) {
          expect(first).toBeInstanceOf(Error);
          expect(settlementFailure).toBe(first);
        } else {
          expect(settlementFailure).toBeUndefined();
        }
        expect.soft(leafFailure).toBe(revoke ? first : confirmationError);
        expect.soft(laterAdmitted).toBe(false);
        expect.soft(later).toBeUndefined();
        expect(after).toEqual(before);
        expect(writesObserved).toBe(false);
        expect(changes).toEqual([]);
      } else {
        expect(settlementFailure).toBeUndefined();
        expect(leafFailure).toBeUndefined();
        expect(after?.abortedLastRun).toBe(false);
        expect(after?.updatedAt).toBeGreaterThan(before?.updatedAt ?? 0);
        expect(writesObserved).toBe(true);
        expect(changes.join("\n")).toContain("Cleared aborted");
        if (route === "outer contribution") {
          expect(laterAdmitted).toBe(true);
          expect(later).toMatchObject({ sessionId: "late-write" });
        }
      }
    },
  );
  it.each([
    { phase: "contribution", revoke: true, reject: true, required: false },
    { phase: "snapshot", revoke: true, reject: false, required: false },
    { phase: "snapshot", revoke: true, reject: true, required: false },
    { phase: "snapshot", revoke: false, reject: false, required: false },
    { phase: "snapshot-entry", revoke: false, reject: true, required: false },
    { phase: "contribution", revoke: false, reject: true, required: false },
    { phase: "snapshot", revoke: false, reject: true, required: false },
    { phase: "contribution", revoke: false, reject: true, required: true },
  ])(
    "outer boundary $phase revoke=$revoke reject=$reject required=$required",
    async ({ phase, revoke, reject, required }) => {
      const diagnostic = new Error("ordinary diagnostic rejected");
      let first: unknown;
      let failure: unknown;
      let settlement: unknown;
      let laterAdmitted = false;
      let laterRow: unknown;
      let warnings: string[] = [];
      const calls: string[] = [];
      try {
        await withPreparedDoctor(async ({ release, guard, context }) => {
          const boundary = async () => {
            if (revoke) {
              await release();
              first = caught(guard);
            }
            if (reject) {
              throw diagnostic;
            }
          };
          if (phase !== "contribution") {
            let firstSnapshot = true;
            context.runWithPluginMetadataSnapshot = (_options, run) => {
              if (firstSnapshot) {
                firstSnapshot = false;
                calls.push("snapshot");
                if (phase === "snapshot-entry") {
                  throw diagnostic;
                }
              }
              // The production interface preserves T, including synchronous
              // returns and promises; asynchronous work belongs to the callback.
              return run();
            };
          }
          try {
            await runDoctorHealthContributionList(context, [
              createDoctorHealthContribution({
                id: "doctor:boundary",
                label: "Boundary diagnostic",
                ...(required ? { required: true as const } : {}),
                run: async () => {
                  calls.push("first");
                  await boundary();
                },
              }),
              createDoctorHealthContribution({
                id: "doctor:later-boundary",
                label: "Later writer",
                run: async () => {
                  const owner = await beginMaintenance({
                    root: null,
                    options: { repair: true },
                    runtime,
                  });
                  try {
                    if (!owner) {
                      throw new Error("missing real later owner");
                    }
                    owner.assertCurrent();
                    laterAdmitted = true;
                    const target = {
                      agentId: "later",
                      sessionKey: "agent:later:boundary",
                      env: context.env,
                    };
                    await owner.run(async () => {
                      await upsertSessionEntryCore(target, {
                        sessionId: "boundary-later",
                        updatedAt: 3,
                      });
                      laterRow = loadSessionEntryReadOnly(target);
                    });
                  } finally {
                    await owner?.release();
                  }
                },
              }),
            ]);
          } catch (error) {
            failure = error;
          }
          warnings = context.updateWarnings ?? [];
        });
      } catch (error) {
        settlement = error;
      }
      // Assertions must outlive recovery settlement, which can replace errors.
      if (revoke) {
        expect(first).toBeInstanceOf(Error);
        expect(failure).toBe(first);
        expect(settlement).toBe(first);
        expect(laterAdmitted).toBe(false);
        expect(laterRow).toBeUndefined();
        expect(warnings).toEqual([]);
        if (phase === "snapshot") {
          expect(calls).toEqual(["snapshot", "first"]);
        }
      } else if (required) {
        expect(failure).toBe(diagnostic);
        expect(settlement).toBeUndefined();
        expect(laterAdmitted).toBe(false);
        expect(laterRow).toBeUndefined();
      } else {
        expect(failure).toBeUndefined();
        expect(settlement).toBeUndefined();
        if (reject) {
          expect(warnings.join("\n")).toContain("ordinary diagnostic rejected");
        } else {
          expect(warnings).toEqual([]);
        }
        if (phase === "snapshot-entry") {
          expect(calls).toEqual(["snapshot"]);
        }
        expect(laterAdmitted).toBe(true);
        expect(laterRow).toMatchObject({ sessionId: "boundary-later" });
      }
    },
  );
});
