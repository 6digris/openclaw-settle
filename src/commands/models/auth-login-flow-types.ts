/** Shared types for provider model auth login flows. */

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderAuthContext } from "../../plugins/provider-authentication.types.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY } from "../../shared/provider-auth-managed-login-contract.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import type { PreparedProviderModelAccess } from "./auth-model-policy.js";
import type { ModelAuthRefreshOutcome } from "./auth-refresh.js";

export type LoginOptions = {
  provider?: string;
  method?: string;
  profileId?: string;
  setDefault?: boolean;
  yes?: boolean;
  agent?: string;
  /**
   * When true, remove any existing auth profiles for the resolved provider
   * before invoking the auth flow. This is the escape hatch for stuck
   * cached OAuth profiles where the standard `auth login` short-circuits
   * because credentials already exist on disk.
   */
  force?: boolean;
};

export type ModelsAuthLoginManagedOptions = {
  capability: typeof MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY;
  profileId: string;
  stateDir: string;
  beforePersist: () => Promise<void>;
  assertCurrent: () => void;
};

export type ModelsAuthLoginFlowResult = {
  providerId: string;
  methodId: string;
  authRefresh: ModelAuthRefreshOutcome;
  defaultModel?: string;
  imported?: boolean;
  profiles: Array<{
    profileId: string;
    provider: string;
    mode: "api_key" | "oauth" | "token";
  }>;
};

export type ModelsAuthLoginFlowOptions = LoginOptions & {
  ownerPluginId?: string;
  credentialOnly?: boolean;
  assertCurrent?: () => void;
  config?: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  onModelAccessRequested?: (request: PreparedProviderModelAccess) => void;
  env?: NodeJS.ProcessEnv;
  isRemote?: boolean;
  signal?: AbortSignal;
  openUrl?: (url: string) => Promise<void>;
  browserAuthorization?: ProviderAuthContext["oauth"]["authorize"];
  beforePersistentEffect?: () => void | Promise<void>;
  /** Publish a hosted login through its current Gateway instead of a separate CLI connection. */
  refreshAfterLogin?: (agentId: string) => Promise<void>;
  managed?: ModelsAuthLoginManagedOptions;
};
