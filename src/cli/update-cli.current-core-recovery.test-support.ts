import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import type { UpdateCliExtractedContext } from "./update-cli.test.js";

/** The command double supplies effects; keep real worker presence and child PID admission. */
export async function writeCurrentCoreDoctorFixture(root: string): Promise<void> {
  const worker = path.join(
    root,
    "dist",
    runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
  );
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.writeFile(worker, "// Delegated Doctor effects are supplied by the test transport.\n");
  await writePackageDistInventory(root);
}

/** No reverse migration owner exists for this deliberately unregistered plugin database. */
async function expectRetainedPluginGenerations(
  context: UpdateCliExtractedContext,
  stateMarker: string,
): Promise<void> {
  const { verifyUpdateRecoveryBackup } = await import("../infra/update-recovery-backup.js");
  const run = context.requireValue(context.listUpdateRuns({ limit: 1 })[0], "failed plugin run");
  const capture = context.requireValue(run.origin.updateRecoveryCapture, "retained capture");
  expect(capture.restored).not.toBe(true);
  const directory = path.join(
    `${await fs.realpath(context.resolveStateDir())}.update-captures`,
    run.runId,
  );
  for (const [kind, value] of [
    ["baseline", "before-plugin-update"],
    ["candidate", "after-plugin-update"],
  ] as const) {
    const root = kind === "baseline" ? directory : path.join(directory, kind);
    const manifestPath = path.join(root, "manifest.json");
    const manifestSha256 = createHash("sha256")
      .update(await fs.readFile(manifestPath))
      .digest("hex");
    if (kind === "baseline") {
      expect(manifestSha256).toBe(capture.manifestSha256);
    }
    const manifest = await verifyUpdateRecoveryBackup({
      directory: root,
      manifestPath,
      manifestSha256,
    });
    expect(manifest.runId).toBe(run.runId);
    expect(manifest.generation?.kind).toBe(kind);
    if (kind === "candidate") {
      expect(manifest.generation).toMatchObject({ baselineSha256: capture.manifestSha256 });
    }
    const entry = manifest.entries.find(
      (candidate) => candidate.kind === "file" && candidate.sourcePath === stateMarker,
    );
    if (!entry || entry.kind !== "file") {
      throw new Error(`Missing ${kind} plugin capture`);
    }
    const database = new context.DatabaseSync(path.join(root, entry.archivePath), {
      readOnly: true,
    });
    try {
      expect(database.prepare("SELECT value FROM plugin_state").get()?.value).toBe(value);
    } finally {
      database.close();
    }
  }
}

