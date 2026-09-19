import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  findPersistedAuthProfileCredential: vi.fn(),
  loadValidConfigSnapshotOrThrow: vi.fn(),
  persistProviderAuthProfilesAfterLogin: vi.fn(),
  promoteAuthProfileInOrder: vi.fn(),
  resolveAgentDir: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  resolveDefaultAgentWorkspaceDir: vi.fn(),
  resolvePluginProvidersCore: vi.fn(),
  resolvePluginSetupProviderCore: vi.fn(),
  resolvePluginSetupRegistry: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock("../../agents/agent-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/agent-scope.js")>();
  return {
    ...actual,
    resolveAgentDir: mocks.resolveAgentDir,
    resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
  };
});

vi.mock("../../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir: mocks.resolveDefaultAgentWorkspaceDir,
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    findPersistedAuthProfileCredential: mocks.findPersistedAuthProfileCredential,
  };
});

vi.mock("../../agents/auth-profiles/profiles.js", () => ({
  promoteAuthProfileInOrder: mocks.promoteAuthProfileInOrder,
}));

vi.mock("../../plugins/provider-auth-persistence.js", () => ({
  persistProviderAuthProfilesAfterLogin: mocks.persistProviderAuthProfilesAfterLogin,
}));

vi.mock("../../plugins/providers.runtime.js", () => ({
  resolvePluginProvidersCore: mocks.resolvePluginProvidersCore,
}));

vi.mock("../../plugins/setup-registry.js", () => ({
  resolvePluginSetupProviderCore: mocks.resolvePluginSetupProviderCore,
  resolvePluginSetupRegistry: mocks.resolvePluginSetupRegistry,
}));

vi.mock("../../gateway/call.js", async () => {
  const requestErrors = await import("../../../packages/gateway-client/src/request-error.js");
  return {
    callGateway: mocks.callGateway,
    GatewayLocalBackendSharedAuthUnavailableError: class extends Error {},
    isGatewayClientRequestError: (error: unknown) =>
      error instanceof requestErrors.GatewayClientRequestError,
    isImplicitLocalGatewayTarget: vi.fn(() => Promise.resolve(true)),
  };
});

vi.mock("./shared.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared.js")>();
  return {
    ...actual,
    loadValidConfigSnapshotOrThrow: mocks.loadValidConfigSnapshotOrThrow,
    updateConfig: mocks.updateConfig,
  };
});

const {
  MANAGED_MODELS_AUTH_LOGIN_ACCOUNT_MISMATCH_CODE,
  MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY,
  runModelsAuthLoginFlowCore,
} = await import("./auth.js");

type AuthRunCall = {
  agentDir?: string;
  assertCurrent?: () => void;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
};

type PersistProviderAuthCall = {
  agentDir?: string;
  beforeWrite?: (current?: unknown, profileId?: string) => void;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  profiles?: Array<{
    profileId?: string;
    credential?: { provider?: string; type?: string };
  }>;
};

function readMockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const value = mock.mock.calls[index]?.[0];
  if (!value) {
    throw new Error("Expected mock call argument");
  }
  return value;
}

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function createPrompter(): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(),
    confirm: vi.fn(),
    progress: () => ({ update: vi.fn(), stop: vi.fn() }),
  };
}

function createProvider(params: {
  id: string;
  label?: string;
  auth?: ProviderPlugin["auth"];
  run: NonNullable<ProviderPlugin["auth"]>[number]["run"];
}): ProviderPlugin {
  return {
    id: params.id,
    label: params.label ?? params.id,
    auth: params.auth ?? [
      {
        id: "oauth",
        label: "OAuth",
        kind: "oauth",
        run: params.run,
      },
    ],
  };
}

