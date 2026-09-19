import { vi } from "vitest";
import type { ProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";

export function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

export function createProvider(params: {
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
