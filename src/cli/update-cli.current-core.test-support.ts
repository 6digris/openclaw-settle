import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import type { UpdateCliExtractedContext } from "./update-cli.context.test-support.js";
import { registerCurrentCoreConvergenceTests } from "./update-cli.current-core-recovery.test-support.js";

export function registerCurrentCoreUpdateTests(context: UpdateCliExtractedContext): void {
  context.it(
    "finishes the core update and retains extended-stable after a plugin convergence failure",
    async () => {
      await context.mockPackageInstallAtCaseDir();
      context.runPostCorePluginConvergenceSpy.mockResolvedValueOnce(
        context.postCoreConvergenceResult({
          warnings: [
            {
              pluginId: "demo",
              reason: "plugin smoke failed",
              message: "plugin smoke failed",
              guidance: ["Run openclaw update repair."],
            },
          ],
          errored: true,
        }),
      );

      await context.updateCommand({
        channel: "extended-stable",
        yes: true,
        json: true,
        restart: false,
      });

      context
        .expect(context.lastReplaceConfigCall()?.nextConfig?.update?.channel)
        .toBe("extended-stable");
      const output = context.lastWriteJsonCall() as UpdateRunResult | undefined;
      context.expect(output?.status).toBe("ok");
      context.expect(output?.postUpdate?.plugins?.status).toBe("warning");
      context.expect(context.defaultRuntime.exit).not.toHaveBeenCalled();
    },
  );

  registerCurrentCoreConvergenceTests(context);

  context.it.each([true, false])(
    "restarts the previous Gateway when current-core capture is refused after stop (restart=%s)",
    async (restart) => {
      const root = await context.mockPackageInstallAtCaseDir();
      await context.writeOpenClawPackageFixture(root, context.VERSION);
      context.readPackageVersion.mockResolvedValue(context.VERSION);
      context.primeNpmChannelTag("latest", context.VERSION);
      context.mockFileBackedPathExists();
      context.vi.mocked(context.resolveGatewayInstallEntrypoint).mockReset();
      context.mockRunningManagedGateway([
        "node",
        context.path.join(root, "dist", "index.js"),
        "gateway",
        "run",
      ]);
      context.mockPackageGatewayLifecycle();
      const originalConfig = await context.fs.readFile(context.resolveConfigPath(), "utf8");
      const mutation = context.vi.fn();
      context.updateNpmInstalledPlugins.mockImplementationOnce(async (params) => {
        await params.preparePersistentEffect?.();
        mutation();
        throw new Error("The protected mutation must not start after refused capture");
      });
      context.vi.spyOn(context.fsSync, "statfsSync").mockImplementation(() =>
        context.statfsFixture({
          bavail: context.serviceStop.mock.calls.length > 0 ? 256 : 1024 * 1024,
          bsize: 1024 * 1024,
        }),
      );

      await context
        .expect(context.updateCommand({ yes: true, json: true, restart }))
        .rejects.toEqual(new context.ExitError(1));

      context.expect(context.serviceStop).toHaveBeenCalledOnce();
      context.expect(mutation).not.toHaveBeenCalled();
      context.expect(context.freshRestartCalls()).toHaveLength(1);
      context
        .expect(await context.fs.readFile(context.resolveConfigPath(), "utf8"))
        .toBe(originalConfig);
      context.expect(context.lastWriteJsonCall()).toMatchObject({
        status: "error",
        reason: "update-capture-failed",
        recovery: { serviceRestartSafe: true, service: "healthy" },
      });
      context.expect(context.getErrorOutput()).toContain("Insufficient update recovery capacity");
    },
  );

  context.it.each(["package", "git"] as const)(
    "settles a retained 9.2 capture before a current-core no-op without stopping the Gateway (%s)",
    async (installKind) => {
      const root = await context.mockPackageInstallAtCaseDir();
      await context.writeOpenClawPackageFixture(root, "2026.9.3");
      context.readPackageVersion.mockResolvedValue("2026.9.3");
      context.primeNpmChannelTag("latest", "2026.9.3");
      if (installKind === "git") {
        context.vi.mocked(context.resolveUpdateInstallKind).mockResolvedValue("git");
        context.vi.mocked(context.resolveUpdateInstallIdentity).mockResolvedValue({
          installKind: "git",
          git: { branch: "main", tag: null },
        });
        context.vi.mocked(context.updateGitCheckout).mockResolvedValueOnce({
          status: "skipped",
          mode: "git",
          root,
          reason: "already-current",
          before: { version: "2026.9.3", sha: "a".repeat(40) },
          steps: [],
          durationMs: 1,
        });
      }
      context.mockRunningManagedGateway([
        "node",
        context.path.join(root, "dist", "index.js"),
        "gateway",
        "run",
      ]);
      const { createUpdateRecoveryBackup } = await import("../infra/update-recovery-backup.js");
      const { finishUpdateRun, recordUpdateRunVerification, recordUpdateRunStep } =
        await import("../infra/update-run-ledger.js");
      const driver = await import("../infra/update-run-driver.js");
      const saved = context.createUpdateRun({ trigger: "cli" });
      const creator = context.requireValue(
        driver.readUpdateRunDriver(),
        "synthetic capture host identity",
      );
      const readDriver = context.vi
        .spyOn(driver, "readUpdateRunDriver")
        .mockReturnValue({ ...creator, pid: 2147483647 });
      const capture = await createUpdateRecoveryBackup({
        runId: saved.runId,
        installRoot: root,
        assertOwned() {},
      });
      readDriver.mockRestore();
      recordUpdateRunVerification(saved.runId, {
        booted: true,
        serviceRunning: true,
        runningVersion: "2026.9.3",
        versionMatch: true,
        pluginErrors: [],
        readyz: true,
        settled: true,
        channelsReady: true,
      });
      for (const step of ["openclaw doctor", "post-update verification", "verifying"]) {
        recordUpdateRunStep(saved.runId, { step, status: "completed", endedAtMs: Date.now() });
      }
      finishUpdateRun(saved.runId, { status: "succeeded", after: { version: "2026.9.3" } });
      context
        .openOpenClawStateDatabase()
        .db.prepare(
          "UPDATE update_runs SET origin_json = '{}', verification_json = json_remove(verification_json, '$.readyz', '$.settled', '$.channelsReady') WHERE run_id = ?",
        )
        .run(saved.runId);
      const config = await context.fs.readFile(context.resolveConfigPath(), "utf8");

      if (installKind === "package") {
        await context.writeJsonFixture(context.path.join(root, "package.json"), {
          name: "openclaw",
          version: "2026.9.3",
          engines: { node: ">=22.19.0" },
          openclaw: { schemaVersions: { state: 17, agent: 11 } },
        });
        context.vi.mocked(context.fetchNpmPackageTargetStatus).mockResolvedValue(
          context.packageTargetStatus({
            version: "2026.9.3",
            nodeEngine: ">=99.0.0",
            schemaVersions: { state: 16, agent: 11 },
          }),
        );
        context.nodeVersionSatisfiesEngine.mockImplementation(
          (_version: string, engine: string | null) => engine !== ">=99.0.0",
        );
        context.databasePreflightMocks.preflightOpenClawDatabaseSchemas.mockImplementation(
          ({ supportedVersions }: { supportedVersions: { state: number; agent: number } }) => ({
            incompatible:
              supportedVersions.state < 17
                ? [
                    {
                      kind: "state",
                      path: context.path.join(
                        context.profileStateDir(),
                        "state",
                        "openclaw.sqlite",
                      ),
                      foundVersion: 17,
                      supportedVersion: supportedVersions.state,
                      writerAppVersion: "2026.9.3",
                    },
                  ]
                : [],
            indeterminate: [],
          }),
        );
      }
      await context
        .expect(
          context.updateCommand({ yes: true, json: true }).catch((error: unknown) => ({
            error,
            result: context.lastWriteJsonCall(),
          })),
        )
        .resolves.toBeUndefined();

      context.expectNoSideEffects(
        context.serviceStop,
        context.serviceStart,
        context.serviceRestart,
      );
      context.expect(context.freshRestartCalls()).toHaveLength(0);
      context.expect(context.getLogOutput()).not.toContain("Resolved update capture retired");
      context.expect(context.packageInstallCommandCall()).toBeUndefined();
      context.expect(context.lastWriteJsonCall()).toMatchObject({
        status: "skipped",
        reason: "already-current",
        steps: [],
      });
      context.expect(await context.fs.readFile(context.resolveConfigPath(), "utf8")).toBe(config);
      await context
        .expect(context.fs.lstat(capture.directory))
        .rejects.toMatchObject({ code: "ENOENT" });
      context.expect(context.getUpdateRun(saved.runId)).toMatchObject({
        status: "succeeded",
        origin: { updateRecoveryCapture: { retirement: { outcome: "committed" } } },
      });
      if (installKind === "package") {
        context
          .expect(context.databasePreflightMocks.preflightOpenClawDatabaseSchemas)
          .toHaveBeenCalledWith(
            context.expect.objectContaining({ supportedVersions: { state: 17, agent: 11 } }),
          );
      }
    },
  );

  context.it(
    "refuses an independent agent writer before stopping the current-core Gateway",
    async () => {
      const root = await context.mockPackageInstallAtCaseDir();
      await context.writeOpenClawPackageFixture(root, context.VERSION);
      context.readPackageVersion.mockResolvedValue(context.VERSION);
      context.primeNpmChannelTag("latest", context.VERSION);
      context.mockFileBackedPathExists();
      context.vi.mocked(context.resolveGatewayInstallEntrypoint).mockReset();
      context.mockRunningManagedGateway([
        "node",
        context.path.join(root, "dist", "index.js"),
        "gateway",
        "run",
      ]);
      const { claimOpenClawAgentDatabaseLease, releaseOpenClawAgentDatabaseLease } =
        await import("../state/openclaw-agent-db-lease.js");
      const lease = claimOpenClawAgentDatabaseLease({
        agentId: "main",
        path: context.path.join(
          context.profileStateDir(),
          "agents",
          "main",
          "agent",
          "openclaw-agent.sqlite",
        ),
      });
      const mutation = context.vi.fn();
      context.updateNpmInstalledPlugins.mockImplementationOnce(async (params) => {
        await params.preparePersistentEffect?.();
        mutation();
        throw new Error("Protected mutation should not run with an independent writer");
      });
      try {
        await context
          .expect(context.updateCommand({ yes: true, json: true }))
          .rejects.toEqual(new context.ExitError(1));
        context.expectNoSideEffects(
          context.serviceStop,
          context.serviceStart,
          context.serviceRestart,
          mutation,
        );
        context.expect(context.freshRestartCalls()).toHaveLength(0);
        context.expect(context.getErrorOutput()).toContain("independent or unverified writer");
        context.expect(context.lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "update-capture-failed",
        });
      } finally {
        releaseOpenClawAgentDatabaseLease(lease);
      }
    },
  );

  context.it(
    "refreshes stale systemd policy on an already-current core without stopping the Gateway",
    async () => {
      context.vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const root = await context.mockPackageInstallAtCaseDir("openclaw-update", context.VERSION);
      await context.writeOpenClawPackageFixture(root, context.VERSION);
      context.mockFileBackedPathExists();
      context.vi.mocked(context.resolveGatewayInstallEntrypoint).mockReset();
      context.readPackageVersion.mockResolvedValue(context.VERSION);
      context.primeNpmChannelTag("latest", context.VERSION);
      context.mockRunningManagedGateway([
        "node",
        context.path.join(root, "dist", "index.js"),
        "gateway",
        "run",
      ]);
      context.systemdPolicy.mockResolvedValue(true);

      await context.updateCommand({ yes: true, json: true });

      context
        .expect(context.systemdPolicy)
        .toHaveBeenCalledWith(context.expect.objectContaining({ root, stopping: false }));
      context.expectNoSideEffects(
        context.serviceStop,
        context.serviceStart,
        context.serviceRestart,
      );
      context
        .expect(context.lastWriteJsonCall())
        .toMatchObject({ status: "skipped", reason: "already-current" });
    },
  );

  context.it.each(context.runtimeRecovery.alreadyCurrentHandoffCases(context.VERSION))(
    "keeps the selected target through already-current managed handoff ($packageInstallSpec, $channel)",
    async ({ packageInstallSpec, channel, expectedTag }) => {
      const { finishAlreadyCurrentUpdate } = await import("./update-cli/update-command-noop.js");
      context.vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      const { pkgRoot: root, entryPath } = await context.setupInstalledPackageRoot(
        context.createCaseDir("current-artifact-handoff"),
        context.VERSION,
      );
      context.mockFileBackedPathExists();
      context.vi.mocked(context.resolveGatewayInstallEntrypoint).mockResolvedValue(entryPath);
      context.mockRunningManagedGateway([process.execPath, entryPath, "gateway", "run"]);
      context.managedUpdateHandoff.start.mockResolvedValue({
        status: "started",
        handoffId: "current-artifact-handoff",
        installRoot: root,
        logPath: "/tmp/current-artifact-handoff.log",
        command: "openclaw update --yes",
        pid: 12345,
      });
      context.managedUpdateHandoff.transfer.mockResolvedValue(true);
      const refuseUpdate = context.vi.fn();

      await context.withEnvAsync({ INVOCATION_ID: "current-artifact-invocation" }, () =>
        finishAlreadyCurrentUpdate({
          root,
          packageInstallSpec,
          opts: { yes: true, json: true },
          result: {
            status: "skipped",
            mode: "npm",
            root,
            reason: "already-current",
            before: { version: context.VERSION },
            after: { version: context.VERSION },
            steps: [],
            durationMs: 1,
          },
          requestedChannel: null,
          storedChannel: channel,
          channel,
          shouldRestart: true,
          updateStepTimeoutMs: 1000,
          invocationCwd: process.cwd(),
          startedAt: Date.now(),
          controlPlaneUpdateSentinelMeta: null,
          managedServiceRootRedirect: null,
          stop: context.vi.fn(),
          refuseUpdate,
        }),
      );

      context.expect(refuseUpdate).not.toHaveBeenCalled();
      context
        .expect(
          context.managedUpdateHandoff.start.mock.calls.map(([params]) => ({
            root: params.root,
            tag: params.tag,
          })),
        )
        .toEqual([{ root, tag: expectedTag }]);
      context.expectNoSideEffects(
        context.serviceStop,
        context.serviceRestart,
        context.updateNpmInstalledPlugins,
      );
    },
  );

  context.registerAlreadyCurrentAdmissionTests({
    prepareCurrentPackage: async (prefix) => {
      const root = await context.mockPackageInstallAtCaseDir(prefix, context.VERSION);
      context.readPackageVersion.mockResolvedValue(context.VERSION);
      context.primeNpmChannelTag("latest", context.VERSION);
      return root;
    },
    createCaseDir: context.createCaseDir,
    writeServicePackage: (root) =>
      context.writeOpenClawPackageFixture(root, context.VERSION, { entrySource: "export {};\n" }),
    mockFileBackedPathExists: context.mockFileBackedPathExists,
    mockRunningManagedGateway: context.mockRunningManagedGateway,
    primeServiceCommand: context.primeServiceCommand,
    useFileBackedConfig: context.useFileBackedConfig,
    resolveConfigPath: context.resolveConfigPath,
    updateCommand: context.updateCommand,
    ExitError: context.ExitError,
    lastWriteJsonCall: context.lastWriteJsonCall,
    getErrorOutput: context.getErrorOutput,
    packageInstallCommandCall: context.packageInstallCommandCall,
    freshRestartCalls: context.freshRestartCalls,
    expectNoSideEffects: context.expectNoSideEffects,
    mocks: {
      pluginAvailabilityPreflight: context.pluginAvailabilityPreflight,
      syncPluginsForUpdateChannel: context.syncPluginsForUpdateChannel,
      updateNpmInstalledPlugins: context.updateNpmInstalledPlugins,
      replaceConfigFile: context.vi.mocked(context.replaceConfigFile),
      serviceStop: context.serviceStop,
      serviceStart: context.serviceStart,
      serviceRestart: context.serviceRestart,
      prepareRestartScript: context.prepareRestartScript,
    },
  });

  context.it.each([true, false])(
    "converges a current Git core using its before-only version receipt (runtime compatible=%s)",
    async (compatible) => {
      // This case specifies system-runtime guidance, independent of the host Node manager.
      context.vi
        .spyOn(context.versionManagerPath, "resolveNodeVersionManager")
        .mockReturnValue("system");
      const fixture = context.runtimeRecovery.currentGitCoreFixture(process.cwd(), context.VERSION);
      context.readPackageVersion.mockResolvedValue(context.VERSION);
      context.vi.mocked(context.updateGitCheckout).mockResolvedValueOnce(fixture.outcome);
      context.nodeVersionSatisfiesEngine.mockReturnValue(compatible);
      context.vi
        .mocked(context.resolveGatewayInstallEntrypoint)
        .mockResolvedValue(context.FRESH_POST_UPDATE_ENTRYPOINT);
      const command = context.updateCommand({ yes: true, restart: false, json: true });
      if (compatible) {
        await command;
        context
          .expect(context.pluginAvailabilityPreflight)
          .toHaveBeenCalledWith(
            context.expect.objectContaining({ targetVersion: context.VERSION }),
          );
        context.expect(context.updateNpmInstalledPlugins).toHaveBeenCalledOnce();
        context.expect(context.lastWriteJsonCall()).toMatchObject(fixture.converged);
      } else {
        await context.expect(command).rejects.toEqual(new context.ExitError(1));
        context.expect(context.lastWriteJsonCall()).toMatchObject(fixture.runtimeRefusal);
        context.expectNoSideEffects(
          context.pluginAvailabilityPreflight,
          context.updateNpmInstalledPlugins,
        );
      }
      context.expectNoSideEffects(
        context.serviceStop,
        context.serviceRestart,
        context.runDaemonRestart,
      );
    },
  );

  context.it.each([false, true])(
    "reports retained pins on an already-current core (json=%s)",
    async (json) => {
      const root = await context.mockPackageInstallAtCaseDir();
      await context.writeOpenClawPackageFixture(root, context.VERSION);
      context.readPackageVersion.mockResolvedValue(context.VERSION);
      context.primeNpmChannelTag("latest", context.VERSION);
      context.mockRunningManagedGateway([
        "node",
        context.path.join(root, "dist", "index.js"),
        "gateway",
        "run",
      ]);
      const installPath = context.createCaseDir("current-core-pin");
      await context.fs.mkdir(installPath, { recursive: true });
      await context.writeJsonFixture(context.path.join(installPath, "package.json"), {
        name: "@openclaw/discord",
        version: "2026.9.2",
      });
      const records: Record<string, PluginInstallRecord> = {
        discord: {
          source: "npm",
          spec: "@openclaw/discord@2026.9.2",
          installPath,
          version: "2026.9.2",
        },
      };
      context.loadInstalledPluginIndexInstallRecords.mockResolvedValue(records);
      const message =
        "discord is pinned to @openclaw/discord@2026.9.2 (installed 2026.9.2); registry latest resolves to 2026.9.3. Pass `openclaw plugins update @openclaw/discord@latest` to replace this version pin.";
      context.mockNpmPluginOutcomes(
        [
          {
            pluginId: "discord",
            status: "unchanged",
            currentVersion: "2026.9.2",
            nextVersion: "2026.9.3",
            message,
          },
        ],
        false,
        { ...context.baseConfig, plugins: { ...context.baseConfig.plugins, installs: records } },
      );
      context.runPostCorePluginConvergenceSpy.mockResolvedValueOnce({
        ...context.postCoreConvergenceResult(),
        installRecords: records,
      });

      await context.updateCommand({ yes: true, json });

      context.expect(context.updateNpmInstalledPlugins).toHaveBeenCalledOnce();
      context.expectNoSideEffects(
        context.serviceStop,
        context.serviceRestart,
        context.runDaemonRestart,
      );
      context.expect(context.freshRestartCalls()).toHaveLength(0);
      if (json) {
        context.expect(context.lastWriteJsonCall()).toMatchObject({
          status: "skipped",
          reason: "already-current",
          postUpdate: {
            plugins: {
              status: "warning",
              changed: false,
              warnings: [
                context.expect.objectContaining({
                  pluginId: "discord",
                  reason: "retained-plugin-pin",
                  message: context.expect.stringContaining(message),
                }),
              ],
            },
          },
        });
      } else {
        context.expect(context.stripAnsi(context.getLogOutput())).toContain(message);
      }
      context
        .expect(context.writePersistedInstalledPluginIndexInstallRecordsWithLease)
        .not.toHaveBeenCalled();
      context.expect(records.discord?.spec).toBe("@openclaw/discord@2026.9.2");
    },
  );

  context.it.each([true, false])(
    "never stops an unchanged same-version managed gateway (restart=%s)",
    async (restart) => {
      const root = await context.mockPackageInstallAtCaseDir(
        "openclaw-current-package",
        context.VERSION,
      );
      context.readPackageVersion.mockResolvedValue(context.VERSION);
      context.primeNpmChannelTag("latest", context.VERSION);
      context.mockRunningManagedGateway([
        "node",
        context.path.join(root, "dist", "index.js"),
        "gateway",
        "run",
      ]);

      await context.updateCommand({ yes: true, restart, json: true });

      context.expectNoSideEffects(
        context.serviceStop,
        context.serviceRestart,
        context.runDaemonRestart,
        context.candidateValidation,
      );
      context.expect(context.updateNpmInstalledPlugins).toHaveBeenCalledOnce();
      context.expect(context.packageInstallCommandCall()?.[0]).toBeUndefined();
      context.expect(context.replaceConfigFile).not.toHaveBeenCalled();
      context
        .expect(context.lastWriteJsonCall())
        .toMatchObject({ status: "skipped", reason: "already-current" });
      const result = context.lastWriteJsonCall() as UpdateRunResult;
      context
        .expect(context.getUpdateRun(context.requireValue(result.runId, "no-op run id")))
        .toMatchObject({
          status: "skipped",
          reason: "already-current",
          downtimeMs: 0,
        });
    },
  );
}
