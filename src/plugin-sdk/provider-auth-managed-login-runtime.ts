import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
  ModelsAuthLoginManagedOptions,
} from "../commands/models/auth-login-flow-types.js";
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY } from "../shared/provider-auth-managed-login-contract.js";

export {
  MANAGED_MODELS_AUTH_LOGIN_ACCOUNT_MISMATCH_CODE,
  MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY,
} from "../shared/provider-auth-managed-login-contract.js";

export type ModelsAuthManagedLoginFlowOptions = Omit<ModelsAuthLoginFlowOptions, "managed"> & {
  managed: ModelsAuthLoginManagedOptions;
};
export type { ModelsAuthLoginFlowResult, ModelsAuthLoginManagedOptions };

type RunModelsAuthLoginFlow = (
  opts: ModelsAuthManagedLoginFlowOptions,
) => Promise<ModelsAuthLoginFlowResult>;

type ProviderAuthManagedLoginRuntime = {
  runModelsAuthLoginFlowCore: (
    opts: ModelsAuthLoginFlowOptions,
  ) => Promise<ModelsAuthLoginFlowResult>;
};

const loadProviderAuthManagedLoginRuntime = createLazyRuntimeModule(
  async (): Promise<ProviderAuthManagedLoginRuntime> => import("../commands/models/auth.js"),
);
const bindProviderAuthManagedLoginRuntime = createLazyRuntimeMethodBinder(
  loadProviderAuthManagedLoginRuntime,
);
const runManagedModelsAuthLoginFlowCore = bindProviderAuthManagedLoginRuntime(
  (runtime) => runtime.runModelsAuthLoginFlowCore,
);

export const runManagedModelsAuthLoginFlow: RunModelsAuthLoginFlow = async (opts) => {
  const managed = opts.managed;
  if (!managed || managed.capability !== MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY) {
    throw new Error("Managed auth login requires the supported managed login capability marker.");
  }
  return await runManagedModelsAuthLoginFlowCore(opts);
};
