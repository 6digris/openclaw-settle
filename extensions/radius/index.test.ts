import fs from "node:fs";
import path from "node:path";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createNonExitingRuntimeEnv,
  createTestWizardPrompter,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import radiusPlugin from "./index.js";

const { fetchGuard, streamFetch, resolveAuth } = vi.hoisted(() => ({
  fetchGuard: vi.fn(),
  streamFetch: vi.fn(),
  resolveAuth: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveAuth,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchGuard,
}));
vi.mock("openclaw/plugin-sdk/provider-transport-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-transport-runtime")>()),
  buildGuardedModelFetch: () => streamFetch,
}));

afterEach(() => vi.resetAllMocks());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([false, true])(
  "presents the registered device sign-in and cancels before polling (remote=%s)",
  async (isRemote) => {
    fetchGuard.mockResolvedValueOnce({
      response: Response.json({
        device_code: "synthetic-device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://radius.earendil.com/device",
        expires_in: 300,
        interval: 5,
      }),
      release: async () => undefined,
    });
    const provider = await registerSingleProviderPlugin(radiusPlugin);
    const method = provider.auth.find((entry) => entry.id === "oauth");
    if (!method) {
      throw new Error("Radius did not register its OAuth method");
    }
    const abort = new AbortController();
    const started = createDeferred<void>();
    const openUrl = vi.fn(async () => undefined);
    const deviceCode = vi.fn(async () => undefined);
    const stop = vi.fn();
    const login = method.run({
      config: {},
      runtime: createNonExitingRuntimeEnv(),
      prompter: createTestWizardPrompter({
        deviceCode,
        progress: () => {
          started.resolve();
          return { update: vi.fn(), stop };
        },
      }),
      signal: abort.signal,
      isRemote,
      openUrl,
      oauth: {
        createVpsAwareHandlers: () => {
          throw new Error("Unexpected callback flow");
        },
      },
    });
    try {
      expect(await Promise.race([started.promise.then(() => true), login.then(() => false)])).toBe(
        true,
      );
      expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://radius.earendil.com/device");
      expect(deviceCode).toHaveBeenCalledExactlyOnceWith({
        title: "Radius sign-in",
        code: "ABCD-EFGH",
        expiresInMinutes: 5,
        message: "Enter this one-time code to sign in to Radius.",
      });
      abort.abort();
      await expect(login).rejects.toThrow(/abort/i);
      expect(stop).toHaveBeenCalledExactlyOnceWith("Radius sign-in stopped");
    } finally {
      abort.abort();
      await login.catch(() => undefined);
    }
    expect(fetchGuard).toHaveBeenCalledOnce();
  },
);

it("routes a discovered organization model through the registered native transport", async () => {
  const metadata = {
    id: "organization/custom-model",
    name: "Organization model",
    reasoning: true,
    input: ["text"] as const,
    contextWindow: 100_000,
    maxTokens: 4096,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
  fetchGuard.mockResolvedValue({
    response: Response.json({ baseUrl: "https://radius.pi.dev/v1", models: [metadata] }),
    release: async () => undefined,
  });
  const provider = await registerSingleProviderPlugin(radiusPlugin);
  const catalog = await runSingleProviderCatalog(provider, {
    resolveProviderAuth: () => ({
      apiKey: "RADIUS_API_KEY",
      discoveryApiKey: "test-radius-key",
      mode: "api_key",
      source: "env",
    }),
  });
  expect(catalog.models).toHaveLength(1);
  const modelsPath = path.join(tempDirs.make("radius-catalog-"), "models.json");
  fs.writeFileSync(modelsPath, JSON.stringify({ providers: { radius: catalog } }));
  const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
  const model = registry.find("radius", metadata.id);
  if (!model) {
    throw new Error("Discovered Radius model is missing from the registry");
  }
  expect(model.api).toBe("pi-messages");
  const streamFn = provider.createStreamFn?.({
    model,
    modelId: model.id,
    provider: "radius",
  });
  expect(streamFn).toBeTypeOf("function");
  if (!streamFn) {
    throw new Error("Missing Radius transport");
  }
  const usage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0.000001, output: 0.000002, cacheRead: 0, cacheWrite: 0, total: 0.000003 },
  };
  streamFetch.mockResolvedValue(
    new Response(
      [
        { type: "text_start", contentIndex: 0 },
        { type: "text_end", contentIndex: 0, content: "Connected" },
        { type: "done", reason: "stop", usage },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
    ),
  );
  const stream = await streamFn(
    model,
    { messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
    { apiKey: "test-radius-key" },
  );
  expect(await stream.result()).toMatchObject({
    api: "pi-messages",
    stopReason: "stop",
    content: [{ type: "text", text: "Connected" }],
    usage,
  });
  const call = streamFetch.mock.calls[0];
  if (!call) {
    throw new Error("Expected a Radius model request");
  }
  const [url, request] = call;
  expect(url).toBe("https://radius.pi.dev/v1/messages");
  expect(JSON.parse(request.body).model).toBe("organization/custom-model");
});

it("resolves a cold agent's model from its pinned account without inventing unknown models", async () => {
  const model = {
    id: "organization/cold-model",
    name: "Cold model",
    reasoning: true,
    input: ["text"],
    contextWindow: 64_000,
    maxTokens: 4096,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
  fetchGuard.mockImplementation(async () => ({
    response: Response.json({ baseUrl: "https://radius.pi.dev/v1", models: [model] }),
    release: async () => undefined,
  }));
  resolveAuth.mockResolvedValue({ apiKey: "test-pinned-key" });
  const provider = await registerSingleProviderPlugin(radiusPlugin);
  const ctx = {
    provider: "radius",
    modelId: model.id,
    authProfileId: "radius:account-a",
    modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
  };
  expect(ctx.modelRegistry.find("radius", model.id)).toBeUndefined();
  expect(await provider.prepareDynamicModel?.(ctx)).toMatchObject({
    ...model,
    provider: "radius",
    api: "pi-messages",
    baseUrl: "https://radius.pi.dev/v1",
  });
  expect(resolveAuth).toHaveBeenCalledWith(
    expect.objectContaining({
      provider: "radius",
      profileId: "radius:account-a",
      lockedProfile: true,
    }),
  );
  expect(
    await provider.prepareDynamicModel?.({ ...ctx, modelId: "not-in-account" }),
  ).toBeUndefined();
});
