import os from "node:os";
import { vi } from "vitest";
import { GATEWAY_SERVICE_SELECTOR_ENV_KEYS } from "../../daemon/constants.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { captureEnv } from "../../test-utils/env.js";
import type { ProfileFinishUpdateParams } from "./update-command-finish-types.js";
import type { PostCorePluginUpdateResult } from "./update-command-plugins.js";
import { finishUpdate } from "./update-command-post-update.js";

export function createManagedServiceIdentityFixture(home: string) {
  const keys = [
    "HOME",
    "USERPROFILE",
    "OPENCLAW_HOME",
    "OPENCLAW_SUPERVISOR_MODE",
    ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
  ];
  const env = captureEnv(keys);
  // A private HOME does not change the OS account home checked by the real service guard.
  const userInfo = vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
  for (const key of keys) {
    delete process.env[key];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return {
    home,
    restore: () => {
      userInfo.mockRestore();
      env.restore();
    },
  };
}

type FinishUpdateParams = Parameters<typeof finishUpdate>[0];

export const validConfigSnapshot = {
  path: "/tmp/openclaw-update/openclaw.json",
  exists: false,
  raw: null,
  resolved: {},
  valid: true,
  parsed: {},
  config: {},
  runtimeConfig: {},
  sourceConfig: {},
  warnings: [],
  issues: [],
  legacyIssues: [],
};

export async function finishSuccessfulPackageSwitch(
  params: {
    previousRoot?: string;
    packageRoot?: string;
    restartEnvironment?: NodeJS.ProcessEnv;
    json?: boolean;
    sealed?: boolean;
    updateMode?: UpdateRunResult["mode"];
    stoppedForUpdate?: boolean;
    stoppedAtMs?: number;
    run?: FinishUpdateParams["opts"]["run"];
    windowsTaskAutoStartRecovery?: NonNullable<
      ProfileFinishUpdateParams["preManagedServiceStop"]
    >["windowsTaskAutoStartRecovery"];
  } = {
    restartEnvironment: process.env,
  },
  overrides: Partial<ProfileFinishUpdateParams> &
    Partial<Pick<FinishUpdateParams, "profiles">> = {},
): Promise<void> {
  const packageRoot = params.packageRoot ?? "/tmp/openclaw-update";
  const previousRoot = params.previousRoot ?? packageRoot;
  const projected: ProfileFinishUpdateParams & Partial<Pick<FinishUpdateParams, "profiles">> = {
    mutationStarted: true,
    result: {
      status: "ok",
      mode: params.updateMode ?? "npm",
      root: packageRoot,
      ...(params.sealed && {
        before: { version: "2026.4.23" },
        after: {
          version: "2026.4.24",
          ...(params.updateMode === "git" ? { buildId: "new-build" } : {}),
        },
      }),
      steps: [],
      durationMs: 1,
    },
    root: packageRoot,
    previousInstallRoot: previousRoot,
    installKindChanged: !params.restartEnvironment,
    configSnapshot: validConfigSnapshot,
    requestedChannel: null,
    storedChannel: null,
    channel: params.updateMode === "git" ? "dev" : "stable",
    downgradeRisk: true,
    shouldRestart: Boolean(params.restartEnvironment),
    opts: { json: params.json, run: params.run },
    controlPlaneUpdateSentinelMeta: {},
    preUpdatePluginInstallRecords: {},
    startedAt: Date.now(),
    updateStepTimeoutMs: 1_000,
    ...(params.restartEnvironment && {
      preManagedServiceStop: {
        inspected: true,
        runtimeInspected: true,
        running: true,
        stopped: params.stoppedForUpdate ?? true,
        stoppedAtMs: params.stoppedAtMs,
        windowsTaskAutoStartRecovery: params.windowsTaskAutoStartRecovery,
        ...(params.sealed && {
          serviceUpdateVerdict: {
            kind: "owned",
            root: previousRoot,
            refreshDefinition: false,
            fingerprint: "sealed",
          },
        }),
      },
      ownedManagedUpdateEnv: params.restartEnvironment,
    }),
    ...overrides,
  };
  const {
    configSnapshot,
    requestedChannel,
    storedChannel,
    preUpdatePluginInstallRecords,
    schemaVersions,
    previousVerified,
    activationConfig,
    preManagedServiceStop,
    ownedManagedUpdateEnv,
    profiles,
    ...shared
  } = projected;
  await finishUpdate({
    ...shared,
    profiles: profiles ?? [
      {
        configSnapshot,
        requestedChannel,
        storedChannel,
        preUpdatePluginInstallRecords,
        schemaVersions,
        previousVerified,
        activationConfig,
        preManagedServiceStop,
        ownedManagedUpdateEnv,
      },
    ],
  });
}

export const programArguments = ["/usr/bin/node", "/tmp/openclaw-update/dist/index.js", "gateway"];

export function managedServiceState(
  env: NodeJS.ProcessEnv = {},
  command: Partial<GatewayServiceCommandConfig> = {},
  unloaded = false,
) {
  return {
    installed: true,
    loadState: { status: unloaded ? "not-loaded" : "loaded" },
    env,
    command: { programArguments: [...programArguments], ...command },
  };
}

export function taskRecovery(record: (phase: string) => void = () => {}) {
  return {
    suspended: Promise.resolve(true),
    beginMutation: vi.fn(() => record("mutation")),
    restore: vi.fn(async () => record("restore")),
    handoff: vi.fn(),
    complete: vi.fn(async () => record("complete")),
    interrupted: () => false,
  };
}

export const successfulPluginUpdate: PostCorePluginUpdateResult = {
  status: "ok",
  changed: false,
  sync: {
    changed: false,
    switchedToBundled: [],
    switchedToNpm: [],
    warnings: [],
    errors: [],
  },
  npm: { changed: false, outcomes: [] },
  integrityDrifts: [],
  warnings: [],
};
