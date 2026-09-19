/** Managed provider model auth login helpers. */

import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { findPersistedAuthProfileCredential } from "../../agents/auth-profiles.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
import { pickAuthMethod } from "../../plugins/provider-auth-choice-helpers.js";
import type { ProviderAuthContext } from "../../plugins/provider-authentication.types.js";
import type {
  ProviderAuthMethod,
  ProviderAuthResult,
  ProviderPlugin,
} from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  MANAGED_MODELS_AUTH_LOGIN_ACCOUNT_MISMATCH_CODE,
  MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY,
} from "../../shared/provider-auth-managed-login-contract.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
  ModelsAuthLoginManagedOptions,
} from "./auth-login-flow-types.js";
import { normalizeManualAuthProvider } from "./auth-manual-input.js";
import type { PreparedProviderModelAccess } from "./auth-model-policy.js";
import type { ModelAuthRefreshOutcome } from "./auth-refresh.js";

type ResolvedModelsAuthContext = {
  config: OpenClawConfig;
  configSnapshot: ConfigFileSnapshot;
  agentId: string;
  workspaceDir: string;
  providers: ProviderPlugin[];
};

export type ResolvedModelsAuthLoginManagedOptions = ModelsAuthLoginManagedOptions & {
  method: ProviderAuthMethod;
  existingCredential?: AuthProfileCredential;
};

type RunProviderAuthMethod = (params: {
  config: OpenClawConfig;
  configSnapshot: ConfigFileSnapshot;
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  provider: ProviderPlugin;
  method: ProviderAuthMethod;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  profileId?: string;
  setDefault?: boolean;
  credentialOnly?: boolean;
  assertCurrent?: () => void;
  env?: NodeJS.ProcessEnv;
  isRemote?: boolean;
  signal?: AbortSignal;
  openUrl?: (url: string) => Promise<void>;
  browserAuthorization?: ProviderAuthContext["oauth"]["authorize"];
  beforePersistentEffect?: () => void | Promise<void>;
  refreshAfterLogin?: ModelsAuthLoginFlowOptions["refreshAfterLogin"];
  skipGatewayRefresh?: boolean;
  onModelAccessRequested?: (request: PreparedProviderModelAccess) => void;
  managed?: ResolvedModelsAuthLoginManagedOptions;
}) => Promise<{
  result: ProviderAuthResult;
  profiles: ProviderAuthResult["profiles"];
  authRefresh: ModelAuthRefreshOutcome;
}>;

type ManagedLoginDeps = {
  credentialMode: (credential: AuthProfileCredential) => "api_key" | "oauth" | "token";
  listProvidersWithAuthMethods: (providers: ProviderPlugin[]) => ProviderPlugin[];
  resolveContext: (params: {
    requestedProvider?: string;
    rawAgentId?: string | null;
    config?: OpenClawConfig;
    configSnapshot?: ConfigFileSnapshot;
    ownerPluginId?: string;
  }) => Promise<ResolvedModelsAuthContext>;
  resolveRequestedLoginProviderOrThrow: (
    providers: ProviderPlugin[],
    rawProvider?: string,
  ) => ProviderPlugin | null;
  runProviderAuthMethod: RunProviderAuthMethod;
};

function createManagedAuthLoginError(code: string, message: string): Error & { code: string } {
  const error = Object.assign(new Error(message), { code });
  error.name = "ManagedModelsAuthLoginError";
  return error;
}

function assertManagedSamePersonalAccount(params: {
  method: ProviderAuthMethod;
  incoming: AuthProfileCredential;
  current: AuthProfileCredential | undefined;
  requireCurrent?: boolean;
}) {
  if (!params.current) {
    if (params.requireCurrent) {
      throw createManagedAuthLoginError(
        MANAGED_MODELS_AUTH_LOGIN_ACCOUNT_MISMATCH_CODE,
        "Managed auth login target profile changed before credentials could be saved.",
      );
    }
    return;
  }
  if (params.method.matchesPersonalAccount?.(params.incoming, params.current)) {
    return;
  }
  throw createManagedAuthLoginError(
    MANAGED_MODELS_AUTH_LOGIN_ACCOUNT_MISMATCH_CODE,
    "Managed auth login returned credentials for a different account.",
  );
}

export function createManagedAuthBeforeWrite(params: {
  assertCurrent?: () => void;
  expectedProfileId: string;
  incoming: AuthProfileCredential;
  managed: ResolvedModelsAuthLoginManagedOptions;
  signal?: AbortSignal;
}): (current: AuthProfileCredential | undefined, profileId?: string) => void {
  return (current, profileId) => {
    params.signal?.throwIfAborted();
    params.assertCurrent?.();
    if (profileId !== params.expectedProfileId) {
      return;
    }
    assertManagedSamePersonalAccount({
      method: params.managed.method,
      incoming: params.incoming,
      current,
      requireCurrent: params.managed.existingCredential !== undefined,
    });
  };
}

