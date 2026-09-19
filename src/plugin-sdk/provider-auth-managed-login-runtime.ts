import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
  ModelsAuthLoginManagedOptions,
} from "../commands/models/auth.js";
import { createLazyRuntimeMethodBinder, createLazyRuntimeModule } from "../shared/lazy-runtime.js";

export const MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY = "openclaw.models.auth.managed.v1";
export const MANAGED_MODELS_AUTH_LOGIN_ACCOUNT_MISMATCH_CODE = "account_mismatch";

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
const runModelsAuthLoginFlowCore = bindProviderAuthManagedLoginRuntime(
  (runtime) => runtime.runModelsAuthLoginFlowCore,
);

export const runModelsAuthLoginFlow: RunModelsAuthLoginFlow = async (opts) => {
  const managed = (opts as Partial<ModelsAuthManagedLoginFlowOptions>).managed;
  if (!managed || managed.capability !== MANAGED_MODELS_AUTH_LOGIN_FLOW_CAPABILITY) {
    throw new Error("Managed auth login requires the supported managed login capability marker.");
  }
  return await runModelsAuthLoginFlowCore(opts);
};
