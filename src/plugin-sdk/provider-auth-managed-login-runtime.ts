import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
  ModelsAuthLoginManagedOptions,
} from "../commands/models/auth.js";
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

export const MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY = "openclaw.models.auth.managed.v1";
export const MANAGED_MODELS_AUTH_LOGIN_ACCOUNT_MISMATCH_CODE = "account_mismatch";

export type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
  ModelsAuthLoginManagedOptions,
};

type RunModelsAuthLoginFlow = (
  opts: ModelsAuthLoginFlowOptions,
) => Promise<ModelsAuthLoginFlowResult>;

type ProviderAuthManagedLoginRuntime = {
  runModelsAuthLoginFlowCore: RunModelsAuthLoginFlow;
};

const loadProviderAuthManagedLoginRuntime = createLazyRuntimeModule(
  async (): Promise<ProviderAuthManagedLoginRuntime> => import("../commands/models/auth.js"),
);
const bindProviderAuthManagedLoginRuntime = createLazyRuntimeMethodBinder(
  loadProviderAuthManagedLoginRuntime,
);

export const runModelsAuthLoginFlow: RunModelsAuthLoginFlow = bindProviderAuthManagedLoginRuntime(
  (runtime) => runtime.runModelsAuthLoginFlowCore,
);