/** Applies an optional profile-id override to a single returned login profile. */
export function resolveLoginProfiles(params: {
  result: ProviderAuthResult;
  requestedProfileId?: string;
  managedProvider?: string;
  managedMethod?: ProviderAuthMethod;
  managedExistingCredential?: AuthProfileCredential;
}): ProviderAuthResult["profiles"] {
  const requestedProfileId = params.requestedProfileId?.trim();
  if (params.managedMethod) {
    if (!requestedProfileId) {
      throw new Error("Managed auth login requires an explicit profileId.");
    }
    if (params.result.profiles.length !== 1) {
      throw new Error("Managed auth login requires exactly one returned auth profile.");
    }
    const profile = expectDefined(params.result.profiles[0], "auth profile");
    if (profile.credential.type !== "oauth") {
      throw new Error("Managed auth login requires an OAuth auth profile.");
    }
    const incomingProvider = resolveProviderIdForAuth(profile.credential.provider);
    const expectedProvider = resolveProviderIdForAuth(params.managedProvider ?? "");
    if (incomingProvider !== expectedProvider) {
      throw new Error("Managed auth login returned an auth profile for another provider.");
    }
    assertManagedSamePersonalAccount({
      method: params.managedMethod,
      incoming: profile.credential,
      current: params.managedExistingCredential,
    });
    return [{ ...profile, profileId: requestedProfileId }];
  }
  if (!requestedProfileId) {
    return params.result.profiles;
  }
  if (params.result.profiles.length !== 1) {
    throw new Error(
      "--profile-id requires exactly one returned auth profile from the selected auth method.",
    );
  }
  const [profile] = params.result.profiles;
  return [{ ...expectDefined(profile, "auth profile"), profileId: requestedProfileId }];
}

function createSuppliedConfigSnapshot(config: OpenClawConfig): ConfigFileSnapshot {
  const sourceConfig = structuredClone(config);
  return {
    path: "<managed-auth-login-config>",
    exists: false,
    raw: null,
    parsed: sourceConfig,
    // SAFETY: managed login builds a synthetic snapshot from an already-normalized runtime config.
    sourceConfig: sourceConfig as ConfigFileSnapshot["sourceConfig"],
    // SAFETY: managed login has no authored file state; source and resolved share the same snapshot.
    resolved: sourceConfig as ConfigFileSnapshot["resolved"],
    valid: true,
    runtimeConfig: config,
    config,
    issues: [],
    warnings: [],
    legacyIssues: [],
  };
}

export async function runManagedModelsAuthLoginFlowCore(
  opts: ModelsAuthLoginFlowOptions & { managed: ModelsAuthLoginManagedOptions },
  deps: ManagedLoginDeps,
): Promise<ModelsAuthLoginFlowResult> {
  const rawProvider = normalizeOptionalString(opts.provider);
  const rawMethod = normalizeOptionalString(opts.method);
  const rawAgent = normalizeOptionalString(opts.agent);
  const rawProfileId = normalizeOptionalString(opts.managed.profileId);
  const rawStateDir = normalizeOptionalString(opts.managed.stateDir);
  if (!rawProvider || !rawMethod || !rawAgent || !rawProfileId) {
    throw new Error("Managed auth login requires explicit provider, method, agent, and profileId.");
  }
  if (opts.managed.capability !== MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY) {
    throw new Error("Managed auth login requires the supported managed login capability marker.");
  }
  if (opts.force) {
    throw new Error("Managed auth login does not support force cleanup.");
  }
  if (opts.setDefault) {
    throw new Error("Managed auth login does not support default-model updates.");
  }
  if (!opts.config) {
    throw new Error("Managed auth login requires an explicit config.");
  }
  if (!opts.env) {
    throw new Error("Managed auth login requires an explicit isolated env.");
  }
  if (!rawStateDir) {
    throw new Error("Managed auth login requires an explicit stateDir.");
  }

  const requestedProviderId = normalizeManualAuthProvider(rawProvider);
  const configSnapshot = createSuppliedConfigSnapshot(opts.config);
  const context = await deps.resolveContext({
    requestedProvider: requestedProviderId,
    rawAgentId: rawAgent,
    config: opts.config,
    configSnapshot,
  });
  const authProviders = deps.listProvidersWithAuthMethods(context.providers);
  const selectedProvider = deps.resolveRequestedLoginProviderOrThrow(
    authProviders,
    requestedProviderId,
  );
  if (!selectedProvider) {
    throw new Error(`Managed auth login could not resolve provider "${requestedProviderId}".`);
  }
  const chosenMethod = pickAuthMethod(selectedProvider, rawMethod);
  if (!chosenMethod) {
    throw new Error(
      `Managed auth login could not resolve method "${rawMethod}" for provider "${selectedProvider.id}".`,
    );
  }
  const managedEnv = { ...opts.env, OPENCLAW_STATE_DIR: rawStateDir };
  const managedAgentDir = resolveAgentDir({}, context.agentId, managedEnv);
  const existingCredential = findPersistedAuthProfileCredential({
    agentDir: managedAgentDir,
    profileId: rawProfileId,
    stateDir: rawStateDir,
  });
  const managed: ResolvedModelsAuthLoginManagedOptions = {
    ...opts.managed,
    method: chosenMethod,
    profileId: rawProfileId,
    stateDir: rawStateDir,
    ...(existingCredential ? { existingCredential } : {}),
  };

  const { result, profiles, authRefresh } = await deps.runProviderAuthMethod({
    config: context.config,
    configSnapshot: context.configSnapshot,
    agentId: context.agentId,
    agentDir: managedAgentDir,
    workspaceDir: context.workspaceDir,
    provider: selectedProvider,
    method: chosenMethod,
    runtime: opts.runtime,
    prompter: opts.prompter,
    profileId: rawProfileId,
    assertCurrent: opts.managed.assertCurrent,
    env: managedEnv,
    isRemote: opts.isRemote,
    signal: opts.signal,
    openUrl: opts.openUrl,
    browserAuthorization: opts.browserAuthorization,
    refreshAfterLogin: opts.refreshAfterLogin,
    skipGatewayRefresh: !opts.refreshAfterLogin,
    managed,
  });

  return {
    providerId: selectedProvider.id,
    methodId: chosenMethod.id,
    authRefresh,
    ...(result.defaultModel ? { defaultModel: result.defaultModel } : {}),
    profiles: profiles.map((profile) => ({
      profileId: profile.profileId,
      provider: profile.credential.provider,
      mode: deps.credentialMode(profile.credential),
    })),
  };
}