describe("managed models auth login", () => {
  let currentConfig: OpenClawConfig;
  let runProviderAuth: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    currentConfig = {};
    runProviderAuth = vi.fn().mockResolvedValue({
      profiles: [
        {
          profileId: "openai:user@example.com",
          credential: {
            type: "oauth",
            provider: "openai",
            access: "access-token",
            refresh: "refresh-token",
            expires: Date.now() + 60_000,
            email: "user@example.com",
          },
        },
      ],
      defaultModel: "openai/gpt-5.5",
    });
    mocks.callGateway.mockResolvedValue({ refreshed: true });
    mocks.findPersistedAuthProfileCredential.mockReturnValue(undefined);
    mocks.loadValidConfigSnapshotOrThrow.mockImplementation(async () => ({
      sourceConfig: structuredClone(currentConfig),
      runtimeConfig: structuredClone(currentConfig),
    }));
    mocks.persistProviderAuthProfilesAfterLogin.mockImplementation(
      async (params: PersistProviderAuthCall) => params.profiles ?? [],
    );
    mocks.promoteAuthProfileInOrder.mockResolvedValue({
      ok: true,
      value: { version: 1, profiles: {} },
    });
    mocks.resolveAgentDir.mockReturnValue("/tmp/openclaw/agents/main");
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.resolveDefaultAgentWorkspaceDir.mockReturnValue("/tmp/openclaw/workspace");
    mocks.resolvePluginProvidersCore.mockReturnValue([
      createProvider({
        id: "openai",
        label: "OpenAI Codex",
        run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
      }),
    ]);
    mocks.resolvePluginSetupProviderCore.mockReturnValue(undefined);
    mocks.resolvePluginSetupRegistry.mockReturnValue({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs explicit managed login without config, order, default, refresh, or force side effects", async () => {
    const runtime = createRuntime();
    const beforePersist = vi.fn(async () => {});
    const assertCurrent = vi.fn();
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-managed-state" };
    const stateDir = "/tmp/openclaw-native-state";
    const managedEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
    const managedAgentDir = "/tmp/openclaw-native-state/agents/main/agent";
    const escapedConfigAgentDir = "/tmp/escaped-config-agent";
    currentConfig = { agents: { entries: { main: { agentDir: escapedConfigAgentDir } } } };
    mocks.resolveAgentDir.mockImplementation(
      (cfg: OpenClawConfig, _agentId: string, envArg?: NodeJS.ProcessEnv) =>
        cfg.agents?.entries?.main?.agentDir
          ? escapedConfigAgentDir
          : envArg?.OPENCLAW_STATE_DIR === stateDir
            ? managedAgentDir
            : "/tmp/openclaw/agents/main",
    );

    const result = await runModelsAuthLoginFlowCore({
      provider: "openai",
      method: "oauth",
      agent: "main",
      config: currentConfig,
      runtime,
      prompter: createPrompter(),
      env,
      managed: {
        capability: MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY,
        profileId: "openai:managed",
        stateDir,
        beforePersist,
        assertCurrent,
      },
    });

    expect(result).toEqual({
      providerId: "openai",
      methodId: "oauth",
      authRefresh: "gateway-unreachable",
      defaultModel: "openai/gpt-5.5",
      profiles: [{ profileId: "openai:managed", provider: "openai", mode: "oauth" }],
    });
    expect(runProviderAuth).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: managedAgentDir,
        assertCurrent: expect.any(Function),
        env: managedEnv,
        workspaceDir: "/tmp/openclaw/workspace",
      }),
    );
    const providerCall = readMockCallArg(runProviderAuth) as AuthRunCall;
    providerCall.assertCurrent?.();
    expect(assertCurrent).toHaveBeenCalled();
    expect(mocks.findPersistedAuthProfileCredential).toHaveBeenCalledWith({
      agentDir: managedAgentDir,
      profileId: "openai:managed",
      stateDir,
    });
    expect(mocks.findPersistedAuthProfileCredential).not.toHaveBeenCalledWith(
      expect.objectContaining({ agentDir: escapedConfigAgentDir }),
    );
    expect(mocks.loadValidConfigSnapshotOrThrow).not.toHaveBeenCalled();
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(beforePersist).toHaveBeenCalledOnce();
    expect(beforePersist.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.persistProviderAuthProfilesAfterLogin.mock.invocationCallOrder[0]!,
    );
    expect(mocks.persistProviderAuthProfilesAfterLogin).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: managedAgentDir,
        beforeWrite: expect.any(Function),
        env: managedEnv,
        stateDir,
        profiles: [
          expect.objectContaining({
            profileId: "openai:managed",
            credential: expect.objectContaining({ provider: "openai", type: "oauth" }),
          }),
        ],
      }),
    );
    expect(mocks.promoteAuthProfileInOrder).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("rejects managed login before provider execution without explicit config and isolated env", async () => {
    const runtime = createRuntime();
    const managed = {
      capability: MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY,
      profileId: "openai:managed",
      stateDir: "/tmp/openclaw-native-state",
      beforePersist: async () => {},
      assertCurrent: () => {},
    } as const;

    await expect(
      runModelsAuthLoginFlowCore({
        provider: "openai",
        method: "oauth",
        agent: "main",
        runtime,
        prompter: createPrompter(),
        env: {},
        managed,
      }),
    ).rejects.toThrow("Managed auth login requires an explicit config");

    await expect(
      runModelsAuthLoginFlowCore({
        provider: "openai",
        method: "oauth",
        agent: "main",
        config: currentConfig,
        runtime,
        prompter: createPrompter(),
        managed,
      }),
    ).rejects.toThrow("Managed auth login requires an explicit isolated env");

    expect(runProviderAuth).not.toHaveBeenCalled();
    expect(mocks.persistProviderAuthProfilesAfterLogin).not.toHaveBeenCalled();
  });

  it("uses the provider same-account matcher before replacing an existing managed profile", async () => {
    const runtime = createRuntime();
    const matchesPersonalAccount = vi.fn(() => false);
    runProviderAuth.mockResolvedValueOnce({
      profiles: [
        {
          profileId: "openai:new-login",
          credential: {
            type: "oauth",
            provider: "openai",
            access: "new-access-token",
            refresh: "new-refresh-token",
            expires: Date.now() + 60_000,
          },
        },
      ],
    });
    mocks.findPersistedAuthProfileCredential.mockReturnValueOnce({
      type: "oauth",
      provider: "openai",
      access: "old-access-token",
      refresh: "old-refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct-existing",
      userId: "user-existing",
    });
    mocks.resolvePluginProvidersCore.mockReturnValueOnce([
      createProvider({
        id: "openai",
        label: "OpenAI",
        run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
        auth: [
          {
            id: "oauth",
            label: "OAuth",
            kind: "oauth",
            run: runProviderAuth as ProviderPlugin["auth"][number]["run"],
            matchesPersonalAccount,
          },
        ],
      }),
    ]);

    await expect(
      runModelsAuthLoginFlowCore({
        provider: "openai",
        method: "oauth",
        agent: "main",
        config: currentConfig,
        runtime,
        prompter: createPrompter(),
        env: {},
        managed: {
          capability: MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY,
          profileId: "openai:managed",
          stateDir: "/tmp/openclaw-native-state",
          beforePersist: async () => {},
          assertCurrent: () => {},
        },
      }),
    ).rejects.toMatchObject({
      code: MANAGED_MODELS_AUTH_LOGIN_ACCOUNT_MISMATCH_CODE,
      message: "Managed auth login returned credentials for a different account.",
    });

    expect(matchesPersonalAccount).toHaveBeenCalledOnce();
    expect(mocks.persistProviderAuthProfilesAfterLogin).not.toHaveBeenCalled();
  });
});
