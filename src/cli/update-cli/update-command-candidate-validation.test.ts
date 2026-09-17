// Install the fixture mocks before loading the execution owner and its dependencies.
import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  updateRunStepsFromResultStep,
  updateRunWarningMessages,
} from "../../infra/update-run-step.js";
import type { UpdateStepProgress, UpdateStepResult } from "../../infra/update-runner-types.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";

const { executionParams, mocks, schemaContext, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

describe("mutable update execution", () => {
  it.each([
    "healthy",
    "origin-previous-unverified",
    "late-canary-failed",
    "repair-invalidates-primary",
    "partial-stop-failed",
    "legacy-neutral",
    "legacy-migrating",
    "current-core",
  ] as const)("keeps shared activation behind every profile's admission (%s)", async (outcome) => {
    await withTestDir({ prefix: "shared-update-execution-" }, async (root) => {
      const contexts = ["primary", "ops", "paused"].map((name) => {
        const context = schemaContext(name);
        context.env.OPENCLAW_STATE_DIR = path.join(root, name);
        context.readEnv = { ...context.env };
        return context;
      });
      const admitted = contexts.map((context, index) => ({
        root,
        context,
        stopState: {
          stopped: false,
          inspected: true,
          runtimeInspected: true,
          running: index !== 2,
          serviceEnv: context.env,
          serviceNodeRunner: `/node/${index}`,
          serviceUpdateVerdict: {
            kind: "owned" as const,
            root,
            fingerprint: `service-${index}`,
            refreshDefinition: false,
          },
        },
      }));
      const database = await import("./update-command-database-context.js");
      vi.spyOn(database, "inspectUpdateDatabaseContexts").mockResolvedValue({
        scope: "installation",
        roots: [root],
        profiles: admitted,
        contexts,
        externalConsumers: [],
      });
      const managed = await import("./update-command-managed-context.js");
      vi.spyOn(managed, "readUpdateCandidateSource").mockImplementation(async (env) => ({
        config: {},
        hash: `config-${env.OPENCLAW_PROFILE}`,
      }));
      const events: string[] = [];
      const states = await import("../../infra/update-candidate-state.js");
      vi.spyOn(states, "readUpdateStateSchemaVersions").mockImplementation(async ({ stateDir }) => {
        const name = path.basename(stateDir);
        events.push(`schemas:${name}`);
        return [
          {
            path: path.join(stateDir, "state", "openclaw.sqlite"),
            userVersion: outcome === "legacy-migrating" && name === "ops" ? 14 : 15,
          },
        ];
      });
      const verification = await import("./update-command-verification.js");
      vi.spyOn(verification, "verifyPreviousGatewayForUpdate").mockImplementation(
        async ({ env, observedStartupMs }) => {
          events.push(`previous:${env.OPENCLAW_PROFILE}`);
          expect(observedStartupMs).toBe(1);
          expect(events.some((event) => event.startsWith("stop:"))).toBe(false);
          return outcome !== "origin-previous-unverified" || env.OPENCLAW_PROFILE !== "primary";
        },
      );
      const budget = await import("../../infra/update-finalization-budget.js");
      vi.spyOn(budget, "resolveUpdateFinalizationTimeoutMs").mockResolvedValue(1_000);
      mocks.prepareMutableUpdate.mockImplementation(async (env, timeoutMs) => {
        events.push(
          timeoutMs === undefined ? `prepare:${env?.OPENCLAW_PROFILE}` : `budget:${timeoutMs}`,
        );
        return {};
      });
      let repaired = false;
      const repair = await import("./update-command-repair.js");
      const runRepair = vi.spyOn(repair, "runUpdateCommandRepair").mockImplementation(async () => {
        repaired = outcome === "repair-invalidates-primary";
        events.push("repair");
        return {
          status: repaired ? "repaired" : "unavailable",
          attempts: [],
          finalValidation: {
            ok: repaired,
            score: Number(repaired),
            summary: "fixture candidate repair",
          },
        };
      });
      mocks.validateCanary.mockImplementation(async ({ env, nodeRunner }) => {
        const name = env.OPENCLAW_PROFILE;
        events.push(`canary:${name}`);
        expect(nodeRunner).toBe(
          `/node/${contexts.findIndex((context) => context.env.OPENCLAW_PROFILE === name)}`,
        );
        expect(events.some((event) => event.startsWith("stop:"))).toBe(false);
        const failed =
          (outcome === "late-canary-failed" && name === "ops") ||
          (outcome === "repair-invalidates-primary" &&
            ((name === "ops" && !repaired) || (name === "primary" && repaired)));
        return {
          status: failed ? "error" : "ok",
          phase: "readiness",
          reason: failed ? "doctor-failed" : undefined,
          candidateSchemaVersions: { state: 15, agent: 19 },
          profileContexts: !outcome.startsWith("legacy-"),
          steps: [
            {
              name: "Checking Gateway startup",
              command: "gateway run",
              cwd: root,
              durationMs: 1,
              exitCode: failed ? 1 : 0,
            },
          ],
          durationMs: 1,
          logTail: [],
        };
      });
      mocks.maybeStopService.mockImplementation(async ({ expectedService, phase, onStopped }) => {
        if (phase === "inspect") {
          return expectedService;
        }
        const name = expectedService.serviceEnv.OPENCLAW_PROFILE;
        if (!expectedService.running) {
          events.push(`preserve:${name}`);
          return expectedService;
        }
        const stopped = { ...expectedService, stopped: true };
        onStopped?.(stopped);
        events.push(`stop:${name}`);
        if (outcome === "partial-stop-failed" && name === "ops") {
          throw new Error("fixture late native failure");
        }
        return stopped;
      });
      mocks.runDoctor.mockImplementation(
        async ({ managedServiceEnv, nodeRunner, onConfigSnapshot }) => {
          const name = managedServiceEnv!.OPENCLAW_PROFILE;
          events.push(`doctor:${name}`);
          expect(events).toContain("activate");
          expect(nodeRunner).toBe(
            `/node/${contexts.findIndex((context) => context.env.OPENCLAW_PROFILE === name)}`,
          );
          onConfigSnapshot?.({
            path: `/fixture/${name}/openclaw.json`,
            raw: "{}",
            hash: `doctor-${name}`,
            doctorOwned: true,
          });
          return {
            name: "openclaw doctor",
            command: "openclaw doctor",
            cwd: root,
            durationMs: 1,
            exitCode: 0,
          };
        },
      );
      mocks.runPackageUpdate.mockImplementation(
        async ({ validateCandidate, beforeActivate, runDoctor }) => {
          const steps = await validateCandidate(root);
          if (steps.some((step: UpdateStepResult) => step.exitCode !== 0)) {
            return { ...successfulUpdate, status: "error", steps };
          }
          await beforeActivate();
          events.push("activate");
          await runDoctor(root);
          return successfulUpdate;
        },
      );
      const params = {
        ...executionParams("package"),
        root,
        ...(outcome === "current-core"
          ? {
              alreadyCurrentResult: {
                ...successfulUpdate,
                status: "skipped" as const,
                reason: "already-current",
              },
            }
          : {}),
        onActivation: vi.fn(),
      };
      if (outcome === "origin-previous-unverified") {
        const control = path.join(root, "leases");
        await fs.mkdir(control);
        vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        mocks.nativeSupport.mockResolvedValue(true);
        const env = contexts[0]!.env;
        params.opts.run = { runId: createUpdateRun({ trigger: "cli" }, { env }).runId, env };
      }
      const execution = params.opts.run
        ? await withUpdateCommandExecutor(params.opts.run.runId, async (executor) => {
            params.opts.run!.executorFence = await executor.enter(root, { preflight: true });
            return await executeMutableUpdate(params);
          })
        : await executeMutableUpdate(params);
      if (outcome === "current-core") {
        expect(execution).toMatchObject({
          coreAlreadyCurrent: true,
          mutationStarted: false,
          result: { status: "skipped", reason: "already-current" },
        });
        expect(execution?.profiles).toHaveLength(3);
        expect(mocks.prepareMutableUpdate).toHaveBeenCalledExactlyOnceWith(
          contexts[0]!.env,
          3_000,
          true,
        );
        expect(mocks.pluginPreflight).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ env: contexts[0]!.env }),
        );
        expect(mocks.runtimePreflight).toHaveBeenCalledOnce();
        expect(mocks.validateCanary).not.toHaveBeenCalled();
        expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
        expect(mocks.runDoctor).not.toHaveBeenCalled();
        expect(params.onActivation).not.toHaveBeenCalled();
        expect(
          execution?.profiles.map((profile) => profile.preManagedServiceStop?.stopped),
        ).toEqual([false, false, false]);
        return;
      }
      const activated =
        outcome === "healthy" ||
        outcome === "legacy-neutral" ||
        outcome === "origin-previous-unverified";
      expect(execution?.result.status, execution?.failure?.detail).toBe(activated ? "ok" : "error");
      expect(params.recoveryState.profiles).toBe(execution?.profiles);
      expect(execution?.profiles).toHaveLength(3);
      if (outcome === "origin-previous-unverified") {
        expect(execution?.profiles.map((profile) => profile.previousVerified)).toEqual([
          false,
          true,
          false,
        ]);
        const run = params.opts.run!;
        expect(
          getUpdateRun(run.runId, { env: run.env })?.steps.filter(
            (step) => step.step === "previous gateway verification",
          ),
        ).toEqual([
          expect.objectContaining({
            status: "completed",
            detail: "Previous gateway was not verified; automatic rollback cannot restart it.",
          }),
        ]);
      }
      if (activated || outcome === "partial-stop-failed") {
        const firstStop = events.indexOf("stop:primary");
        for (const name of ["primary", "ops", "paused"]) {
          expect(events.indexOf(`canary:${name}`)).toBeLessThan(firstStop);
        }
        expect(events.indexOf("previous:ops")).toBeLessThan(firstStop);
        expect(events.indexOf("schemas:paused")).toBeLessThan(firstStop);
        expect(events.indexOf("budget:3000")).toBeLessThan(firstStop);
        expect(
          execution?.profiles.map((profile) => profile.preManagedServiceStop?.stopped),
        ).toEqual([true, true, false]);
      } else {
        expect(events.some((event) => event.startsWith("stop:"))).toBe(false);
      }
      if (activated) {
        expect(events.slice(-4)).toEqual([
          "activate",
          "doctor:primary",
          "doctor:ops",
          "doctor:paused",
        ]);
        expect(execution?.profiles.map((profile) => profile.activationConfig?.hash)).toEqual([
          "doctor-primary",
          "doctor-ops",
          "doctor-paused",
        ]);
      } else {
        expect(events).not.toContain("activate");
      }
      if (outcome === "repair-invalidates-primary") {
        expect(events.filter((event) => event.startsWith("canary:"))).toEqual([
          "canary:primary",
          "canary:ops",
          "canary:ops",
          "canary:paused",
          "canary:primary",
        ]);
        expect(runRepair).toHaveBeenCalledOnce();
      }
      if (outcome === "legacy-migrating") {
        expect(execution?.result.reason).toBe("target-native-unsupported");
      }
    });
  });

  it.each(["package", "git"] as const)(
    "continues the %s update with the recorded readiness warning instead of inference repair",
    async (kind) => {
      const message =
        "Readiness probe http://127.0.0.1:18789/readyz failed: HTTP 502. Check the configured proxy.";
      const step: UpdateStepResult = {
        name: "Checking Gateway startup",
        command: "gateway run",
        cwd: "/candidate",
        durationMs: 1,
        exitCode: null,
        advisory: { kind: "candidate-runtime-unavailable", message },
        failureFacts: [{ check: "readyz", code: "candidate-readiness-probe-failed", message }],
      };
      mocks.validateCanary.mockImplementation(async ({ onStep }) => {
        onStep(step);
        return {
          status: "ok",
          phase: "readiness",
          steps: [step],
          durationMs: 1,
          logTail: [message],
        };
      });
      const repair = await import("./update-command-repair.js");
      const runRepair = vi.spyOn(repair, "runUpdateCommandRepair");
      const accepted = vi.fn();
      const runStagedUpdate = async ({
        validateCandidate,
      }: {
        validateCandidate?: (root: string) => Promise<unknown>;
      }) => {
        expect(validateCandidate).toBeTypeOf("function");
        await validateCandidate?.("/candidate");
        accepted();
        return successfulUpdate;
      };
      mocks.runPackageUpdate.mockImplementation(runStagedUpdate);
      mocks.runGitUpdate.mockImplementation(runStagedUpdate);
      const onStepComplete = vi.fn<NonNullable<UpdateStepProgress["onStepComplete"]>>();

      const execution = await executeMutableUpdate({
        ...executionParams(kind),
        progress: { onStepComplete },
      });

      expect(execution?.result.status).toBe("ok");
      expect(accepted).toHaveBeenCalledOnce();
      expect(runRepair).not.toHaveBeenCalled();
      expect(onStepComplete).toHaveBeenCalledWith(expect.objectContaining(step));
      const recorded = onStepComplete.mock.calls.flatMap(([completed]) =>
        updateRunStepsFromResultStep(completed),
      );
      expect(updateRunWarningMessages(recorded)).toEqual([message]);
      expect(recorded.every((entry) => entry.status === "completed")).toBe(true);
    },
  );

  it.each(
    (["package", "git"] as const).flatMap((kind) =>
      [undefined, 30_000, 600_000].map((timeoutMs) => ({ kind, timeoutMs })),
    ),
  )(
    "passes only the operator's $timeoutMs ms deadline to $kind candidate validation",
    async ({ kind, timeoutMs }) => {
      const runStagedUpdate = async ({
        validateCandidate,
      }: {
        validateCandidate?: (root: string) => Promise<unknown>;
      }) => {
        expect(validateCandidate).toBeTypeOf("function");
        await validateCandidate?.("/candidate");
        return successfulUpdate;
      };
      mocks.runPackageUpdate.mockImplementation(runStagedUpdate);
      mocks.runGitUpdate.mockImplementation(runStagedUpdate);

      const execution = await executeMutableUpdate({
        ...executionParams(kind),
        timeoutMs,
        updateStepTimeoutMs: timeoutMs ?? 30 * 60_000,
      });

      expect(execution?.result.status).toBe("ok");
      expect(mocks.validateCanary).toHaveBeenCalledOnce();
      expect(mocks.validateCanary.mock.calls[0]?.[0].root).toBe("/candidate");
      expect(mocks.validateCanary.mock.calls[0]?.[0].timeoutMs).toBe(timeoutMs);
    },
  );
});
