import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UpdateCommandOptions } from "../cli/update-cli/shared.js";
import {
  assertUpdateCommandBackupRecovery,
  createUpdateCommandBackup,
  preflightUpdateCommandBackup,
} from "../cli/update-cli/update-command-backup-lifecycle.js";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import {
  upsertSessionEntryCore,
  loadSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import { runDoctorHealthRepairs } from "../flows/doctor-repair-flow.js";
import type { UpdateRecoveryBackupRef } from "../infra/update-recovery-backup-contract.js";
import { verifyUpdateRecoveryBackup } from "../infra/update-recovery-backup.js";
import { inspectUpdateRunDriver } from "../infra/update-run-driver.js";
import { createUpdateRun, finishUpdateRun, getUpdateRun } from "../infra/update-run-ledger.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { VERSION } from "../version.js";
import { doctorCommand } from "./doctor.js";

function errors(value: unknown): string[] {
  if (!(value instanceof Error)) {
    return [String(value)];
  }
  return [
    value.message,
    ...(value instanceof AggregateError ? value.errors.flatMap(errors) : []),
    ...(value.cause ? errors(value.cause) : []),
  ];
}
async function sealedFiles(ref: UpdateRecoveryBackupRef) {
  const files: Record<string, string> = {};
  for (const name of ["", "candidate", "prepared"]) {
    const directory = path.join(ref.directory, name);
    const raw = await fs.readFile(path.join(directory, "manifest.json"));
    const manifest = await verifyUpdateRecoveryBackup({
      directory,
      manifestPath: path.join(directory, "manifest.json"),
      manifestSha256: createHash("sha256").update(raw).digest("hex"),
    });
    files[path.join(name, "manifest.json")] = createHash("sha256").update(raw).digest("hex");
    for (const entry of manifest.entries) {
      if (entry.kind === "file") {
        files[path.join(name, entry.archivePath)] = createHash("sha256")
          .update(await fs.readFile(path.join(directory, entry.archivePath)))
          .digest("hex");
      }
    }
  }
  return files;
}

async function prepareRetainedFixture() {
  const state = await createOpenClawTestState({
    layout: "state-only",
    scenario: "minimal",
    env: { OPENCLAW_SERVICE_REPAIR_POLICY: "external" },
  });
  try {
    await state.writeConfig({
      agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
      plugins: { enabled: false },
      skills: { allowBundled: ["fixture-no-bundled-skills"] },
      meta: { migrations: { modelPolicyAllowlist: true } },
      messages: { responsePrefix: "baseline" },
      gateway: { mode: "local" },
    });
    const root = process.cwd();
    const resultFile = state.path("producer-result.json");
    const script = `
        import fs from "node:fs/promises";
        import {withUpdateCommandExecutor} from ${JSON.stringify(new URL("../cli/update-cli/update-command-executor.ts", import.meta.url).href)};
        import {createUpdateCommandBackup} from ${JSON.stringify(new URL("../cli/update-cli/update-command-backup-lifecycle.ts", import.meta.url).href)};
        import {createUpdateRun,finishUpdateRun} from ${JSON.stringify(new URL("../infra/update-run-ledger.ts", import.meta.url).href)};
        import {restoreUpdateRecoveryBackup,writeUpdateRecoveryBackupOutcome} from ${JSON.stringify(new URL("../infra/update-recovery-backup.ts", import.meta.url).href)};
        import {beginDoctorMaintenance} from ${JSON.stringify(new URL("./doctor-maintenance.ts", import.meta.url).href)};
        import {upsertSessionEntryCore,deleteSessionEntryLifecycle,loadSessionEntryReadOnly} from ${JSON.stringify(new URL("../config/sessions/session-accessor.ts", import.meta.url).href)};
        import {resolveSessionStorePathCore} from ${JSON.stringify(new URL("../config/sessions/paths.ts", import.meta.url).href)};
        import {closeOpenClawAgentDatabasesAsync} from ${JSON.stringify(new URL("../state/openclaw-agent-db-lifecycle.ts", import.meta.url).href)};
        import {closeOpenClawStateDatabaseForTest} from ${JSON.stringify(new URL("../state/openclaw-state-db.ts", import.meta.url).href)};
        const root=process.cwd();
        const runtime={log(){},error(){},exit(code){throw new Error('exit '+code)}};
        const scope={agentId:'main',env:process.env};
        const edited={...scope,sessionKey:'agent:main:f1-edited'};
        const added={...scope,sessionKey:'agent:main:f1-added'};
        const deletedKey='agent:main:f1-deleted';
        await upsertSessionEntryCore(edited,{sessionId:'edited',updatedAt:1,label:'baseline'});
        await upsertSessionEntryCore({...scope,sessionKey:deletedKey},{sessionId:'deleted',updatedAt:1});
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawStateDatabaseForTest();
        const run=createUpdateRun({trigger:'cli'});
        const result=await withUpdateCommandExecutor(run.runId,async executor=>{
          const executorFence=await executor.enter(root);
          const opts={run:{runId:run.runId,env:process.env,executorFence}};
          const ref=await createUpdateCommandBackup({opts,root,env:process.env});
          await upsertSessionEntryCore(edited,{sessionId:'edited',updatedAt:2,label:'acknowledged edit'});
          await upsertSessionEntryCore(added,{sessionId:'added',updatedAt:2,label:'acknowledged addition'});
          const deletion=await deleteSessionEntryLifecycle({agentId:'main',storePath:resolveSessionStorePathCore(undefined,scope),target:{canonicalKey:deletedKey,storeKeys:[deletedKey]},expectedSessionId:'deleted',archiveTranscript:false,requireWriteSuccess:true});
          if (!deletion.deleted) throw new Error('fixture deletion did not commit');
          const entries={edited:loadSessionEntryReadOnly(edited),added:loadSessionEntryReadOnly(added)};
          await closeOpenClawAgentDatabasesAsync();
          closeOpenClawStateDatabaseForTest();
          const maintenance=await beginDoctorMaintenance({root:null,options:{repair:true},runtime});
          if(!maintenance) throw new Error('missing real maintenance');
          const assertOwned=()=>{executorFence.assertCurrent();maintenance.assertCurrent()};
          let refusal;
          try { await restoreUpdateRecoveryBackup(ref,{assertOwned}); }
          catch(error){refusal=String(error);await writeUpdateRecoveryBackupOutcome(ref,{status:'restore-failed',error:refusal},{assertOwned});}
          finally {await maintenance.release();}
          if(!refusal?.includes('Rollback publication is unavailable')) throw new Error('wrong fixture refusal: '+refusal);
          const configPath=process.env.OPENCLAW_CONFIG_PATH;
          const currentConfig=JSON.parse(await fs.readFile(configPath,'utf8'));
          currentConfig.messages.responsePrefix='acknowledged config edit';
          await fs.writeFile(configPath,JSON.stringify(currentConfig));
          finishUpdateRun(run.runId,{status:'failed',reason:'synthetic failed update; newer state retained'});
          return {ref,runId:run.runId,entries,refusal};
        });
        await closeOpenClawAgentDatabasesAsync(); closeOpenClawStateDatabaseForTest();
        await fs.writeFile(${JSON.stringify(resultFile)},JSON.stringify(result));
      `;
    const producer = await runUtf8CommandWithTimeout(
      [
        process.execPath,
        "--import",
        path.resolve("scripts/tsx.mjs"),
        "--input-type=module",
        "-e",
        script,
      ],
      {
        env: state.env,
        timeoutMs: 120_000,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
      },
    );
    expect(producer, producer.stderr).toMatchObject({
      code: 0,
      termination: "exit",
      signal: null,
      killed: false,
      cleanup: "normal",
    });
    const produced = JSON.parse(await fs.readFile(resultFile, "utf8")) as {
      ref: UpdateRecoveryBackupRef;
      runId: string;
      entries: { edited: unknown; added: unknown };
      refusal: string;
    };
    const manifest = await verifyUpdateRecoveryBackup(produced.ref);
    expect(inspectUpdateRunDriver(manifest.creator)).toBe("dead");
    const sealed = await sealedFiles(produced.ref);
    const config = await fs.readFile(state.configPath, "utf8");
    return { state, root, producer, produced, sealed, config };
  } catch (error) {
    await state.cleanup();
    throw error;
  }
}

describe("retained forward recovery through real owners", () => {
  describe("with a settled failed-update producer", () => {
    let fixture: Awaited<ReturnType<typeof prepareRetainedFixture>> | undefined;
    beforeEach(async () => {
      fixture = await prepareRetainedFixture();
    });
    afterEach(async () => {
      await fixture?.state.cleanup();
      fixture = undefined;
    });
    it("repairs current state without restoring B and admits a second protected capture", async () => {
      if (!fixture) {
        throw new Error("Missing retained update fixture");
      }
      const { state, root, producer, produced, sealed, config } = fixture;
      const messages: string[] = [];
      const runtime: RuntimeEnv = {
        log: (value) => {
          messages.push(String(value));
        },
        error: (value) => {
          messages.push(String(value));
        },
        exit: (code) => {
          throw new ExitError(code);
        },
      };
      const doctorStartedAt = Date.now();
      let doctorFailure: unknown;
      try {
        await doctorCommand(runtime, { repair: true, nonInteractive: true });
      } catch (error) {
        doctorFailure = error;
      }
      const doctorFinishedAt = Date.now();
      const next = createUpdateRun({ trigger: "cli" }, { env: state.env });
      let nextFailure: unknown;
      let nextCapture: UpdateRecoveryBackupRef | undefined;
      try {
        await withUpdateCommandExecutor(next.runId, async (executor) => {
          const opts: UpdateCommandOptions = {
            run: { runId: next.runId, env: state.env, executorFence: await executor.enter(root) },
          };
          const params = { opts, root, env: state.env };
          await assertUpdateCommandBackupRecovery(params);
          await preflightUpdateCommandBackup(params);
          nextCapture = await createUpdateCommandBackup(params);
        });
      } catch (error) {
        nextFailure = error;
      }
      finishUpdateRun(
        next.runId,
        { status: "failed", reason: "fixture ended before package transport" },
        { env: state.env },
      );
      expect(await sealedFiles(produced.ref)).toEqual(sealed);
      const beforeConfig = JSON.parse(config);
      const afterConfig = JSON.parse(await fs.readFile(state.configPath, "utf8"));
      // Full Doctor writes its own provenance; every operator setting must survive.
      expect(afterConfig).toEqual({
        ...beforeConfig,
        meta: { ...beforeConfig.meta, lastTouchedVersion: VERSION },
        wizard: {
          lastRunAt: expect.any(String),
          lastRunVersion: VERSION,
          ...(process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim()
            ? { lastRunCommit: process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim() }
            : {}),
          lastRunCommand: "doctor",
          lastRunMode: "local",
        },
      });
      expect(Date.parse(afterConfig.wizard.lastRunAt)).toBeGreaterThanOrEqual(doctorStartedAt);
      expect(Date.parse(afterConfig.wizard.lastRunAt)).toBeLessThanOrEqual(doctorFinishedAt);
      expect(afterConfig.messages.responsePrefix).toBe("acknowledged config edit");
      const scope = { agentId: "main", env: state.env };
      expect(loadSessionEntryReadOnly({ ...scope, sessionKey: "agent:main:f1-edited" })).toEqual(
        produced.entries.edited,
      );
      expect(loadSessionEntryReadOnly({ ...scope, sessionKey: "agent:main:f1-added" })).toEqual(
        produced.entries.added,
      );
      expect(
        loadSessionEntryReadOnly({ ...scope, sessionKey: "agent:main:f1-deleted" }),
      ).toBeUndefined();
      expect(getUpdateRun(produced.runId)?.status).toBe("failed");
      expect(getUpdateRun(produced.runId)?.origin.updateRecoveryCapture?.restored).not.toBe(true);
      expect(
        getUpdateRun(produced.runId)?.steps.some(
          (step) => step.step === "state rollback" && step.status === "completed",
        ),
      ).toBe(false);
      console.log(
        JSON.stringify({
          fixture: "retained-forward-f1",
          producer: { code: producer.code, cleanup: producer.cleanup, creatorDead: true },
          produced,
          sealed,
          doctorErrors: doctorFailure ? errors(doctorFailure) : [],
          nextErrors: nextFailure ? errors(nextFailure) : [],
          messages,
          nextCapture,
        }),
      );
      expect.soft(doctorFailure, "compatible forward Doctor repair must complete").toBeUndefined();
      expect
        .soft(nextFailure, "second protected update must pass admission and capture")
        .toBeUndefined();
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabaseForTest();
    }, 180_000);
  });

  it("keeps the first executor refusal hard even if a later repair could acquire authority", async () => {
    await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        plugins: { enabled: false },
      });
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:after-authority-refusal",
        env: state.env,
      };
      const first = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const next = createUpdateRun({ trigger: "cli" }, { env: state.env });
      const root = process.cwd();
      const warnings: string[] = [];
      const runtime: RuntimeEnv = {
        log() {},
        error: (value) => {
          warnings.push(String(value));
        },
        exit: (code) => {
          throw new ExitError(code);
        },
      };
      let failure: unknown;
      let firstRefusal: unknown;
      let laterOwnerAdmitted = false;
      await withUpdateCommandExecutor(first.runId, async (executor) => {
        const originalFence = await executor.enter(root, { preflight: true });
        releaseUpdateCommandPreflightForHandoff(originalFence);
        try {
          const result = await runDoctorHealthRepairs(
            { mode: "fix", cfg: {}, env: state.env, runtime },
            {
              checks: [
                {
                  id: "original-executor",
                  kind: "core",
                  description: "original owner",
                  detect: async () => [
                    { checkId: "original-executor", severity: "error", message: "repair pending" },
                  ],
                  repair: async () => {
                    try {
                      originalFence.assertCurrent();
                    } catch (error) {
                      firstRefusal = error;
                      throw error;
                    }
                    return { changes: [] };
                  },
                },
                {
                  id: "later-executor",
                  kind: "core",
                  description: "would-be later owner",
                  detect: async () =>
                    loadSessionEntryReadOnly(scope)
                      ? []
                      : [
                          {
                            checkId: "later-executor",
                            severity: "error",
                            message: "later repair pending",
                          },
                        ],
                  repair: async () => {
                    await withUpdateCommandExecutor(next.runId, async (later) => {
                      const fence = await later.enter(root);
                      fence.assertCurrent();
                      laterOwnerAdmitted = true;
                      await upsertSessionEntryCore(scope, {
                        sessionId: "must-not-commit",
                        updatedAt: 1,
                      });
                      fence.assertCurrent();
                    });
                    return { changes: ["later repair wrote after original authority refusal"] };
                  },
                },
              ],
            },
          );
          warnings.push(...result.warnings);
        } catch (error) {
          failure = error;
        }
      });
      expect(firstRefusal).toBeInstanceOf(Error);
      console.log(
        JSON.stringify({
          fixture: "f1-first-authority-refusal",
          firstErrors: errors(firstRefusal),
          thrown: failure ? errors(failure) : [],
          warnings,
          laterOwnerAdmitted,
          committed: loadSessionEntryReadOnly(scope),
        }),
      );
      expect.soft(failure, "authority refusal must not become an advisory").toBe(firstRefusal);
      expect.soft(laterOwnerAdmitted, "do not continue under a replacement owner").toBe(false);
      expect.soft(loadSessionEntryReadOnly(scope), "no write after first refusal").toBeUndefined();
      finishUpdateRun(
        first.runId,
        { status: "failed", reason: "fixture original owner released" },
        { env: state.env },
      );
      finishUpdateRun(
        next.runId,
        { status: "failed", reason: "fixture later owner settled" },
        { env: state.env },
      );
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabaseForTest();
    });
  });
});
