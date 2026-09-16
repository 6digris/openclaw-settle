import fs from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createUpdateCommandBackup } from "../cli/update-cli/update-command-backup-lifecycle.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as configModule from "../config/config.js";
import type { DoctorHealthFlowContext } from "../flows/doctor-health-contribution-types.js";
import {
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "../flows/doctor-health-contributions.test-support.js";
import { createUpdateRun, finishUpdateRun } from "../infra/update-run-ledger.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as maintenanceModule from "./doctor-maintenance.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import {
  captureDoctorUpdateRecoveryGuard,
  prepareDoctorUpdateRecovery,
  withDoctorUpdateRecovery,
} from "./doctor-update-recovery.js";

const beginMaintenance = maintenanceModule.beginDoctorMaintenance;
const transformConfigFile = configModule.transformConfigFile;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// No registry substitution: exercise the actual registered config contribution,
// transform, snapshot/lock and atomic publication owners. Only the transform's
// async planning boundary is delayed to release the real maintenance owner.
it.each([true, false])(
  "registered config writer keeps recovery authority at publication: revoke=%s",
  async (revoke) => {
    const messages: string[] = [];
    const runtime: RuntimeEnv = {
      log: (value) => {
        messages.push(String(value));
      },
      error() {},
      exit(code) {
        throw new ExitError(code);
      },
    };
    let first: unknown;
    let failure: unknown;
    let settlement: unknown;
    let before = "";
    let after = "";
    let transformReached = false;
    let committed = false;
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
        const observed: NonNullable<Awaited<ReturnType<typeof beginMaintenance>>>[] = [];
        vi.spyOn(maintenanceModule, "beginDoctorMaintenance").mockImplementation(async (params) => {
          const owner = await beginMaintenance(params);
          if (owner) {
            observed.push(owner);
          }
          return owner;
        });
        const record = createUpdateRun({ trigger: "cli" });
        try {
          await withUpdateCommandExecutor(record.runId, async (executor) => {
            const fence = await executor.enter(process.cwd());
            const ref = await createUpdateCommandBackup({
              opts: { run: { runId: record.runId, env: state.env, executorFence: fence } },
              root: process.cwd(),
              env: state.env,
            });
            vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
            vi.stubEnv("OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE", "1");
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
                  throw new Error("missing real recovery authority");
                }
                before = await fs.readFile(state.configPath, "utf8");
                const options = { repair: true, nonInteractive: true };
                const candidate = { ...cfg, messages: { ackReaction: "verified-fixture" } };
                const context: DoctorHealthFlowContext = {
                  runtime,
                  options,
                  prompter: createDoctorPrompter({ runtime, options }),
                  configResult: {
                    cfg: candidate,
                    shouldWriteConfig: true,
                    skipWizardMetadataForIncludeWrite: true,
                  },
                  cfg: candidate,
                  cfgForPersistence: cfg,
                  sourceConfigValid: true,
                  configPath: state.configPath,
                  env: {
                    ...state.env,
                    OPENCLAW_UPDATE_IN_PROGRESS: "1",
                    OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
                  },
                };
                vi.spyOn(configModule, "transformConfigFile").mockImplementation(async (params) =>
                  transformConfigFile({
                    ...params,
                    transform: async (...args) => {
                      const planned = await params.transform(...args);
                      transformReached = true;
                      if (revoke) {
                        await owner.release();
                        try {
                          guard();
                        } catch (error) {
                          first = error;
                        }
                      }
                      return planned;
                    },
                  }),
                );
                const contribution = resolveDoctorHealthContributions().find(
                  (item) => item.id === "doctor:write-config",
                );
                if (!contribution) {
                  throw new Error("missing registered config writer");
                }
                try {
                  await runDoctorHealthContributionList(context, [contribution]);
                } catch (error) {
                  failure = error;
                }
                after = await fs.readFile(state.configPath, "utf8");
                committed = context.configResultWriteCommitted === true;
              });
            } catch (error) {
              settlement = error;
            }
          });
        } finally {
          finishUpdateRun(record.runId, {
            status: "failed",
            reason: "config authority fixture, no package transport",
          });
          await closeOpenClawAgentDatabasesAsync();
          closeOpenClawStateDatabaseForTest();
        }
      },
    );
    console.log(
      JSON.stringify({
        fixture: "f1-registered-config-publication",
        revoke,
        transformReached,
        before,
        after,
        committed,
        messages,
        first: String(first),
        failure: String(failure),
        settlement: String(settlement),
      }),
    );
    expect(transformReached).toBe(true);
    if (revoke) {
      expect(first).toBeInstanceOf(Error);
      expect(failure).toBe(first);
      expect(settlement).toBe(first);
      expect.soft(after, "revoked Doctor must not publish config").toBe(before);
      expect.soft(committed).toBe(false);
      expect.soft(messages.some((message) => message.includes("Updated"))).toBe(false);
    } else {
      expect(failure).toBeUndefined();
      expect(settlement).toBeUndefined();
      expect(JSON.parse(after).messages.ackReaction).toBe("verified-fixture");
      expect(committed).toBe(true);
    }
  },
);
