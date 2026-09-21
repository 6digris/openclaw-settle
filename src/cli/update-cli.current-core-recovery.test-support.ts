import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { UpdateCliExtractedContext } from "./update-cli.test.js";

export function registerCurrentCoreConvergenceTests(context: UpdateCliExtractedContext): void {
  context.it.each([
    { restart: true, running: true, failure: undefined },
    { restart: false, running: true, failure: undefined },
    { restart: true, running: false, failure: undefined },
    { restart: true, running: true, failure: "doctor" },
    { restart: false, running: true, failure: "doctor" },
    { restart: true, running: true, failure: "stop" },
    { restart: true, running: true, failure: undefined, platform: "linux" as const },
    { restart: true, running: true, failure: "changed owner" },
  ])(
    "converges plugins on an already-current core (restart=$restart, running=$running, failure=$failure, platform=$platform)",
    async ({ restart, running, failure, platform }) => {
      if (platform) {
        context.vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      }
      const root = await context.mockPackageInstallAtCaseDir();
      await context.writeOpenClawPackageFixture(root, context.VERSION);
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
        return await runFixtureCommand(argv, options);
      });

      if (failure === "doctor") {
        const runFixtureWorker = context.requireValue(
          context.vi.mocked(context.runUtf8CommandWithTimeout).getMockImplementation(),
          "fixture worker",
        );
        context.vi
          .mocked(context.runUtf8CommandWithTimeout)
          .mockImplementation(async (argv, options) => {
            if (argv[2] === "doctor" && argv.includes("--repair")) {
              return context.doctorProcessResult({ code: 1, stderr: "plugin Doctor failed" });
            }
            return runFixtureWorker(argv, options);
          });
      } else if (failure === "stop") {
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
        context.expect(readPluginState()).toBe("before-plugin-update");
        context.expect(publishPluginState).toHaveBeenCalledTimes(failure === "doctor" ? 1 : 0);
        context
          .expect(context.freshRestartCalls())
          .toHaveLength(restart && failure !== "changed owner" ? 1 : 0);
        context.expect(context.lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: failure === "doctor" ? "post-update-plugins" : "update-capture-failed",
          ...(failure === "doctor"
            ? {
                run: {
                  origin: { updateRecoveryCapture: { restored: true } },
                  verification: { serviceRunning: restart },
                },
              }
            : {}),
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
