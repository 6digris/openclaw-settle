import type fsSync from "node:fs";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import type { UpdateCliExtractedContext } from "./update-cli.test.js";

export function registerUpdateCapacityTests(context: UpdateCliExtractedContext): void {
  context.it(
    "reports a same-version channel switch as successful without updating the package",
    async () => {
      const root = await context.mockPackageInstallAtCaseDir(
        "openclaw-current-package",
        context.VERSION,
      );
      const stateDir = context.tempDirs.make("openclaw-update-channel-switch-");
      context.initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
      context.readPackageVersion.mockResolvedValue(context.VERSION);
      context.primeNpmChannelTag("beta", context.VERSION);
      context.vi
        .mocked(context.readConfigFileSnapshot)
        .mockResolvedValue(context.configSnapshot({ update: { channel: "stable" } }));
      await context.writeJsonFixture(context.path.join(stateDir, "openclaw.json"), {
        update: { channel: "stable" },
      });
      context.mockRunningManagedGateway([
        "node",
        context.path.join(root, "dist", "index.js"),
        "gateway",
        "run",
      ]);

      await context.withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await context.updateCommand({ channel: "beta", yes: true, restart: true, json: true });
      });

      context.expect(context.lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("beta");
      context.expectNoSideEffects(
        context.serviceStop,
        context.serviceRestart,
        context.runDaemonRestart,
        context.candidateValidation,
      );
      context.expect(context.updateNpmInstalledPlugins).toHaveBeenCalledOnce();
      context.expect(context.packageInstallCommandCall()?.[0]).toBeUndefined();
      context.expect(context.doctorCommandCall()).toBeUndefined();
      context.expect(context.lastWriteJsonCall()).toMatchObject({ status: "ok" });
      context.expect(context.lastWriteJsonCall()).not.toHaveProperty("reason");
      const result = context.lastWriteJsonCall() as UpdateRunResult;
      context
        .expect(
          context.getUpdateRun(context.requireValue(result.runId, "channel switch run id"), {
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          }),
        )
        .toMatchObject({ status: "succeeded", downtimeMs: 0 });
    },
  );

  context.it(
    "keeps an explicit same-version channel no-op skipped without snapshot capacity or config rewrites",
    async () => {
      const root = await context.mockPackageInstallAtCaseDir(
        "openclaw-current-package",
        context.VERSION,
      );
      const stateDir = context.tempDirs.make("openclaw-update-channel-noop-");
      context.initializeExistingUpdateProfile({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
      context.readPackageVersion.mockResolvedValue(context.VERSION);
      context.primeNpmChannelTag("beta", context.VERSION);
      context.vi
        .mocked(context.readConfigFileSnapshot)
        .mockResolvedValue(context.configSnapshot({ update: { channel: "beta" } }));
      await context.writeJsonFixture(context.path.join(stateDir, "openclaw.json"), {
        update: { channel: "beta" },
      });
      context.mockRunningManagedGateway([
        "node",
        context.path.join(root, "dist", "index.js"),
        "gateway",
        "run",
      ]);

      context.vi
        .spyOn(context.fsSync, "statfsSync")
        .mockReturnValue(context.statfsFixture({ bavail: 0 }));

      await context.withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        await context.updateCommand({ channel: "beta", yes: true, restart: true, json: true });
      });

      context.expect(context.replaceConfigFile).not.toHaveBeenCalled();
      context.expectNoSideEffects(
        context.serviceStop,
        context.serviceRestart,
        context.runDaemonRestart,
        context.candidateValidation,
      );
      context.expect(context.updateNpmInstalledPlugins).toHaveBeenCalledOnce();
      context.expect(context.packageInstallCommandCall()?.[0]).toBeUndefined();
      context.expect(context.doctorCommandCall()).toBeUndefined();
      context
        .expect(context.lastWriteJsonCall())
        .toMatchObject({ status: "skipped", reason: "already-current" });
    },
  );

  context.it("completes an equal-version Git-to-package switch", async () => {
    const { nodeModules, pkgRoot } = await context.setupInstalledPackageRoot(
      context.createCaseDir("openclaw-git-to-package-same-version"),
      context.VERSION,
    );
    await context.fs.writeFile(context.path.join(pkgRoot, "dist", "index.js"), "git runtime\n");
    await context.writePackageDistInventory(pkgRoot);
    context.mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] !== "npm" || argv[1] !== "i") {
        return;
      }
      await context.writeNpmPackageInstall(argv, pkgRoot, context.VERSION);
      const stagePrefix = context.requireValue(argv[argv.indexOf("--prefix") + 1], "staged prefix");
      const stageRoot = context.path.join(stagePrefix, "lib", "node_modules", "openclaw");
      await context.fs.writeFile(
        context.path.join(stageRoot, "dist", "index.js"),
        "package runtime\n",
      );
      await context.writePackageDistInventory(stageRoot);
    });
    context.mockCurrentProcessFreshDoctor({ packageRoot: pkgRoot });
    context.vi.mocked(context.resolveUpdateInstallKind).mockResolvedValue("git");
    context.vi.mocked(context.resolveUpdateInstallIdentity).mockResolvedValue({
      installKind: "git",
      git: { tag: `v${context.VERSION}`, branch: "main" },
    });
    context.readPackageVersion.mockImplementation(async (root: string) => {
      const manifest = JSON.parse(
        await context.fs.readFile(context.path.join(root, "package.json"), "utf8"),
      ) as {
        version: string;
      };
      return manifest.version;
    });
    context.primeNpmChannelTag("latest", context.VERSION);
    context.vi
      .mocked(context.readConfigFileSnapshot)
      .mockResolvedValue(context.configSnapshot({ update: { channel: "dev" } }));

    await context.updateCommand({ channel: "stable", yes: true, restart: false, json: true });

    context.expectPackageInstallSpec(`openclaw@${context.VERSION}`);
    context.expect(context.candidateValidation).toHaveBeenCalled();
    await context
      .expect(context.fs.readFile(context.path.join(pkgRoot, "dist", "index.js"), "utf8"))
      .resolves.toBe("package runtime\n");
    context.expect(context.lastReplaceConfigCall()?.nextConfig?.update?.channel).toBe("stable");
    context.expect(context.lastWriteJsonCall()).toMatchObject({
      status: "ok",
      mode: "npm",
      root: pkgRoot,
    });
    context.expect((context.lastWriteJsonCall() as UpdateRunResult).reason).toBeUndefined();
  });

  context.it("runs the package update when latest target lookup is unresolved", async () => {
    context.setTty(false);
    await context.mockPackageInstallAtCaseDir();
    context.readPackageVersion.mockResolvedValue("2026.4.22");
    context.primeNpmChannelTag("latest", null);
    context.mockCurrentProcessFreshDoctor();

    await context.updateCommand({});

    context.expect(context.getErrorOutput()).not.toContain("Downgrade confirmation required.");
    context.expect(context.defaultRuntime.exit).not.toHaveBeenCalled();
    context.expectPackageInstallSpec("openclaw@latest");
    context
      .expect(
        context.vi
          .mocked(context.runUtf8CommandWithTimeout)
          .mock.calls.filter(([argv]) => argv[2] === "doctor"),
      )
      .toEqual([]);
  });

  context.it(
    "blocks the package update when a non-latest dist-tag lookup is unresolved",
    async () => {
      context.setTty(false);
      await context.mockPackageInstallAtCaseDir();
      context.readPackageVersion.mockResolvedValue("2026.4.22");
      context.vi.mocked(context.fetchNpmTagVersion).mockResolvedValue({
        tag: "next",
        version: null,
        error: "HTTP 404",
      });

      await context.updateCommand({ tag: "next" });

      context.expect(context.getErrorOutput()).toContain("Downgrade confirmation required.");
      context.expect(context.defaultRuntime.exit).toHaveBeenCalledWith(1);
      context.expect(context.packageInstallCommandCall()?.[0]).toBeUndefined();
    },
  );

  context.it.each([false, true])(
    "refuses low-capacity activation before stopping the Gateway (running=%s)",
    async (running) => {
      const packageRoot = await context.mockPackageInstallAtCaseDir();
      if (running) {
        context.mockRunningManagedGateway([
          "node",
          context.path.join(packageRoot, "dist", "index.js"),
          "gateway",
          "run",
        ]);
      }
      context.mockCurrentProcessFreshDoctor();
      const previousBackup = context.path.join(
        context.profileStateDir(),
        "backups",
        "manual-backup.tar.gz",
      );
      await context.fs.mkdir(context.path.dirname(previousBackup), { recursive: true });
      await context.fs.writeFile(previousBackup, "deliberately retained backup fixture\n");
      const liveFiles = [
        context.path.join(packageRoot, "package.json"),
        context.path.join(packageRoot, "dist", "index.js"),
        context.resolveConfigPath(),
        previousBackup,
      ];
      const previousContents = await Promise.all(
        liveFiles.map((file) => context.fs.readFile(file)),
      );
      context.vi.spyOn(context.fsSync, "statfsSync").mockReturnValue(
        context.statfsFixture({
          bavail: 256,
          bsize: 1024 * 1024,
        }),
      );
      const targetLookups: Array<{ output: string; steps: UpdateRunRecord["steps"] }> = [];
      const resolveTag = context.vi.mocked(context.resolveNpmChannelTag).getMockImplementation()!;
      context.vi.mocked(context.resolveNpmChannelTag).mockImplementation(async (...args) => {
        targetLookups.push({
          output: context.getLogOutput(),
          steps: context.listUpdateRuns({ limit: 1 })[0]?.steps ?? [],
        });
        return await resolveTag(...args);
      });

      await context
        .expect(context.updateCommand({ yes: true }))
        .rejects.toEqual(new context.ExitError(1));

      context.expect(targetLookups).toContainEqual({
        output: context.expect.stringContaining("Low disk space near"),
        steps: context.expect.arrayContaining([
          context.expect.objectContaining({
            step: "warning:disk-space-preflight",
            status: "completed",
            detail: context.expect.stringContaining("256 MiB available"),
          }),
        ]),
      });
      context.expectPackageInstallSpec("openclaw@9999.0.0");
      const preflightParams = context.vi
        .mocked(context.fetchNpmPackageTargetStatus)
        .mock.calls.find(([params]) => params.target === "9999.0.0")?.[0];
      context.expect(preflightParams).toEqual(
        context.expect.objectContaining({
          target: "9999.0.0",
          spec: "openclaw@9999.0.0",
          cwd: process.cwd(),
        }),
      );
      context.expect(context.packageInstallCommandCall()?.[1].env).toBe(preflightParams?.env);
      context.expect(context.defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      context.expect(context.getLogOutput()).toContain("Low disk space near");
      context.expect(context.getErrorOutput()).toContain("Insufficient update recovery capacity");
      context
        .expect(await Promise.all(liveFiles.map((file) => context.fs.readFile(file))))
        .toEqual(previousContents);
      context.expectNoSideEffects(
        context.serviceStop,
        context.serviceStart,
        context.serviceRestart,
      );
      context.expect(context.freshRestartCalls()).toHaveLength(0);
      await context
        .expect(context.fs.access(`${context.profileStateDir()}.update-captures`))
        .rejects.toMatchObject({
          code: "ENOENT",
        });
    },
  );

  context.it.each(["insufficient", "alternative", "unknown", "plenty", "package-only"] as const)(
    "checks initial snapshot capacity before staging (%s)",
    async (scenario) => {
      const pkgRoot = await context.mockPackageInstallAtCaseDir();
      context.initializeExistingUpdateProfile();
      const stateDir = await context.fs.realpath(context.profileStateDir());
      const captureDir = `${stateDir}.update-captures`;
      await context.fs.mkdir(captureDir);
      context.vi.stubEnv("TMPDIR", context.tempDirs.make("initial-snapshot-temp-"));
      context.vi.spyOn(context.fsSync, "statfsSync").mockImplementation((checkedPath) => {
        // This matrix varies the initial advisory estimate. The later recovery
        // reservation still measures every volume and must have proven capacity.
        if (scenario !== "insufficient" && context.packageInstallCommandCall()) {
          return context.statfsFixture({ bavail: 2048, bsize: 1024 * 1024 });
        }
        if (scenario === "unknown") {
          throw new Error("capacity unavailable");
        }
        const location = String(checkedPath);
        const low =
          scenario === "insufficient" ||
          (scenario === "alternative" && location !== captureDir) ||
          (scenario === "package-only" && location === context.path.dirname(pkgRoot));
        return context.statfsFixture({ bavail: low ? 32 : 2048, bsize: 1024 * 1024 });
      });
      const allocate = context.vi.spyOn(context.fs, "mkdtemp");

      const update = context.updateCommand({ yes: true, json: true });
      if (scenario === "insufficient") {
        await context.expect(update).rejects.toMatchObject({ code: 1 });
      } else {
        await update;
      }

      const record = context.listUpdateRuns({ limit: 1 })[0];
      if (scenario === "insufficient") {
        context.expect(context.lastWriteJsonCall()).toMatchObject({
          status: "error",
          reason: "snapshot-capacity-insufficient",
        });
        context.expect(context.packageInstallCommandCall()).toBeUndefined();
        context
          .expect(
            allocate.mock.calls.some(
              ([prefix]) =>
                prefix.includes(".openclaw.update-stage-") ||
                prefix.includes("openclaw-update-canary-"),
            ),
          )
          .toBe(false);
        context.expect(record).toMatchObject({
          status: "failed",
          reason: "snapshot-capacity-insufficient",
        });
        context.expect(record?.steps).toContainEqual(
          context.expect.objectContaining({
            step: "snapshot-space-preflight",
            status: "failed",
            snapshotCapacity: context.expect.objectContaining({
              pluginBytes: null,
              candidates: context.expect.arrayContaining([
                context.expect.objectContaining({ availableBytes: 32 * 1024 * 1024 }),
              ]),
            }),
          }),
        );
        context.expect(context.getErrorOutput()).toContain("bytes needed");
        context.expect(context.getErrorOutput()).toContain("33554432 bytes free");
        context.expect(context.getErrorOutput()).toContain("SQLite family");
      } else {
        context.expectPackageInstallSpec("openclaw@9999.0.0");
        context.expect(context.lastWriteJsonCall()).toMatchObject({ status: "ok" });
        context.expect(record?.steps).toContainEqual(
          context.expect.objectContaining({
            step: "warning:snapshot-space-preflight",
            detail: context.expect.stringContaining("Snapshot capacity estimate incomplete"),
          }),
        );
        context.expect(context.getErrorOutput()).toContain("SQLite family");
        context.expect(context.getErrorOutput()).toContain("openclaw.sqlite");
      }
    },
  );
}

export const statfsFixture = (params: {
  bavail: number;
  bsize?: number;
  blocks?: number;
}): ReturnType<typeof fsSync.statfsSync> => ({
  type: 0,
  bsize: params.bsize ?? 1024,
  blocks: params.blocks ?? 2_000_000,
  bfree: params.bavail,
  bavail: params.bavail,
  files: 0,
  frsize: params.bsize ?? 1024,
  ffree: 0,
});
