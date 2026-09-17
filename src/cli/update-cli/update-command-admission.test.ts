import "./update-command-execution.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as configFile from "../../config/config.js";
import * as serviceCandidates from "../../daemon/service-candidates.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { isPackageTargetAlreadyCurrent } from "../../infra/update-global.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { prepareGitMutation } from "../../infra/update-runner-git-target.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { UpdatePreMutationError } from "./shared.js";
import * as databaseContext from "./update-command-database-context.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { preflightUpdateCommandSchemas } from "./update-command-schema.js";

const { executionParams, inspectOrStopService, mocks, schemaContext, successfulUpdate } =
  await import("./update-command-execution.test-support.js");

describe("update target admission", () => {
  it.each(
    (["package", "git"] as const).flatMap((kind) =>
      [false, true].map((preparedCaller) => ({ kind, preparedCaller })),
    ),
  )(
    "keeps schema-only callers out of $kind maintenance (prepared caller origin=$preparedCaller)",
    async ({ kind, preparedCaller }) => {
      const params = executionParams(kind);
      const callerContext = schemaContext("default");
      const nativeContext = schemaContext("primary");
      mocks.captureManagedPreflight.mockResolvedValue(nativeContext);
      mocks.maybeStopService.mockImplementation(async ({ phase }) => ({
        ...inspectOrStopService(phase, { root: params.root, env: nativeContext.env }),
        running: false,
      }));
      if (preparedCaller) {
        // The admission owner has already proved this state-only caller's foreground ownership.
        vi.spyOn(databaseContext, "inspectUpdateDatabaseContexts").mockResolvedValue({
          scope: "installation",
          roots: [params.root],
          profiles: [
            { root: params.root, context: callerContext },
            {
              root: params.root,
              context: nativeContext,
              stopState: {
                ...inspectOrStopService("inspect", { root: params.root, env: nativeContext.env }),
                running: false,
              },
            },
          ],
          contexts: [callerContext, nativeContext],
          externalConsumers: [],
        });
      }
      vi.spyOn(configFile, "readConfigFileSnapshot").mockImplementation(
        async () => schemaContext(process.env.OPENCLAW_PROFILE ?? "default").configSnapshot,
      );
      mocks.runPackageUpdate.mockImplementation(
        async ({
          beforeActivate,
        }: Parameters<typeof import("./update-command-package.js").runPackageInstallUpdate>[0]) => {
          await beforeActivate();
          return successfulUpdate;
        },
      );
      mocks.runGitUpdate.mockImplementation(
        async ({
          inspectGitTarget,
          beforeGitMutation,
        }: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0]) => {
          const target = { schemaVersions: params.packageTargetSchemaVersions };
          await inspectGitTarget(target);
          await beforeGitMutation(target);
          return { ...successfulUpdate, mode: "git" };
        },
      );

      const execution = await executeMutableUpdate(params);
      const mutableProfiles = preparedCaller ? ["default", "primary"] : ["primary"];

      expect(execution).toMatchObject({ mutationStarted: true, result: { status: "ok" } });
      expect(
        mocks.maybeStopService.mock.calls
          .filter(([options]) => options.phase === "prepare")
          .map(([options]) => options.env?.OPENCLAW_PROFILE),
      ).toEqual(["primary"]);
      expect(
        execution?.profiles.map((profile) => profile.ownedManagedUpdateEnv?.OPENCLAW_PROFILE),
      ).toEqual(mutableProfiles);
      if (preparedCaller) {
        expect(execution?.profiles[0]?.preManagedServiceStop).toBeUndefined();
      }
      expect(execution?.profiles.at(-1)?.preManagedServiceStop).toMatchObject({
        stopped: true,
        serviceEnv: { OPENCLAW_PROFILE: "primary" },
      });
      expect(
        new Set(mocks.prepareMutableUpdate.mock.calls.map(([env]) => env?.OPENCLAW_PROFILE)),
      ).toEqual(new Set(mutableProfiles));
      expect(mocks.checkTargetSchemas).toHaveBeenCalled();
      for (const [, contexts] of mocks.checkTargetSchemas.mock.calls) {
        expect(contexts.map(({ env }) => env.OPENCLAW_PROFILE)).toEqual(["default", "primary"]);
      }
    },
  );

  it.each([
    "current",
    "current config drift",
    "new version",
    "unknown version",
    "artifact",
    "git",
  ] as const)(
    "keeps external system consumers out of profile-only package maintenance: %s",
    async (route) => {
      const params = executionParams(route === "git" ? "git" : "package");
      const targetVersion =
        route === "unknown version" ? null : route === "new version" ? "1.0.2" : "1.0.1";
      params.packageInstallSpec = route === "artifact" ? "/tmp/candidate.tgz" : "openclaw@latest";
      params.packageTargetVersion = targetVersion ?? undefined;
      params.packageAlreadyCurrent =
        params.updateInstallKind === "package" &&
        isPackageTargetAlreadyCurrent({
          currentVersion: "1.0.1",
          targetVersion,
          target: params.packageInstallSpec,
        });
      if (params.packageAlreadyCurrent) {
        params.alreadyCurrentResult = {
          ...successfulUpdate,
          status: "skipped",
          reason: "already-current",
          before: { version: "1.0.1" },
          after: { version: "1.0.1" },
        };
      }
      const env = {
        OPENCLAW_PROFILE: "system",
        OPENCLAW_STATE_DIR: "/fixture/system",
        OPENCLAW_CONFIG_PATH: "/fixture/system/openclaw.json",
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-system.service",
      };
      vi.spyOn(serviceCandidates, "readGatewayServiceCandidates").mockResolvedValue([
        {
          installed: true,
          running: true,
          loadState: { status: "loaded" },
          env,
          command: {
            programArguments: [process.execPath, `${params.root}/dist/entry.js`, "gateway"],
            environment: env,
          },
          runtime: { status: "running", systemd: { managerUid: 1000 } },
          systemdInstallation: {
            kind: "system",
            system: {
              scope: "system",
              unitName: env.OPENCLAW_SYSTEMD_UNIT,
              unitPath: `/etc/systemd/system/${env.OPENCLAW_SYSTEMD_UNIT}`,
            },
          },
        },
      ]);
      const refuseUpdate = vi.fn(async () => {});
      const preview = await preflightUpdateCommandSchemas({ ...params, refuseUpdate });
      if (params.packageAlreadyCurrent || route === "git") {
        expect(preview).toBeDefined();
        expect(refuseUpdate).not.toHaveBeenCalled();
      } else {
        expect(preview).toBeUndefined();
        expect(refuseUpdate).toHaveBeenCalledWith(
          "managed-service-preflight",
          expect.stringContaining("deployment owner"),
          [
            {
              check: "managed-service-preflight",
              code: "managed-service-preflight",
              message: expect.stringContaining("deployment owner"),
            },
          ],
        );
      }
      if (route === "current config drift") {
        mocks.revalidateSchemaContext.mockRejectedValueOnce(
          new UpdatePreMutationError(
            "database-schema-preflight",
            "Configuration changed during admission.",
          ),
        );
      }
      const execution = await executeMutableUpdate(params);
      if (route === "current") {
        expect(execution).toMatchObject({
          coreAlreadyCurrent: true,
          mutationStarted: false,
          result: { status: "skipped", reason: "already-current" },
        });
        expect(mocks.prepareMutableUpdate).toHaveBeenCalledExactlyOnceWith(
          execution?.profiles[0]?.ownedManagedUpdateEnv,
          expect.any(Number),
          true,
        );
        expect(mocks.pluginPreflight).toHaveBeenCalledOnce();
      } else {
        expect(execution).toMatchObject({
          mutationStarted: false,
          result: {
            status: "error",
            reason:
              route === "current config drift"
                ? "database-schema-preflight"
                : "managed-service-preflight",
          },
        });
        expect(mocks.prepareMutableUpdate).not.toHaveBeenCalled();
      }
      expect(mocks.runPackageUpdate).not.toHaveBeenCalled();
      expect(mocks.runGitUpdate).not.toHaveBeenCalled();
      expect(mocks.serviceStopped).toBe(false);
    },
  );

  it.each(["package", "staged", "git"] as const)(
    "refuses an unsupported native receiver before activation: %s",
    async (route) =>
      withTestDir({ prefix: "native-before-activation-" }, async (dir) => {
        const control = path.join(dir, "leases");
        await fs.mkdir(control);
        vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        const env = { OPENCLAW_STATE_DIR: dir };
        const runId = createUpdateRun(
          {
            trigger: "cli",
            target: route === "git" ? { kind: "git", channel: "dev", tag: "latest" } : {},
          },
          { env },
        ).runId;
        const params = executionParams(route === "git" ? "git" : "package");
        params.root = dir;
        params.updateStepTimeoutMs = 600_000;
        params.opts.run = { runId, env };
        if (route === "staged") {
          params.packageInstallSpec = path.join(dir, "candidate.tgz");
        }
        const events: string[] = [];
        mocks.nativeSupport.mockImplementation(async ({ executor }) => {
          executor.assertCurrent();
          events.push("native-admission");
          return false;
        });
        const candidate = async ({
          validateCandidate,
        }: {
          validateCandidate: (root: string) => Promise<unknown>;
        }) => {
          await validateCandidate(dir);
          // Models the package/Git publisher which follows successful validation.
          events.push("publish");
          return successfulUpdate;
        };
        mocks.runPackageUpdate.mockImplementation(candidate);
        mocks.runGitUpdate.mockImplementation(
          async (
            options: Parameters<typeof import("./update-command-git.js").updateGitInstall>[0],
          ) => {
            if (!options.inspectGitTarget || !options.validateCandidate) {
              throw new Error("Missing actual Git admission callbacks");
            }
            await prepareGitMutation({
              root: dir,
              revision: "1111111111111111111111111111111111111111",
              timeoutMs: params.updateStepTimeoutMs,
              runCommand: async () => ({
                code: 0,
                stderr: "",
                stdout: JSON.stringify({
                  version: "2026.9.4",
                  openclaw: { schemaVersions: { state: 15, agent: 19 } },
                }),
              }),
              beforeGitMutation: options.inspectGitTarget,
            });
            expect(getUpdateRun(runId, { env })?.target).toMatchObject({
              version: "2026.9.4",
              sha: "1111111111111111111111111111111111111111",
            });
            await options.inspectGitTarget({
              sha: "2222222222222222222222222222222222222222",
              schemaVersions: { state: 15, agent: 19 },
            });
            return candidate({ validateCandidate: options.validateCandidate });
          },
        );
        const result = await withUpdateCommandExecutor(runId, async (executor) => {
          mocks.prepareMutableUpdate.mockImplementation(async () => {
            params.opts.run!.executorFence = await executor.enter(dir);
            return {};
          });
          return executeMutableUpdate(params);
        });
        expect(result?.result).toMatchObject({
          status: "error",
          reason: "target-native-unsupported",
        });
        expect(events).toEqual(["native-admission"]);
        expect(mocks.nativeSupport.mock.calls[0]?.[0]).toMatchObject({
          timeoutMs: params.updateStepTimeoutMs,
        });
        expect(mocks.serviceStopped).toBe(false);
        expect(mocks.validateCanary).not.toHaveBeenCalled();
        if (route === "git") {
          expect(getUpdateRun(runId, { env })?.target).toEqual({
            kind: "git",
            channel: "dev",
            tag: "latest",
            sha: "2222222222222222222222222222222222222222",
          });
        }
      }),
  );
});
