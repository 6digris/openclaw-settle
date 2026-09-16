import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CANCEL_SYMBOL } from "@clack/core";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { applyDevUpdateTargetEnv } from "../infra/update-dev-target.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../infra/update-managed-service-handoff-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createCommandResult as commandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { VERSION } from "../version.js";
import type { UpdateCliFinalizationSuiteContext } from "./update-cli.test.js";

export function registerUpdateCliFinalizationTests(read: () => UpdateCliFinalizationSuiteContext) {
  it("merges current auth refs with captured service selectors for updated install refresh", async () => {
    const invocationCwd = process.cwd();
    let setup: ReturnType<UpdateCliFinalizationSuiteContext["setupUpdatedRootRefresh"]> | undefined;
    read().initializeExistingUpdateProfile({
      ...process.env,
      OPENCLAW_STATE_DIR: read().profileStateDir("personal"),
    });
    read().initializeExistingUpdateProfile({
      ...process.env,
      OPENCLAW_STATE_DIR: read().profileStateDir("work"),
    });
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_AUTH_TOKEN: undefined,
        OPENCLAW_PROFILE: "personal",
        OPENCLAW_STATE_DIR: path.relative(invocationCwd, read().profileStateDir("personal")),
        OPENCLAW_CONFIG_PATH: path.relative(
          invocationCwd,
          path.join(read().profileStateDir("personal"), "openclaw.json"),
        ),
        PATH: "/caller/bin",
      },
      async () => {
        setup = read().setupUpdatedRootRefresh({
          gatewayUpdateImpl: async (root) => {
            process.env.OPENCLAW_GATEWAY_AUTH_TOKEN = "runtime-auth-ref";
            return read().makeOkUpdateResult({ mode: "npm", root, after: { version: VERSION } });
          },
        });
        read().primeServiceCommand([process.execPath, setup.entrypoints[0], "gateway", "run"], {
          OPENCLAW_PROFILE: "work",
          OPENCLAW_STATE_DIR: path.relative(invocationCwd, read().profileStateDir("work")),
          OPENCLAW_CONFIG_PATH: path.relative(
            invocationCwd,
            path.join(read().profileStateDir("work"), "openclaw.json"),
          ),
          PATH: "/service/bin",
        });

        await read().updateCommand({});
      },
    );

    const entryPath = expectDefined(setup?.entrypoints[0], "updated entrypoint");
    const rawInstallEnv = read().gatewayCommandCall(entryPath, "install")?.[1].env;
    // SAFETY: These fixture command environment fields are asserted immediately below.
    const installEnv = rawInstallEnv as NodeJS.ProcessEnv | undefined;
    expect(installEnv?.OPENCLAW_GATEWAY_AUTH_TOKEN).toBe("runtime-auth-ref");
    expect(installEnv?.OPENCLAW_STATE_DIR).toBe(read().profileStateDir("work"));
    expect(installEnv?.OPENCLAW_CONFIG_PATH).toBe(
      path.join(read().profileStateDir("work"), "openclaw.json"),
    );
    expect(installEnv?.PATH).toBe("/service/bin");
  });

  it.each([
    {
      name: "updateCommand refreshes service env from updated install root when available",
      invoke: async () => {
        await read().updateCommand({});
      },
      assertExtra: () => {
        expect(read().runDaemonInstall).not.toHaveBeenCalled();
        // Install already serves the target version; verify that boot without
        // issuing a redundant second restart.
        expect(read().runRestartScript).not.toHaveBeenCalled();
      },
    },
    {
      name: "updateCommand preserves invocation-relative service env overrides during refresh",
      invoke: async () => {
        await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: path.relative(process.cwd(), read().profileStateDir()),
            OPENCLAW_CONFIG_PATH: path.relative(
              process.cwd(),
              path.join(read().profileStateDir(), "openclaw.json"),
            ),
          },
          async () => {
            await read().updateCommand({});
          },
        );
      },
      expectedEnv: () => ({
        OPENCLAW_STATE_DIR: read().profileStateDir(),
        OPENCLAW_CONFIG_PATH: path.join(read().profileStateDir(), "openclaw.json"),
      }),
      assertExtra: () => {
        expect(read().runDaemonInstall).not.toHaveBeenCalled();
      },
    },
    {
      name: "updateCommand reuses the captured invocation cwd when process.cwd later fails",
      invoke: async () => {
        const originalCwd = process.cwd();
        let restoreCwd: (() => void) | undefined;
        const { root } = read().setupUpdatedRootRefresh({
          gatewayUpdateImpl: async () => {
            const cwdSpy = vi.spyOn(process, "cwd").mockImplementation(() => {
              throw new Error("ENOENT: current working directory is gone");
            });
            restoreCwd = () => cwdSpy.mockRestore();
            return read().makeOkUpdateResult({ mode: "npm", root, after: { version: VERSION } });
          },
        });
        try {
          await withEnvAsync(
            {
              OPENCLAW_STATE_DIR: path.relative(originalCwd, read().profileStateDir()),
              OPENCLAW_WORKSPACE_DIR: path.relative(
                originalCwd,
                path.join(read().profileStateDir(), "workspace"),
              ),
            },
            async () => {
              await read().updateCommand({});
            },
          );
        } finally {
          restoreCwd?.();
        }
        return { originalCwd };
      },
      customSetup: true,
      expectedEnv: () => ({
        OPENCLAW_STATE_DIR: read().profileStateDir(),
        OPENCLAW_WORKSPACE_DIR: path.join(read().profileStateDir(), "workspace"),
      }),
      assertExtra: () => {
        expect(read().runDaemonInstall).not.toHaveBeenCalled();
      },
    },
  ])("$name", async (testCase) => {
    const setup = testCase.customSetup ? undefined : read().setupUpdatedRootRefresh();
    await testCase.invoke();
    const commandOptions = vi.mocked(read().runCommandWithTimeout).mock.calls[0]?.[1];
    const root =
      setup?.root ?? (typeof commandOptions === "object" ? commandOptions.cwd : undefined);
    const entryPath = setup?.entrypoints?.[0] ?? path.join(String(root), "dist", "entry.js");

    const installCall = read().gatewayCommandCall(entryPath, "install");
    expect(installCall?.[0][0]).toContain("node");
    expect(installCall?.[0].slice(1)).toEqual([
      entryPath,
      "gateway",
      "install",
      "--force",
      "--json",
      "--update-executor",
      "run",
    ]);
    expect(installCall?.[1].cwd).toBe(String(root));
    expect(installCall?.[1].timeoutMs).toBe(30 * 60_000);
    const expectedEnv =
      "expectedEnv" in testCase && testCase.expectedEnv ? testCase.expectedEnv() : {};
    for (const [key, value] of Object.entries(expectedEnv)) {
      expect(installCall?.[1].env).toMatchObject({ [key]: value });
    }
    testCase.assertExtra();
  });

  it.each([
    { previous: undefined, mutatesCore: true },
    { previous: "1", mutatesCore: true },
    { previous: "1", mutatesCore: false },
  ])(
    "restores update flag $previous after restart (core mutation: $mutatesCore)",
    async ({ previous, mutatesCore }) => {
      await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: previous }, async () => {
        const entrypoint = path.join(process.cwd(), "dist", "index.js");
        vi.mocked(read().resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
        read().mockRunningManagedGateway(["node", entrypoint, "gateway"]);
        if (mutatesCore) {
          read().mockGitUpdateAfterMutation(read().makeOkUpdateResult({ root: process.cwd() }));
        } else {
          vi.mocked(read().runGatewayUpdate).mockImplementationOnce(async (opts) => {
            await opts?.inspectGitTarget?.({});
            return read().makeOkUpdateResult({ root: process.cwd() });
          });
        }
        read().prepareRestartScript.mockResolvedValue(null);
        vi.mocked(read().defaultRuntime.log).mockClear();

        await read().updateCommand({});

        expect(read().doctorCommand).not.toHaveBeenCalled();
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBe(previous);
        const restartIndex = vi
          .mocked(read().runCommandWithTimeout)
          .mock.calls.findIndex(([argv]) => argv[2] === "gateway" && argv[3] === "restart");
        const restartOrder = read().requireValue(
          vi.mocked(read().runCommandWithTimeout).mock.invocationCallOrder[restartIndex],
          "installed CLI restart call order",
        );
        const snapshotOrders = read().createPreUpdateConfigSnapshotMock.mock.invocationCallOrder;
        expect(read().createPreUpdateConfigSnapshotMock).toHaveBeenCalledTimes(1);
        expect(read().requireValue(snapshotOrders[0], "restart snapshot call order")).toBeLessThan(
          restartOrder,
        );

        const successIndex = vi
          .mocked(read().defaultRuntime.log)
          .mock.calls.findIndex((call) => String(call[0]).includes("OpenClaw updated"));
        expect(successIndex).toBeGreaterThanOrEqual(0);
        expect(
          vi.mocked(read().defaultRuntime.log).mock.invocationCallOrder[successIndex],
        ).toBeGreaterThan(restartOrder);
      });
    },
  );

  it("marks the whole update command as update-in-progress", async () => {
    await withEnvAsync({ OPENCLAW_UPDATE_IN_PROGRESS: undefined }, async () => {
      let observedUpdateEnv: string | undefined;
      vi.mocked(read().runGatewayUpdate).mockImplementationOnce(async () => {
        observedUpdateEnv = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
        return read().makeOkUpdateResult();
      });

      await read().updateCommand({ restart: false });

      expect(observedUpdateEnv).toBe("1");
      expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
    });
  });

  it("updateFinalizeCommand defers plugin installation during pre-plugin doctor", async () => {
    vi.mocked(read().resolveGatewayInstallEntrypoint).mockResolvedValue(
      read().FRESH_POST_UPDATE_ENTRYPOINT,
    );
    await withEnvAsync(
      {
        OPENCLAW_UPDATE_IN_PROGRESS: undefined,
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: undefined,
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: undefined,
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
      async () => {
        let doctorEnv: NodeJS.ProcessEnv | undefined;
        vi.mocked(read().runUtf8CommandWithTimeout).mockImplementationOnce(
          async (_argv, options) => {
            if (typeof options === "object") {
              doctorEnv = { ...options.baseEnv, ...options.env };
            }
            return read().doctorProcessResult();
          },
        );
        vi.mocked(read().defaultRuntime.writeJson).mockClear();

        await read().updateFinalizeCommand({
          json: true,
          yes: true,
          timeout: "9",
          restart: false,
        });

        expect(doctorEnv?.OPENCLAW_UPDATE_IN_PROGRESS).toBe("1");
        expect(doctorEnv?.OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR).toBe("1");
        expect(doctorEnv?.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE).toBe("1");
        expect(doctorEnv?.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE).toBeUndefined();
        expect(process.env.OPENCLAW_UPDATE_IN_PROGRESS).toBeUndefined();
        expect(process.env.OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR).toBeUndefined();
        expect(process.env.OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE).toBeUndefined();
        expect(process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE).toBe("1");
        read().expectFreshPostUpdateDoctor({ yes: true, workspaceSuggestions: true });
        expect(read().syncPluginCall()?.channel).toBe("stable");
        expect(read().lastNpmPluginUpdateCall()?.timeoutMs).toBe(9_000);
        expect(
          vi
            .mocked(read().readConfigFileSnapshot)
            .mock.calls.some(([options]) => options?.skipPluginValidation === true),
        ).toBe(true);
        const output =
          // SAFETY: This captures the fixture's real command output; its expected fields and behavior are asserted below.
          read().lastWriteJsonCall() as
            | {
                status?: string;
                mode?: string;
                restart?: boolean;
                phaseTimings?: Array<{
                  phase?: string;
                  startedOffsetMs?: number;
                  durationMs?: number;
                  outcome?: string;
                }>;
                postUpdate?: { doctor?: { status?: string }; plugins?: { status?: string } };
              }
            | undefined;
        expect(output?.status).toBe("ok");
        expect(output?.mode).toBe("finalize");
        expect(output?.restart).toBe(false);
        expect(output?.postUpdate?.doctor?.status).toBe("ok");
        expect(output?.postUpdate?.plugins?.status).toBe("ok");
        expect(output?.phaseTimings?.map((timing) => timing.phase)).toEqual([
          "preflight",
          "targetConfigValidation",
          "configSnapshot",
          "doctor",
          "plugins",
          "targetConfigConvergence",
          "completionCache",
        ]);
        for (const timing of output?.phaseTimings ?? []) {
          expect(timing.startedOffsetMs).toEqual(expect.any(Number));
          expect(timing.durationMs).toEqual(expect.any(Number));
        }
        expect(output?.phaseTimings?.map((timing) => timing.outcome)).toEqual([
          "completed",
          "completed",
          "completed",
          "completed",
          "completed",
          "completed",
          "skipped",
        ]);
      },
    );
  });

  it("updateFinalizeCommand can defer only the best-effort completion cache", async () => {
    read().pathExists.mockResolvedValue(true);
    vi.mocked(read().runCommandWithTimeout).mockClear();
    vi.mocked(read().defaultRuntime.writeJson).mockClear();

    const options: Parameters<UpdateCliFinalizationSuiteContext["updateFinalizeCommand"]>[0] & {
      deferCompletionCache: boolean;
    } = {
      json: true,
      yes: true,
      restart: false,
      deferCompletionCache: true,
    };
    await read().updateFinalizeCommand(options);

    expect(read().completionCommandCall()).toBeUndefined();
    const output =
      // SAFETY: This captures the fixture's real command output; its expected fields and behavior are asserted below.
      read().lastWriteJsonCall() as
        | { phaseTimings?: Array<{ phase?: string; outcome?: string }> }
        | undefined;
    expect(output?.phaseTimings?.at(-1)).toEqual(
      expect.objectContaining({ phase: "completionCache", outcome: "deferred" }),
    );
  });

  it("updateFinalizeCommand capability env applies only to the hidden finalizer", async () => {
    read().pathExists.mockResolvedValue(false);
    // Option wiring needs an idle installation; earlier workflow cases retain parent runs.
    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_STATE_DIR: read().tempDirs.make("openclaw-finalizer-options-"),
      },
      async () => {
        const run = async (command: "repair" | "finalize") => {
          vi.mocked(read().resolveGatewayInstallEntrypoint).mockResolvedValue(
            read().FRESH_POST_UPDATE_ENTRYPOINT,
          );
          vi.mocked(read().defaultRuntime.writeJson).mockClear();
          const program = new Command();
          program.name("openclaw");
          program.exitOverride();
          read().registerUpdateCli(program);
          const commandState = read().tempDirs.make("openclaw-finalizer-option-command-");
          const commandConfig = path.join(commandState, "openclaw.json");
          await read().writeJsonFixture(commandConfig, read().baseConfig);
          await withEnvAsync(
            { OPENCLAW_STATE_DIR: commandState, OPENCLAW_CONFIG_PATH: commandConfig },
            () => program.parseAsync(["node", "openclaw", "update", command, "--json", "--yes"]),
          );
          const output =
            // SAFETY: This captures the fixture's real command output; its expected fields and behavior are asserted below.
            read().lastWriteJsonCall() as
              | { phaseTimings?: Array<{ phase?: string; outcome?: string }> }
              | undefined;
          return output?.phaseTimings?.at(-1);
        };

        expect(await run("repair"), read().getErrorOutput()).toEqual(
          expect.objectContaining({ phase: "completionCache", outcome: "skipped" }),
        );
        expect(await run("finalize")).toEqual(
          expect.objectContaining({ phase: "completionCache", outcome: "deferred" }),
        );
      },
    );
  });

  it.each(
    ["repair", "finalize"].flatMap((leaf) =>
      ["before", "after", "absent"].map((position) => ({ leaf, position })),
    ),
  )(
    "resolves capability consent $position $leaf without deriving it from --yes",
    async ({ leaf, position }) => {
      read().setTty(false);
      read().pathExists.mockResolvedValue(false);
      vi.mocked(read().resolveGatewayInstallEntrypoint).mockResolvedValue(
        read().FRESH_POST_UPDATE_ENTRYPOINT,
      );
      const program = new Command();
      program.name("openclaw");
      program.exitOverride();
      read().registerUpdateCli(program);

      const commandState = read().tempDirs.make("openclaw-capability-options-");
      const commandConfig = path.join(commandState, "openclaw.json");
      await read().writeJsonFixture(commandConfig, read().baseConfig);
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: commandState, OPENCLAW_CONFIG_PATH: commandConfig },
        () =>
          program.parseAsync([
            "node",
            "openclaw",
            "update",
            ...(position === "before" ? ["--accept-capabilities"] : []),
            leaf,
            ...(position === "after" ? ["--accept-capabilities"] : []),
            "--json",
            "--yes",
          ]),
      );

      const handler =
        // SAFETY: This captures the fixture's real command output; its expected fields and behavior are asserted below.
        read().syncPluginCall()?.onCapabilityConsent as
          | ((review: { reviewToken: string }) => Promise<{ reviewToken: string }>)
          | undefined;
      expect(read().syncPluginsForUpdateChannel, read().getErrorOutput()).toHaveBeenCalledOnce();
      expect(read().lastWriteJsonCall()).toMatchObject({ status: "ok", mode: "finalize" });
      if (position === "absent") {
        expect(handler).toBeUndefined();
      } else {
        await expect(handler?.({ reviewToken: "repair-reviewed-surface" })).resolves.toEqual({
          reviewToken: "repair-reviewed-surface",
        });
      }
    },
  );

  it("updateFinalizeCommand rejects extended-stable on Git before persistence", async () => {
    await expect(
      read().updateFinalizeCommand({
        channel: "extended-stable",
        json: true,
        restart: false,
      }),
    ).rejects.toEqual(new (read().ExitError)(1));

    read().expectNoSideEffects(
      read().replaceConfigFile,
      read().runExec,
      read().syncPluginsForUpdateChannel,
    );
    expect(read().lastWriteJsonCall()).toMatchObject({
      status: "error",
      mode: "git",
      reason: "unsupported_git_channel",
    });
    expect(read().defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("updateFinalizeCommand repairs doctor by default and refreshes plugin state after doctor", async () => {
    vi.mocked(read().resolveGatewayInstallEntrypoint)
      .mockResolvedValueOnce(read().FRESH_POST_UPDATE_ENTRYPOINT)
      .mockResolvedValueOnce("/tmp/openclaw-entry.mjs");
    const preDoctorConfig: OpenClawConfig = {
      update: { channel: "stable" },
      plugins: { entries: { pre: { enabled: true } } },
    };
    const postDoctorConfig: OpenClawConfig = {
      update: { channel: "beta" },
      plugins: { entries: { post: { enabled: true } } },
    };
    const preDoctorSnapshot = read().configSnapshot(preDoctorConfig, {
      parsed: read().baseSnapshot.parsed,
      hash: "pre-doctor",
    });
    const postDoctorSnapshot = read().configSnapshot(postDoctorConfig, {
      parsed: read().baseSnapshot.parsed,
      hash: "post-doctor",
    });
    const postDoctorRecords = {
      "post-plugin": {
        source: "npm",
        spec: "post-plugin@1.0.0",
      },
    } satisfies Record<string, PluginInstallRecord>;
    let currentSnapshot = preDoctorSnapshot;
    vi.mocked(read().readConfigFileSnapshot).mockImplementation(async () => currentSnapshot);
    vi.mocked(read().runUtf8CommandWithTimeout).mockImplementationOnce(async () => {
      currentSnapshot = postDoctorSnapshot;
      return read().doctorProcessResult();
    });
    read().loadInstalledPluginIndexInstallRecords.mockResolvedValueOnce(postDoctorRecords);
    read().syncPluginsForUpdateChannel.mockImplementationOnce(
      async (params: { config?: OpenClawConfig }) =>
        read().pluginSyncResult(params.config ?? read().baseConfig, true),
    );
    read().updateNpmInstalledPlugins.mockImplementation(async ({ config }) =>
      read().npmPluginUpdateResult(config),
    );

    await read().updateFinalizeCommand({ json: true, timeout: "9", restart: false });

    read().expectFreshPostUpdateDoctor({ yes: false, workspaceSuggestions: true });
    const freshDoctorCall = vi
      .mocked(read().runUtf8CommandWithTimeout)
      .mock.calls.find(([argv]) => argv[1] === "/tmp/openclaw-entry.mjs" && argv[2] === "doctor");
    const freshDoctorArgv = read().requireValue(freshDoctorCall?.[0], "post-plugin Doctor argv");
    expect(freshDoctorArgv.slice(1)).toEqual([
      "/tmp/openclaw-entry.mjs",
      "doctor",
      "--repair",
      "--non-interactive",
      "--no-workspace-suggestions",
      ...read().capturedDoctorArgs(freshDoctorArgv),
    ]);
    expect(freshDoctorCall?.[1]).toMatchObject({
      cwd: process.cwd(),
      env: {
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1",
      },
    });
    expect(read().syncPluginCall()?.channel).toBe("beta");
    expect(read().syncPluginCall()?.config).toEqual({
      ...postDoctorConfig,
      plugins: {
        ...postDoctorConfig.plugins,
        installs: postDoctorRecords,
      },
    });
    expect(read().lastReplaceConfigCall()?.baseHash).toBe("post-doctor");
    expect(
      vi.mocked(read().runUtf8CommandWithTimeout).mock.invocationCallOrder[0] ?? 0,
    ).toBeLessThan(read().loadInstalledPluginIndexInstallRecords.mock.invocationCallOrder[0] ?? 0);
    expect(read().lastWriteJsonCall()).toMatchObject({ channel: "beta" });
  });

  it("updateFinalizeCommand restores channels from the RPC pre-update config payload", async () => {
    const tempDir = read().createCaseDir("openclaw-rpc-finalize");
    const entryPath = await read().writeOpenClawPackageFixture(tempDir, "2026.6.18", {
      entrySource: "export {};\n",
    });
    vi.mocked(read().resolveOpenClawPackageRoot).mockResolvedValue(tempDir);
    read().mockFileBackedPathExists();
    const sourceConfigPath = path.join(tempDir, "source-config.json");
    const preUpdateConfig: OpenClawConfig = {
      channels: {
        whatsapp: {
          enabled: true,
          dmPolicy: "pairing",
        },
      },
    };
    const postDoctorConfig: OpenClawConfig = {
      meta: { lastTouchedVersion: "2026.6.18" },
    };
    const postDoctorSnapshot = read().configSnapshot(postDoctorConfig, {
      parsed: read().baseSnapshot.parsed,
      hash: "post-doctor",
    });
    await read().writeJsonFixture(sourceConfigPath, {
      sourceConfig: preUpdateConfig,
      authoredConfig: preUpdateConfig,
    });
    vi.mocked(read().readConfigFileSnapshot).mockResolvedValue(postDoctorSnapshot);

    await withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH: sourceConfigPath,
      },
      async () => {
        await read().updateFinalizeCommand({ json: true, restart: false });
      },
    );

    expect(read().syncPluginCall()?.config?.channels?.whatsapp).toEqual(
      preUpdateConfig.channels?.whatsapp,
    );
    expect(read().lastReplaceConfigCall()?.nextConfig?.channels?.whatsapp).toEqual(
      preUpdateConfig.channels?.whatsapp,
    );
    const calls = read()
      .freshUpdateCommands()
      .filter(({ argv }) => argv[1] === entryPath);
    const captureArgs = read().capturedDoctorArgs(
      read().requireValue(calls[0]?.argv, "pre-plugin Doctor argv"),
    );
    expect(calls.map(({ argv }) => argv.slice(2))).toEqual([
      ["doctor", "--repair", "--non-interactive", ...captureArgs],
      ["doctor", "--repair", "--non-interactive", "--no-workspace-suggestions", ...captureArgs],
      ["config", "validate", "--json"],
    ]);
    expect(read().doctorCommand).not.toHaveBeenCalled();
    expect(read().lastWriteJsonCall()).toMatchObject({ status: "ok" });
  });

  it("updateFinalizeCommand reapplies requested channel against post-doctor config", async () => {
    vi.mocked(read().resolveGatewayInstallEntrypoint).mockResolvedValue(
      read().FRESH_POST_UPDATE_ENTRYPOINT,
    );
    const preDoctorConfig: OpenClawConfig = { update: { channel: "stable" } };
    const postDoctorConfig: OpenClawConfig = { update: { channel: "beta" } };
    const preDoctorSnapshot = read().configSnapshot(preDoctorConfig, {
      parsed: read().baseSnapshot.parsed,
      hash: "pre-doctor",
    });
    const postDoctorSnapshot = read().configSnapshot(postDoctorConfig, {
      parsed: read().baseSnapshot.parsed,
      hash: "post-doctor",
    });
    let currentSnapshot = preDoctorSnapshot;
    vi.mocked(read().readConfigFileSnapshot).mockImplementation(async () => currentSnapshot);
    vi.mocked(read().runUtf8CommandWithTimeout).mockImplementationOnce(async () => {
      currentSnapshot = postDoctorSnapshot;
      return read().doctorProcessResult();
    });

    await read().updateFinalizeCommand({ channel: "dev", json: true, restart: false });

    read().expectFreshPostUpdateDoctor({ yes: false, workspaceSuggestions: true });
    expect(read().replaceConfigCall(0)?.baseHash).toBe("pre-doctor");
    expect(read().replaceConfigCall(0)?.nextConfig).toEqual({ update: { channel: "dev" } });
    expect(read().replaceConfigCall(1)?.baseHash).toBe("post-doctor");
    expect(read().replaceConfigCall(1)?.nextConfig).toEqual({ update: { channel: "dev" } });
    expect(read().syncPluginCall()?.channel).toBe("dev");
    expect(read().lastWriteJsonCall()).toMatchObject({ channel: "dev" });
  });

  it("updateFinalizeCommand converges on the effective channel from env without persisting update.channel", async () => {
    vi.mocked(read().resolveGatewayInstallEntrypoint).mockResolvedValue(
      read().FRESH_POST_UPDATE_ENTRYPOINT,
    );
    const noChannelConfig: OpenClawConfig = {};
    const noChannelSnapshot = read().configSnapshot(noChannelConfig, {
      parsed: read().baseSnapshot.parsed,
      hash: "no-channel",
    });
    vi.mocked(read().readConfigFileSnapshot).mockResolvedValue(noChannelSnapshot);
    const priorEffective = process.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL;
    // Simulate a no-config git/source update whose effective channel is dev.
    process.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL = "dev";
    try {
      await read().updateFinalizeCommand({ json: true, restart: false });
    } finally {
      if (priorEffective === undefined) {
        delete process.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL;
      } else {
        process.env.OPENCLAW_UPDATE_EFFECTIVE_CHANNEL = priorEffective;
      }
    }
    // Convergence runs on the effective (git/dev) channel...
    expect(read().syncPluginCall()?.channel).toBe("dev");
    // ...but the effective channel is never persisted to update.channel
    // (no requested channel), so a default source update does not mutate config.
    expect(read().syncPluginCall()?.config?.update?.channel).toBeUndefined();
    const persistedDevChannel = vi
      .mocked(read().replaceConfigFile)
      .mock.calls.some(([params]) => params?.nextConfig?.update?.channel === "dev");
    expect(persistedDevChannel).toBe(false);
  });

  it.each([
    {
      name: "update command invalid timeout",
      run: async () => await read().invokeUpdateCli({ timeout: "invalid" }),
      requireTty: false,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update status command invalid timeout",
      run: async () => await read().updateStatusCommand({ timeout: "invalid" }),
      requireTty: false,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update wizard invalid timeout",
      run: async () => await read().updateWizardCommand({ timeout: "invalid" }),
      requireTty: true,
      expectedError: "--timeout must be a positive integer (seconds)",
    },
    {
      name: "update wizard requires a TTY",
      run: async () => await read().updateWizardCommand({}),
      requireTty: false,
      expectedError:
        "Update wizard requires a TTY. Use `openclaw update --channel <stable|extended-stable|beta|dev>` instead.",
    },
  ] as const)(
    "validates update command invocation errors: $name",
    async ({ run, requireTty, expectedError, name }) => {
      read().setTty(requireTty);
      vi.mocked(read().defaultRuntime.error).mockClear();
      vi.mocked(read().defaultRuntime.exit).mockClear();

      await run();

      expect(read().defaultRuntime.error, name).toHaveBeenCalledWith(expectedError);
      expect(read().defaultRuntime.exit, name).toHaveBeenCalledWith(1);
    },
  );

  it.each([
    {
      name: "requires confirmation without --yes",
      options: {},
      shouldExit: true,
      shouldRunPackageUpdate: false,
    },
    {
      name: "allows downgrade with --yes",
      options: { yes: true },
      shouldExit: false,
      shouldRunPackageUpdate: true,
    },
  ])("$name in non-interactive mode", async ({ options, shouldExit, shouldRunPackageUpdate }) => {
    const root = await read().setupNonInteractiveDowngrade();
    if (shouldRunPackageUpdate) {
      read().mockCurrentProcessFreshDoctor({ packageRoot: root, postCoreResumeAttempt: false });
    }
    await read().updateCommand(options);

    const downgradeMessageSeen = vi
      .mocked(read().defaultRuntime.error)
      .mock.calls.some((call) => String(call[0]).includes("Downgrade confirmation required."));
    expect(downgradeMessageSeen).toBe(shouldExit);
    if (shouldExit) {
      expect(read().defaultRuntime.exit).toHaveBeenCalledWith(1);
    } else {
      expect(read().defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    }
    expect(read().runGatewayUpdate).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(read().runCommandWithTimeout)
        .mock.calls.some(
          (call) => Array.isArray(call[0]) && call[0][0] === "npm" && call[0][1] === "i",
        ),
    ).toBe(shouldRunPackageUpdate);
  });

  it.each(["channel", "restart"])(
    "cancels the wizard at %s without inspecting update freshness",
    async (prompt) => {
      read().setTty(true);
      if (prompt === "channel") {
        read().select.mockResolvedValue(CANCEL_SYMBOL);
      } else {
        read().confirm.mockResolvedValue(CANCEL_SYMBOL);
      }
      vi.mocked(read().checkUpdateStatus).mockRejectedValue(
        new Error("Freshness inspection unavailable"),
      );

      await read().updateWizardCommand();

      expect(read().select).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Update channel" }),
      );
      expect(read().defaultRuntime.log).toHaveBeenCalledWith(
        expect.stringContaining("Update cancelled."),
      );
      expect(read().runGatewayUpdate).not.toHaveBeenCalled();
      expect(read().sourceRuntimeCompletion).not.toHaveBeenCalled();
    },
  );

  it.each(["before", "after"])(
    "update wizard forwards explicit consent %s the subcommand",
    async (position) => {
      const root = await fs.realpath(read().tempDirs.make("openclaw-update-wizard-"));
      const tempDir = path.join(root, "openclaw");
      const nodeModules = path.join(root, "prefix", "lib", "node_modules");
      const packageRoot = path.join(nodeModules, "openclaw");
      const sha = "a".repeat(40);
      await read().writeOpenClawPackageFixture(packageRoot, "2026.4.10", { inventory: true });
      read().mockPackageInstallStatus(packageRoot);
      read().mockFileBackedPathExists();
      read().mockNpmGlobalCommands(
        nodeModules,
        async (argv) => {
          if (argv[0] === "git" && argv[1] === "clone") {
            const stagingDir = read().requireValue(argv.at(-1), "clone destination");
            await read().writeOpenClawPackageFixture(stagingDir, "2026.8.1", { git: true });
            return commandResult();
          }
          return undefined;
        },
        tempDir,
      );
      vi.spyOn(read().updateCliShared, "tryWriteCompletionCache").mockResolvedValueOnce(
        "completed",
      );
      await withEnvAsync({ OPENCLAW_GIT_DIR: tempDir }, async () => {
        read().setTty(true);
        read().select.mockResolvedValue("dev");
        read().confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        vi.mocked(read().runGatewayUpdate).mockImplementation(async (options) => {
          await read().writeOpenClawPackageFixture(tempDir, "2026.8.1", {
            git: true,
            builtSha: sha,
          });
          await options?.prepareGitExposure?.(tempDir, sha, undefined);
          await options?.validateCandidate?.(tempDir);
          await options?.beforeGitMutation?.({});
          return read().makeOkUpdateResult({
            root: tempDir,
            after: { sha, version: "2026.8.1" },
          });
        });
        vi.mocked(read().runExec).mockResolvedValueOnce({
          stdout: new Command("update").option("--accept-capabilities").helpInformation(),
          stderr: "",
        });

        const program = new Command();
        program.exitOverride();
        read().registerUpdateCli(program);
        await program.parseAsync([
          "node",
          "openclaw",
          "update",
          ...(position === "before" ? ["--accept-capabilities"] : []),
          "wizard",
          ...(position === "after" ? ["--accept-capabilities"] : []),
        ]);

        expect(read().readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
        const call = vi.mocked(read().runGatewayUpdate).mock.calls[0]?.[0];
        expect(call?.channel).toBe("dev");
        await expect(fs.realpath(packageRoot)).resolves.toBe(tempDir);
        expect(read().spawnCall()?.[1]).toEqual([
          path.join(tempDir, "dist", "entry.js"),
          "update",
          "--no-restart",
          "--accept-capabilities",
          "--timeout",
          "1800",
        ]);
        read().expectNoSideEffects(
          read().syncPluginsForUpdateChannel,
          read().updateNpmInstalledPlugins,
        );
        expect(read().defaultRuntime.exit).not.toHaveBeenCalledWith(1);
      });
    },
  );

  it.each([
    {
      name: "ref-only as detached",
      env: { OPENCLAW_UPDATE_DEV_TARGET_REF: "frozen-sha" },
      expected: { mode: "detached", ref: "frozen-sha" },
    },
    {
      name: "versioned tracked target",
      env: applyDevUpdateTargetEnv(
        {},
        { mode: "tracked", upstreamRef: "origin/main", upstreamSha: "frozen-sha" },
      ),
      expected: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: "frozen-sha" },
    },
  ])("maps the internal dev target environment $name", async ({ env, expected }) => {
    await withEnvAsync(env, async () => {
      await read().updateCommand({ channel: "dev", yes: true, restart: false });
    });

    expect(vi.mocked(read().runGatewayUpdate).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ devTarget: expected }),
    );
  });

  it.each([
    ["malformed", "openclaw-dev-target:v1:not+base64url"],
    ["unknown version", "openclaw-dev-target:v2:hostile-ref"],
    ["unknown namespace", "other-dev-target:v1:hostile-ref"],
  ])("rejects a %s tracked dev target before update side effects", async (_name, value) => {
    await withEnvAsync({ OPENCLAW_UPDATE_DEV_TARGET_REF: value }, async () => {
      await read().invokeUpdateCli({ channel: "dev", yes: true, restart: false });
    });

    expect(read().defaultRuntime.error).toHaveBeenCalledWith(
      "Invalid internal OPENCLAW_UPDATE_DEV_TARGET_REF contract; expected a plain Git ref or a supported tracked-target encoding.",
    );
    expect(read().defaultRuntime.error).toHaveBeenCalledTimes(1);
    expect(read().defaultRuntime.exit).toHaveBeenCalledWith(1);
    read().expectNoSideEffects(
      cleanupStaleManagedServiceUpdateHandoffs,
      read().runGatewayUpdate,
      read().launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    );
  });

  it("rejects a malformed inferred dev target before running the update", async () => {
    await withEnvAsync(
      { OPENCLAW_UPDATE_DEV_TARGET_REF: "openclaw-dev-target:v1:not+base64url" },
      async () => {
        await read().updateCommand({ yes: true, restart: false });
      },
    );

    expect(read().defaultRuntime.error).toHaveBeenCalledWith(
      "Invalid internal OPENCLAW_UPDATE_DEV_TARGET_REF contract; expected a plain Git ref or a supported tracked-target encoding.",
    );
    expect(read().defaultRuntime.error).toHaveBeenCalledTimes(1);
    expect(read().defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(read().runGatewayUpdate).not.toHaveBeenCalled();
    expect(
      read().launchdUpdateCleanupMocks.disableCurrentOpenClawUpdateLaunchdJob,
    ).not.toHaveBeenCalled();
  });

  it("ignores a malformed dev target for a stable package update", async () => {
    await read().mockPackageInstallAtCaseDir("openclaw-stable-update");
    read().mockCurrentProcessFreshDoctor();

    await withEnvAsync(
      { OPENCLAW_UPDATE_DEV_TARGET_REF: "openclaw-dev-target:v1:not+base64url" },
      async () => {
        await read().updateCommand({ channel: "stable", yes: true, restart: false });
      },
    );

    expect(read().defaultRuntime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("OPENCLAW_UPDATE_DEV_TARGET_REF"),
    );
    expect(read().defaultRuntime.exit).not.toHaveBeenCalledWith(1);
    expect(read().packageInstallCommandCall()).toBeDefined();
    expect(read().runGatewayUpdate).not.toHaveBeenCalled();
  });

  it("uses ~/openclaw as the default dev checkout directory", async () => {
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/tmp/oc-home");
    try {
      await withEnvAsync(
        {
          HOME: undefined,
          OPENCLAW_GIT_DIR: undefined,
          OPENCLAW_HOME: undefined,
          USERPROFILE: undefined,
        },
        async () => {
          expect(read().resolveGitInstallDir()).toBe(path.posix.join("/tmp/oc-home", "openclaw"));
        },
      );
    } finally {
      homedirSpy.mockRestore();
    }
  });

  it("uses OPENCLAW_HOME for the default dev checkout directory", async () => {
    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue("/tmp/oc-home");
    try {
      await withEnvAsync(
        { OPENCLAW_GIT_DIR: undefined, OPENCLAW_HOME: "/srv/openclaw-home" },
        async () => {
          expect(read().resolveGitInstallDir()).toBe(
            path.posix.join("/srv/openclaw-home", "openclaw"),
          );
        },
      );
    } finally {
      homedirSpy.mockRestore();
    }
  });
}