export function registerCurrentCoreConvergenceTests(context: UpdateCliExtractedContext): void {
  context.it.each(context.runtimeRecovery.alreadyCurrentConvergenceCases)(
    "converges plugins on an already-current core (restart=$restart, running=$running, failure=$failure, platform=$platform)",
    async ({ restart, running, failure, platform }) => {
      if (platform) {
        context.vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      }
      const root = await context.mockPackageInstallAtCaseDir();
      await context.writeOpenClawPackageFixture(root, context.VERSION);
      await writeCurrentCoreDoctorFixture(root);
      context.mockFileBackedPathExists();
      context.vi.mocked(context.resolveGatewayInstallEntrypoint).mockReset();
      context.readPackageVersion.mockResolvedValue(context.VERSION);
      context.primeNpmChannelTag("latest", context.VERSION);
      if (running) {
        context.mockRunningManagedGateway([
          "node",
          context.path.join(root, "dist", "index.js"),
          "gateway",
          "run",
        ]);
      }
      const installPath = context.createCaseDir("current-core-plugin");
      await context.fs.mkdir(installPath, { recursive: true });
      await context.writeJsonFixture(context.path.join(installPath, "package.json"), {
        name: "@openclaw/brave-plugin",
        version: "2026.9.2",
      });
      const record: PluginInstallRecord = {
        source: "npm",
        spec: "@openclaw/brave-plugin",
        installPath,
        version: "2026.9.2",
      };
      context.loadInstalledPluginIndexInstallRecords.mockResolvedValue({ brave: record });
      const updatedRecord = { ...record, version: "2026.9.3" };
      const stateMarker = context.path.join(
        context.resolveStateDir(),
        "plugin-update-proof.sqlite",
      );
      const initialPluginDatabase = new context.DatabaseSync(stateMarker);
      try {
        initialPluginDatabase.exec("CREATE TABLE plugin_state (value TEXT NOT NULL)");
        initialPluginDatabase
          .prepare("INSERT INTO plugin_state VALUES (?)")
          .run("before-plugin-update");
      } finally {
        initialPluginDatabase.close();
      }
      const readPluginState = () => {
        const database = new context.DatabaseSync(stateMarker, { readOnly: true });
        try {
          return database.prepare("SELECT value FROM plugin_state").get()?.value;
        } finally {
          database.close();
        }
      };
      const publishPluginState = context.vi.fn(async () => {
        const database = new context.DatabaseSync(stateMarker);
        try {
          database.prepare("UPDATE plugin_state SET value = ?").run("after-plugin-update");
        } finally {
          database.close();
        }
      });
      context.updateNpmInstalledPlugins.mockImplementationOnce(
        async (
          params: Parameters<typeof import("../plugins/update.js").updateNpmInstalledPlugins>[0],
        ) => {
          if (failure === "changed owner") {
            context.primeServiceCommand([
              "node",
              context.path.join(root, "dist", "index.js"),
              "gateway",
              "run",
              "--port",
              "19102",
            ]);
          }
          context.expect(params.beforePersistentEffect).toBeTypeOf("function");
          await params.preparePersistentEffect?.();
          params.beforePersistentEffect?.();
          await publishPluginState();
          return {
            changed: true,
            config: {
              ...context.baseConfig,
              plugins: { ...context.baseConfig.plugins, installs: { brave: updatedRecord } },
            },
            outcomes: [
              {
                pluginId: "brave",
                status: "updated",
                currentVersion: "2026.9.2",
                nextVersion: "2026.9.3",
                message: "Updated brave: 2026.9.2 -> 2026.9.3.",
              },
            ],
          };
        },
      );
      context.runPostCorePluginConvergenceSpy.mockResolvedValueOnce({
        ...context.postCoreConvergenceResult(),
        installRecords: { brave: updatedRecord },
      });
      const runFixtureCommand = context.requireValue(
        context.vi.mocked(context.runCommandWithTimeout).getMockImplementation(),
        "fixture command",
      );
      context.vi.mocked(context.runCommandWithTimeout).mockImplementation(async (argv, options) => {
        if (argv[2] === "gateway" && argv[3] === "restart") {
          context
            .expect(readPluginState())
            .toBe(failure ? "before-plugin-update" : "after-plugin-update");
        }
        if (failure === "doctor" && argv.at(-1) === "--doctor") {
          return context.doctorProcessResult({ code: 1, stderr: "plugin Doctor failed" });
        }
        return await runFixtureCommand(argv, options);
      });

      if (failure === "stop") {
        context.serviceStop.mockImplementationOnce(async (params: { onMutation?: () => void }) => {
          context.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
          params.onMutation?.();
          throw new Error("listener check failed after stop");
        });
      }
      if (failure) {
        await context
          .expect(context.updateCommand({ yes: true, restart, json: true }))
          .rejects.toEqual(new context.ExitError(1));
        context
          .expect(context.serviceStop)
          .toHaveBeenCalledTimes(failure === "changed owner" ? 0 : 1);
        if (failure === "doctor") {
          context.expect(readPluginState()).toBe("after-plugin-update");
          context.expect(publishPluginState).toHaveBeenCalledOnce();
          context.expect(context.freshRestartCalls()).toHaveLength(0);
          context.expect(context.packageInstallCommandCall()).toBeUndefined();
          context.expect(context.lastWriteJsonCall()).toMatchObject({
            status: "error",
            recovery: { serviceRestartSafe: false },
          });
          await expectRetainedPluginGenerations(context, stateMarker);
          return;
        }
        context.expect(readPluginState()).toBe("before-plugin-update");
        context.expect(publishPluginState).not.toHaveBeenCalled();
        context
          .expect(context.freshRestartCalls())
          .toHaveLength(restart && failure !== "changed owner" ? 1 : 0);
        context.expect(context.lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "update-capture-failed",
        });
        context.expect(context.packageInstallCommandCall()).toBeUndefined();
        return;
      }
      await context.updateCommand({ yes: true, restart, json: true });

      context.expect(context.updateNpmInstalledPlugins).toHaveBeenCalledOnce();
      context.expect(context.updateNpmInstalledPlugins).toHaveBeenCalledWith(
        context.expect.objectContaining({
          coreVersion: context.VERSION,
          syncOfficialPluginInstalls: true,
        }),
      );
      context.expect(context.lastWriteJsonCall()).toMatchObject({
        status: "ok",
        postUpdate: {
          plugins: {
            changed: true,
            warnings: [],
            npm: {
              outcomes: [context.expect.objectContaining({ pluginId: "brave", status: "updated" })],
            },
          },
        },
      });
      context.expect(context.serviceStop).toHaveBeenCalledTimes(running ? 1 : 0);
      context.expect(publishPluginState).toHaveBeenCalledOnce();
      context.expect(readPluginState()).toBe("after-plugin-update");
      context.expect(context.freshRestartCalls()).toHaveLength(restart && running ? 1 : 0);
      context.expect(context.packageInstallCommandCall()).toBeUndefined();
      context.expect(context.candidateValidation).not.toHaveBeenCalled();
      if (!restart) {
        context.expect(context.lastWriteJsonCall()).toMatchObject({
          run: {
            origin: {
              nextAction: context.expect.stringContaining("Gateway restart skipped (--no-restart)"),
            },
          },
        });
      }
      if (running) {
        context
          .expect(context.serviceStop.mock.invocationCallOrder[0])
          .toBeLessThan(
            context.requireValue(
              publishPluginState.mock.invocationCallOrder[0],
              "plugin state publication",
            ),
          );
      }
    },
  );
}
