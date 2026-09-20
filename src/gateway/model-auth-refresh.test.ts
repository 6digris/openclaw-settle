import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  clearUsageCache: vi.fn(),
  prepareRuntime: vi.fn(),
  refreshSecrets: vi.fn(),
  reloadSharedStore: vi.fn(),
}));

vi.mock("../agents/auth-profiles/path-resolve.js", () => ({
  reloadSharedAuthStoreOwnership: mocks.reloadSharedStore,
}));
vi.mock("../agents/prepared-model-runtime.js", () => ({
  prepareModelRuntimeSnapshot: mocks.prepareRuntime,
}));
vi.mock("../agents/prepared-model-runtime.owner.js", () => ({
  preparedModelRuntimeConfigsMatch: (left: unknown, right: unknown) => left === right,
}));
vi.mock("../secrets/runtime.js", () => ({
  refreshActiveProviderAuthRuntimeSnapshot: mocks.refreshSecrets,
}));
vi.mock("./server-methods/model-auth-agent-scope.js", () => ({
  modelAuthAgentScopeError: () => ({ message: "invalid agent" }),
  resolveModelAuthAgentScope: (_config: unknown, agentId: string) => ({
    ok: true,
    agentId,
    agentDir: `/tmp/${agentId}`,
  }),
}));
vi.mock("./server-methods/models-auth-status-usage-cache.js", () => ({
  clearModelAuthStatusUsageCache: mocks.clearUsageCache,
}));

import { refreshModelAuthStateAfterMutation } from "./model-auth-refresh.js";

describe("refreshModelAuthStateAfterMutation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.prepareRuntime.mockImplementation(async ({ config }) => ({ config }));
    mocks.refreshSecrets.mockResolvedValue(undefined);
  });

  it("accepts the replacement config generation returned by preparation", async () => {
    const initial = {} satisfies OpenClawConfig;
    const replacement = { auth: {} } satisfies OpenClawConfig;
    let current = initial;
    mocks.prepareRuntime.mockImplementationOnce(async () => {
      current = replacement;
      return { config: replacement };
    });

    await refreshModelAuthStateAfterMutation(() => current, "main");

    expect(mocks.prepareRuntime).toHaveBeenNthCalledWith(1, {
      config: initial,
      agentId: "main",
      agentDir: "/tmp/main",
    });
    expect(mocks.prepareRuntime).toHaveBeenCalledTimes(1);
  });

  it("joins a replacement when the prepared generation is behind runtime config", async () => {
    const initial = {} satisfies OpenClawConfig;
    const replacement = { auth: {} } satisfies OpenClawConfig;
    let current = initial;
    mocks.prepareRuntime.mockImplementationOnce(async () => {
      current = replacement;
      return { config: initial };
    });

    await refreshModelAuthStateAfterMutation(() => current, "main");

    expect(mocks.prepareRuntime).toHaveBeenNthCalledWith(1, {
      config: initial,
      agentId: "main",
      agentDir: "/tmp/main",
    });
    expect(mocks.prepareRuntime).toHaveBeenNthCalledWith(2, {
      config: replacement,
      agentId: "main",
      agentDir: "/tmp/main",
    });
  });

  it("fails closed when config keeps changing", async () => {
    let revision = 0;
    const getRuntimeConfig = (): OpenClawConfig => ({
      auth: { order: { fixture: [String(revision++)] } },
    });

    await expect(refreshModelAuthStateAfterMutation(getRuntimeConfig, "main")).rejects.toThrow(
      "Gateway config kept changing while refreshing model authentication",
    );
    expect(mocks.prepareRuntime).toHaveBeenCalledTimes(3);
  });
});
