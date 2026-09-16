import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../daemon/constants.js";
import * as serviceInventory from "../../daemon/inspect.js";
import * as taskProbe from "../../daemon/schtasks-state-probe.js";
import {
  readGatewayServiceState,
  resolveManagedGatewayServiceIdentity,
  type GatewayService,
} from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as updateHandoff from "../../infra/update-managed-service-handoff.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const native = vi.hoisted(() => ({ service: vi.fn<() => GatewayService>() }));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: native.service,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
type NativeDefinition = { root: string; env: NodeJS.ProcessEnv; running: boolean; uid: number };
beforeEach(() => {
  mockProcessPlatform("linux");
  mockSystemAccountHome();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function fixture() {
  const home = dirs.make("update-profile-admission-");
  const root = path.join(home, "package");
  const foreignRoot = path.join(home, "foreign-package");
  for (const packageRoot of [root, foreignRoot]) {
    await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      '{"name":"openclaw","version":"2026.9.4"}',
    );
    await fs.writeFile(path.join(packageRoot, "dist", "entry.js"), "");
  }
  const unitDir = path.join(home, ".config", "systemd", "user");
  await fs.mkdir(unitDir, { recursive: true });
  const definitions = new Map<string, NativeDefinition>();
  const add = async (profile: string, packageRoot = root) => {
    const unit = resolveGatewaySystemdServiceName(profile);
    const stateDir = path.join(home, profile === "default" ? ".openclaw" : `.openclaw-${profile}`);
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(configPath, '{"gateway":{"mode":"local"}}');
    const definition: NativeDefinition = {
      root: packageRoot,
      env: {
        HOME: home,
        OPENCLAW_PROFILE: profile,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_SYSTEMD_UNIT: unit,
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      running: true,
      uid: 1000,
    };
    definitions.set(unit, definition);
    await fs.writeFile(
      path.join(unitDir, `${unit}.service`),
      `[Service]\nExecStart=${process.execPath} ${path.join(packageRoot, "dist", "entry.js")} gateway\nEnvironment=OPENCLAW_SERVICE_MARKER=openclaw\nEnvironment=OPENCLAW_SERVICE_KIND=gateway\n`,
    );
    return definition;
  };
  const primary = await add("primary");
  const secondary = await add("ops");
  const lookup = (env: NodeJS.ProcessEnv) =>
    [...definitions.values()].find(
      (definition) =>
        resolveManagedGatewayServiceIdentity(definition.env) ===
        resolveManagedGatewayServiceIdentity(env),
    );
  const task = (
    taskPath: string,
    subcommand: "gateway" | "node" = "gateway",
  ): taskProbe.ScheduledTaskSnapshot => ({
    taskPath,
    state: 3,
    actions: [
      {
        type: 0,
        path: process.execPath,
        arguments: `${path.join(root, "dist", "entry.js")} ${subcommand}`,
        workingDirectory: root,
      },
    ],
  });
  const service = createMockGatewayService({
    readCommand: vi.fn(async (env) => {
      const definition = lookup(env);
      if (!definition) {
        throw new Error("Native definition is unavailable");
      }
      return {
        programArguments: [
          process.execPath,
          path.join(definition.root, "dist", "entry.js"),
          "gateway",
        ],
        environment: Object.fromEntries(
          Object.entries(definition.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      };
    }),
    isLoaded: async () => true,
    readRuntime: async (env) => ({
      status: lookup(env)?.running ? "running" : "stopped",
      systemd: { managerUid: lookup(env)?.uid },
    }),
  });
  native.service.mockReturnValue(service);
  for (const key of [
    "OPENCLAW_HOME",
    "OPENCLAW_WORKSPACE_DIR",
    "OPENCLAW_GATEWAY_PORT",
    "OPENCLAW_LAUNCHD_LABEL",
    "OPENCLAW_WINDOWS_TASK_NAME",
    "OPENCLAW_TASK_SCRIPT",
    "OPENCLAW_TASK_SCRIPT_NAME",
    "OPENCLAW_SUPERVISOR_MODE",
    "OPENCLAW_GATEWAY_SERVICE_PID",
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv("USERPROFILE", home);
  for (const [key, value] of Object.entries(primary.env)) {
    vi.stubEnv(key, value);
  }
  const params = {
    roots: [root],
    updateInstallKind: "package" as const,
    shouldRestart: true,
    jsonMode: true,
    timeoutMs: 1000,
    managedServiceRootRedirect: null,
  };
  return {
    home,
    root,
    foreignRoot,
    unitDir,
    definitions,
    primary,
    secondary,
    service,
    params,
    add,
    task,
  };
}

describe("shared-install database admission", () => {
  it.each([false, true])(
    "keeps a verified foreground caller separate from native service facts (native origin=%s)",
    async (nativeOrigin) => {
      const f = await fixture();
      f.primary.running = false;
      if (!nativeOrigin) {
        f.definitions.delete(resolveGatewaySystemdServiceName("primary"));
        await fs.unlink(path.join(f.unitDir, "openclaw-gateway-primary.service"));
      }
      const inspectForeground = vi
        .spyOn(updateHandoff, "isCurrentForegroundUpdateHandoffProcess")
        .mockResolvedValue(true);
      const admission = await inspectUpdateDatabaseContexts(f.params);
      expect(admission.profiles.map(({ context }) => context.env.OPENCLAW_PROFILE)).toEqual([
        "primary",
        "ops",
      ]);
      expect(admission.profiles[0]?.stopState).toEqual(
        nativeOrigin
          ? expect.objectContaining({
              running: false,
              serviceUpdateVerdict: expect.objectContaining({ kind: "owned" }),
            })
          : undefined,
      );
      expect(admission.profiles[1]?.stopState).toMatchObject({
        running: true,
        serviceUpdateVerdict: { kind: "owned" },
      });
      expect(inspectForeground).toHaveBeenCalledWith(
        expect.objectContaining({
          root: f.root,
          env: expect.objectContaining({
            OPENCLAW_CONFIG_PATH: f.primary.env.OPENCLAW_CONFIG_PATH,
          }),
        }),
      );
      expect(f.service.stop).not.toHaveBeenCalled();
    },
  );

  it("does not bypass an unavailable native route when foreground ownership is unverified", async () => {
    const f = await fixture();
    f.definitions.delete(resolveGatewaySystemdServiceName("primary"));
    await fs.unlink(path.join(f.unitDir, "openclaw-gateway-primary.service"));
    vi.spyOn(updateHandoff, "isCurrentForegroundUpdateHandoffProcess").mockResolvedValue(false);
    await expect(inspectUpdateDatabaseContexts(f.params)).rejects.toMatchObject({
      reason: "managed-service-preflight",
    });
    expect(f.service.stop).not.toHaveBeenCalled();
  });
  it.each(
    (["prepare", undefined] as const).flatMap((phase) =>
      [false, true].map((externalSystem) => ({ phase, externalSystem })),
    ),
  )(
    "does not permit prepared snapshots to stop a service: $phase, external system=$externalSystem",
    async ({ phase, externalSystem }) => {
      const f = await fixture();
      const preparedState = await readGatewayServiceState(f.service, {
        env: f.primary.env,
        requireEffective: true,
      });
      if (externalSystem) {
        preparedState.systemdInstallation = {
          kind: "system",
          system: {
            scope: "system",
            unitName: "custom-system.service",
            unitPath: "/etc/systemd/system/custom-system.service",
          },
        };
      }
      await expect(
        maybeStopManagedServiceBeforeMutableUpdate({
          ...f.params,
          root: f.root,
          preparedState,
          phase,
        }),
      ).rejects.toThrow("Prepared service snapshots are for inspection only");
      expect(f.service.stop).not.toHaveBeenCalled();
    },
  );

  it("admits every owned profile in selected-first order without adopting a foreign root", async () => {
    const f = await fixture();
    const foreign = await f.add("foreign", f.foreignRoot);
    foreign.env.OPENCLAW_STATE_DIR = path.join(f.home, "foreign-custom-state");
    f.secondary.running = false;
    const admission = await inspectUpdateDatabaseContexts(f.params);
    expect(admission.profiles.map(({ context }) => context.env.OPENCLAW_PROFILE)).toEqual([
      "primary",
      "ops",
    ]);
    expect(admission.profiles.map(({ stopState }) => stopState?.running)).toEqual([true, false]);
    expect(admission.contexts.map(({ configSnapshot }) => configSnapshot.path)).toEqual([
      f.primary.env.OPENCLAW_CONFIG_PATH,
      f.primary.env.OPENCLAW_CONFIG_PATH,
      f.secondary.env.OPENCLAW_CONFIG_PATH,
    ]);
    expect(f.service.stop).not.toHaveBeenCalled();
    await expect(
      inspectUpdateDatabaseContexts({ ...f.params, expectedProfiles: admission.profiles }),
    ).resolves.toMatchObject({
      profiles: [
        { context: { env: { OPENCLAW_PROFILE: "primary" } } },
        { context: { env: { OPENCLAW_PROFILE: "ops" } } },
      ],
    });
  });

  it.each(
    ["added", "removed", "retargeted", "definition changed", "manager changed"].flatMap((change) =>
      (["installation", "profile-maintenance"] as const).map((scope) => ({ change, scope })),
    ),
  )(
    "refuses a profile group that changed after $scope admission: $change",
    async ({ change, scope }) => {
      const f = await fixture();
      const admission = await inspectUpdateDatabaseContexts({ ...f.params, scope });
      if (change === "added") {
        await f.add("new");
      } else if (change === "removed") {
        f.definitions.delete(resolveGatewaySystemdServiceName("ops"));
        await fs.unlink(path.join(f.unitDir, "openclaw-gateway-ops.service"));
      } else if (change === "retargeted") {
        f.secondary.root = f.foreignRoot;
      } else if (change === "manager changed") {
        f.secondary.uid++;
      } else {
        f.secondary.env.OPENCLAW_GATEWAY_PORT = "19889";
      }
      await expect(
        inspectUpdateDatabaseContexts({ ...f.params, scope, expectedProfiles: admission.profiles }),
      ).rejects.toMatchObject({
        reason: "managed-service-preflight",
      });
      expect(f.service.stop).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ownership: "shared", scope: "installation", overlap: "none", refused: true },
    { ownership: "foreign", scope: "installation", overlap: "none", refused: false },
    { ownership: "shared", scope: "profile-maintenance", overlap: "none", refused: false },
    { ownership: "shared", scope: "profile-maintenance", overlap: "config", refused: true },
    { ownership: "shared", scope: "profile-maintenance", overlap: "database", refused: true },
  ] as const)(
    "inspects system consumers at their actual scope ($ownership, $scope, overlap=$overlap)",
    async ({ ownership, scope, overlap, refused }) => {
      const f = await fixture();
      const label = "openclaw-gateway-primary.service";
      vi.spyOn(serviceInventory, "findGatewayServices").mockImplementation(
        async (_env, options) => ({
          services: options?.deep
            ? [
                {
                  platform: "linux",
                  scope: "user",
                  label: "openclaw-gateway-ops.service",
                  detail: `unit: ${f.unitDir}/openclaw-gateway-ops.service`,
                  marker: "openclaw",
                },
                {
                  platform: "linux",
                  scope: "system",
                  label,
                  detail: `unit: /etc/systemd/system/${label}`,
                  marker: "openclaw",
                },
              ]
            : [],
          errors: [],
        }),
      );
      const readCommand = vi.mocked(f.service.readCommand).getMockImplementation()!;
      vi.mocked(f.service.readCommand).mockImplementation(async (env, options) => {
        const command = await readCommand(env, options);
        if (!command || options?.systemdReadTarget?.scope !== "system") {
          return command;
        }
        return {
          ...command,
          environment: {
            ...command.environment,
            OPENCLAW_PROFILE: "system",
            OPENCLAW_STATE_DIR:
              overlap === "database"
                ? f.primary.env.OPENCLAW_STATE_DIR!
                : path.join(f.home, "system"),
            OPENCLAW_CONFIG_PATH:
              overlap === "config"
                ? f.primary.env.OPENCLAW_CONFIG_PATH!
                : path.join(f.home, "system", "openclaw.json"),
          },
          programArguments: [
            process.execPath,
            path.join(ownership === "shared" ? f.root : f.foreignRoot, "dist", "entry.js"),
            "gateway",
          ],
        };
      });
      const admission = inspectUpdateDatabaseContexts({ ...f.params, scope });
      if (refused) {
        await expect(admission).rejects.toMatchObject({
          reason: "managed-service-preflight",
          message: expect.stringContaining("deployment owner"),
        });
      } else {
        const observed = await admission;
        expect(observed.profiles.map(({ context }) => context.env.OPENCLAW_PROFILE)).toEqual([
          "primary",
          "ops",
        ]);
        expect(observed.externalConsumers).toEqual(
          ownership === "shared"
            ? [
                expect.objectContaining({
                  root: f.root,
                  state: expect.objectContaining({
                    running: true,
                    systemdInstallation: {
                      kind: "system",
                      system: {
                        scope: "system",
                        unitName: label,
                        unitPath: `/etc/systemd/system/${label}`,
                      },
                    },
                    env: expect.objectContaining({ OPENCLAW_PROFILE: "system" }),
                  }),
                }),
              ]
            : [],
        );
        for (const { state } of observed.externalConsumers) {
          await expect(
            maybeStopManagedServiceBeforeMutableUpdate({
              ...f.params,
              root: f.root,
              phase: "inspect",
              preparedState: state,
            }),
          ).resolves.toMatchObject({
            serviceUpdateVerdict: { kind: "owned" },
            serviceMutationAllowed: false,
          });
        }
        await expect(
          inspectUpdateDatabaseContexts({
            ...f.params,
            scope: observed.scope,
            expectedProfiles: observed.profiles,
          }),
        ).resolves.toMatchObject({ externalConsumers: observed.externalConsumers });
      }
      expect(f.service.stop).not.toHaveBeenCalled();
    },
  );

  it.each(["inventory", "native command", "noncanonical state"])(
    "refuses incomplete sibling ownership before mutation: %s",
    async (failure) => {
      const f = await fixture();
      if (failure === "inventory") {
        await fs.mkdir(path.join(f.unitDir, "openclaw-gateway-unreadable.service"));
      } else if (failure === "native command") {
        f.definitions.delete(resolveGatewaySystemdServiceName("ops"));
      } else {
        f.secondary.env.OPENCLAW_STATE_DIR = path.join(f.home, "unowned-state");
      }
      await expect(inspectUpdateDatabaseContexts(f.params)).rejects.toMatchObject({
        reason: "managed-service-preflight",
      });
      expect(f.service.stop).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps the caller first without an owned service, with same-root sibling=%s",
    async (sibling) => {
      const f = await fixture();
      if (sibling) {
        await f.add("owned", f.foreignRoot);
      }
      const admission = await inspectUpdateDatabaseContexts({
        ...f.params,
        roots: [f.foreignRoot],
      });
      expect(admission.profiles).toHaveLength(sibling ? 2 : 1);
      expect(admission.profiles[0]).toMatchObject({
        root: f.foreignRoot,
        stopState: { serviceUpdateVerdict: { kind: "foreign" } },
        context: { env: { OPENCLAW_PROFILE: "primary" } },
      });
      expect(admission.contexts).toHaveLength(sibling ? 2 : 1);
      expect(admission.profiles.map(({ context }) => context.env.OPENCLAW_PROFILE)).toEqual(
        sibling ? ["primary", "owned"] : ["primary"],
      );
      const revalidated = await inspectUpdateDatabaseContexts({
        ...f.params,
        roots: [f.foreignRoot],
        expectedProfiles: admission.profiles,
      });
      expect(revalidated.profiles.map(({ context }) => context.env.OPENCLAW_PROFILE)).toEqual(
        sibling ? ["primary", "owned"] : ["primary"],
      );
    },
  );

  it("uses a same-state native alias as the origin without adding a duplicate caller profile", async () => {
    const f = await fixture();
    const caller = await f.add("default", f.foreignRoot);
    const alias = await f.add("z-alias");
    alias.env = {
      ...caller.env,
      OPENCLAW_SYSTEMD_UNIT: resolveGatewaySystemdServiceName("z-alias"),
    };
    for (const [key, value] of Object.entries(caller.env)) {
      vi.stubEnv(key, value);
    }
    const admission = await inspectUpdateDatabaseContexts(f.params);
    expect(admission.profiles.map(({ context }) => context.env.OPENCLAW_PROFILE)).toEqual([
      "default",
      "ops",
      "primary",
    ]);
    expect(admission.profiles[0]?.stopState?.serviceEnv?.OPENCLAW_SYSTEMD_UNIT).toMatch(
      /^openclaw-gateway-z-alias(?:\.service)?$/,
    );
    expect(
      admission.profiles.filter(
        ({ context }) => context.configSnapshot.path === caller.env.OPENCLAW_CONFIG_PATH,
      ),
    ).toHaveLength(1);
  });

  it("keeps the invoking caller in schema checks without adding it to selected native maintenance", async () => {
    const f = await fixture();
    const callerState = path.join(f.home, ".openclaw");
    const callerConfig = path.join(callerState, "openclaw.json");
    await fs.mkdir(callerState, { recursive: true });
    await fs.writeFile(callerConfig, '{"gateway":{"mode":"local"}}');
    vi.stubEnv("OPENCLAW_PROFILE", "default");
    vi.stubEnv("OPENCLAW_STATE_DIR", callerState);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", callerConfig);

    const admission = await inspectUpdateDatabaseContexts(f.params);
    expect(admission.profiles.map(({ context }) => context.env.OPENCLAW_PROFILE)).toEqual([
      "primary",
      "ops",
    ]);
    expect(admission.contexts.map(({ env }) => env.OPENCLAW_PROFILE)).toEqual([
      "default",
      "primary",
      "ops",
    ]);
    await expect(
      inspectUpdateDatabaseContexts({ ...f.params, expectedProfiles: admission.profiles }),
    ).resolves.toMatchObject({
      profiles: [
        { context: { env: { OPENCLAW_PROFILE: "primary" } } },
        { context: { env: { OPENCLAW_PROFILE: "ops" } } },
      ],
      contexts: [
        { env: { OPENCLAW_PROFILE: "default" } },
        { env: { OPENCLAW_PROFILE: "primary" } },
        { env: { OPENCLAW_PROFILE: "ops" } },
      ],
    });
    expect(admission.profiles[0]?.stopState?.serviceUpdateVerdict?.kind).toBe("owned");
    expect(f.service.stop).not.toHaveBeenCalled();
  });

  it("excludes an unrelated caller config when replacement is redirected to owned profiles", async () => {
    const f = await fixture();
    const caller = await f.add("caller", f.foreignRoot);
    await fs.writeFile(caller.env.OPENCLAW_CONFIG_PATH!, "not valid config");
    for (const [key, value] of Object.entries(caller.env)) {
      vi.stubEnv(key, value);
    }
    const admission = await inspectUpdateDatabaseContexts({
      ...f.params,
      managedServiceRootRedirect: { root: f.root, previousRoot: f.foreignRoot },
    });
    expect(admission.profiles.map(({ context }) => context.env.OPENCLAW_PROFILE)).toEqual([
      "ops",
      "primary",
    ]);
    expect(admission.contexts.map(({ configSnapshot }) => configSnapshot.path)).toEqual([
      f.secondary.env.OPENCLAW_CONFIG_PATH,
      f.primary.env.OPENCLAW_CONFIG_PATH,
    ]);
  });

  it.each(["canonical", "saved profile mismatch", "custom locator"])(
    "uses Windows task labels only to locate saved profile commands: %s",
    async (scenario) => {
      const f = await fixture();
      mockProcessPlatform("win32");
      f.primary.env.OPENCLAW_WINDOWS_TASK_NAME = resolveGatewayWindowsTaskName("primary");
      f.secondary.env.OPENCLAW_WINDOWS_TASK_NAME = resolveGatewayWindowsTaskName("ops");
      const secondaryTask =
        scenario === "custom locator"
          ? "Custom OpenClaw Gateway"
          : resolveGatewayWindowsTaskName("ops");
      vi.spyOn(taskProbe, "listScheduledTasks").mockReturnValue([
        f.task(`\\${resolveGatewayWindowsTaskName("primary")}`),
        f.task(`\\${secondaryTask}`),
        f.task("\\OpenClaw Node", "node"),
      ]);
      if (scenario === "saved profile mismatch") {
        f.secondary.env.OPENCLAW_PROFILE = "primary";
      }
      if (scenario === "canonical") {
        const admission = await inspectUpdateDatabaseContexts(f.params);
        expect(admission.profiles.map(({ context }) => context.env.OPENCLAW_PROFILE)).toEqual([
          "primary",
          "ops",
        ]);
      } else {
        await expect(inspectUpdateDatabaseContexts(f.params)).rejects.toMatchObject({
          reason: "managed-service-preflight",
        });
      }
      expect(f.service.stop).not.toHaveBeenCalled();
    },
  );

  it("does not reinterpret a selected custom Windows task as a new profile locator", async () => {
    const f = await fixture();
    const selected = await f.add("default");
    selected.env.OPENCLAW_WINDOWS_TASK_NAME = "Custom OpenClaw Gateway";
    for (const [key, value] of Object.entries(selected.env)) {
      vi.stubEnv(key, value);
    }
    mockProcessPlatform("win32");
    vi.spyOn(taskProbe, "listScheduledTasks").mockReturnValue([
      f.task("\\Custom OpenClaw Gateway"),
    ]);
    const admission = await inspectUpdateDatabaseContexts(f.params);
    expect(admission.profiles).toHaveLength(1);
    expect(admission.profiles[0]?.stopState?.serviceEnv?.OPENCLAW_WINDOWS_TASK_NAME).toBe(
      "Custom OpenClaw Gateway",
    );
  });
});
