import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { describe, expect, it, vi } from "vitest";
import { prepareMemoryManagerReload, type MemoryManagerLifecycle } from "./lifecycle.js";
import { MemoryManagerRegistry } from "./manager-registry.js";

describe("memory manager adapter retirement", () => {
  it.each(["reject", "unavailable"])(
    "retires a fallback-backed manager when its %s primary adapter is replaced",
    async (failure) => {
      const registry = new MemoryManagerRegistry();
      const manager = { close: vi.fn(async () => {}) };
      const unaffected = { close: vi.fn(async () => {}) };
      registry.track(manager, "fallback-backed");
      registry.track(unaffected, "fallback-only");
      const primary: MemoryEmbeddingProviderAdapter = {
        id: "primary",
        create: async () => ({ provider: null }),
      };
      const fallback: MemoryEmbeddingProviderAdapter = {
        id: "fallback",
        create: async () => ({
          provider: {
            id: "fallback",
            model: "test-embedding",
            embed: async () => [1],
            embedBatch: async () => [[1]],
          },
        }),
      };
      const creation = registry.createProvider(manager, primary, async () => {
        if (failure === "reject") {
          throw new Error("Primary adapter unavailable");
        }
        return { provider: null };
      });
      if (failure === "reject") {
        await expect(creation).rejects.toThrow("Primary adapter unavailable");
      } else {
        await expect(creation).resolves.toEqual({ provider: null });
      }
      for (const owner of [manager, unaffected]) {
        await registry.createProvider(owner, fallback, () =>
          fallback.create({ config: {}, model: "test-embedding" }),
        );
      }

      const retirement = registry.prepareReload({
        retireRuntime: false,
        retiringEmbeddingProviders: [primary],
      });
      try {
        await expect(retirement.drain()).resolves.toEqual({ errors: [] });
        expect(manager.close).toHaveBeenCalledOnce();
        expect(unaffected.close).not.toHaveBeenCalled();
      } finally {
        retirement.resume();
      }
    },
  );
});

it("joins pending manager cleanup across overlapping reload drains", async () => {
  const registry = new MemoryManagerRegistry();
  const closing = createDeferred<void>();
  const manager = { close: () => closing.promise };
  const failure = new Error("manager cleanup failed");
  registry.track(manager, "shared-manager");
  const first = registry.prepareReload({ retireRuntime: true, retiringEmbeddingProviders: [] });
  const firstDrain = first.drain();
  const second = registry.prepareReload({ retireRuntime: true, retiringEmbeddingProviders: [] });
  const secondDrain = second.drain();
  try {
    closing.reject(failure);
    await expect(Promise.all([firstDrain, secondDrain])).resolves.toEqual([
      { errors: [failure] },
      { errors: [failure] },
    ]);
  } finally {
    closing.resolve();
    await Promise.allSettled([firstDrain, secondDrain]);
    first.resume();
    second.resume();
  }
});

it("owns failed late creation cleanup until explicit close", async () => {
  const registry = new MemoryManagerRegistry();
  const entered = createDeferred<void>();
  const released = createDeferred<void>();
  const failure = new Error("late manager close failed");
  const late = { close: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined) };
  const replacement = { close: vi.fn(async () => {}) };
  const transient = { close: vi.fn(async () => {}) };
  const pending = registry.acquire(
    { agentId: "main", purpose: "default" },
    {
      prepare: () => ({
        key: "main:late:default",
        reuse: () => true,
        create: async () => {
          entered.resolve();
          await released.promise;
          return late;
        },
      }),
    },
  );
  const observed = expect(pending).rejects.toBe(failure);
  await entered.promise;
  const retirement = registry.prepareReload({
    retireRuntime: true,
    retiringEmbeddingProviders: [],
  });
  const draining = retirement.drain();
  released.resolve();
  try {
    await observed;
    await draining;
  } finally {
    released.resolve();
    retirement.resume();
  }
  expect.soft(registry.canPublishProbe(late)).toBe(false);
  expect(late.close).toHaveBeenCalledOnce();
  await registry.acquire(
    { agentId: "main", purpose: "default" },
    {
      prepare: () => ({ key: "main:late:default", reuse: () => true, create: () => replacement }),
    },
  );
  await registry.acquire(
    { agentId: "main", purpose: "status" },
    {
      prepare: () => ({ key: "main:status", reuse: () => true, create: () => transient }),
    },
  );
  expect(late.close).toHaveBeenCalledOnce();
  await registry.closeAll();
  expect(late.close).toHaveBeenCalledTimes(2);
  expect(replacement.close).toHaveBeenCalledOnce();
  expect(transient.close).not.toHaveBeenCalled();
  await registry.closeAll();
  expect(late.close).toHaveBeenCalledTimes(2);
  expect(replacement.close).toHaveBeenCalledOnce();
  await transient.close();
});

it("fences acquisition when reload starts before the manager owner initializes", async () => {
  const lifecycle: MemoryManagerLifecycle = {};
  const reload = prepareMemoryManagerReload(
    { retireRuntime: true, retiringEmbeddingProviders: [] },
    lifecycle,
  );
  const registry = new MemoryManagerRegistry(lifecycle);
  const manager = { close: vi.fn(async () => {}) };
  const create = vi.fn(() => manager);
  const acquire = () =>
    registry.acquire(
      { agentId: "main", purpose: "default" },
      {
        prepare: () => ({ key: "main:default", create, reuse: () => true }),
      },
    );
  try {
    await expect(acquire()).rejects.toThrow("reloading");
    expect(create).not.toHaveBeenCalled();
    await expect(reload.drain()).resolves.toEqual({ errors: [] });
  } finally {
    reload.resume();
  }
  expect(await acquire()).toBe(manager);
  await registry.closeAll();
  expect(manager.close).toHaveBeenCalledOnce();
});

describe("shared memory lifecycle with opaque provider factories", () => {
  const adapter: MemoryEmbeddingProviderAdapter = {
    id: "gateway-embedding",
    create: async () => ({ provider: null }),
  };
  const providerChange = { retireRuntime: false, retiringEmbeddingProviders: [adapter] };

  it.each([false, true])("drains both registry owners (opaque first: %s)", async (opaqueFirst) => {
    const lifecycle: MemoryManagerLifecycle = {};
    const first = new MemoryManagerRegistry(lifecycle, { retireOnProviderReload: opaqueFirst });
    const second = new MemoryManagerRegistry(lifecycle, { retireOnProviderReload: !opaqueFirst });
    const native = opaqueFirst ? second : first;
    const opaque = opaqueFirst ? first : second;
    const dependent = { close: vi.fn(async () => {}) };
    const unrelated = { close: vi.fn(async () => {}) };
    const remote = { close: vi.fn(async () => {}) };
    const diagnostic = { close: vi.fn(async () => {}) };
    native.track(dependent, "main:dependent:default");
    native.track(unrelated, "main:unrelated:default");
    await native.createProvider(dependent, adapter, () =>
      adapter.create({ config: {}, model: "test" }),
    );
    for (const [purpose, manager] of [
      ["default", remote],
      ["status", diagnostic],
    ] as const) {
      await opaque.acquire(
        { agentId: "main", purpose },
        {
          prepare: () => ({
            key: `main:remote:${purpose}`,
            create: () => manager,
            reuse: () => true,
          }),
        },
      );
    }
    // Ordinary close retains caller-owned diagnostics; provider retirement must not.
    await opaque.closeAll();
    expect(remote.close).toHaveBeenCalledOnce();
    expect(diagnostic.close).not.toHaveBeenCalled();
    const replacement = { close: vi.fn(async () => {}) };
    await opaque.acquire(
      { agentId: "main", purpose: "default" },
      {
        prepare: () => ({
          key: "main:remote:default",
          create: () => replacement,
          reuse: () => true,
        }),
      },
    );

    const reload = prepareMemoryManagerReload(providerChange, lifecycle);
    try {
      await expect(reload.drain()).resolves.toEqual({ errors: [] });
      expect(dependent.close).toHaveBeenCalledOnce();
      expect(unrelated.close).not.toHaveBeenCalled();
      expect(replacement.close).toHaveBeenCalledOnce();
      expect(diagnostic.close).toHaveBeenCalledOnce();
    } finally {
      reload.resume();
    }
  });

  it.each(["default", "status"] as const)(
    "owns a pending %s factory across provider reload and early resume",
    async (purpose) => {
      const lifecycle: MemoryManagerLifecycle = {};
      const registry = new MemoryManagerRegistry(lifecycle, { retireOnProviderReload: true });
      const entered = createDeferred<void>();
      const released = createDeferred<void>();
      const late = { close: vi.fn(async () => {}) };
      const pending = registry.acquire(
        { agentId: "main", purpose },
        {
          prepare: () => ({
            key: `main:remote:${purpose}`,
            reuse: () => true,
            create: async () => {
              entered.resolve();
              await released.promise;
              return late;
            },
          }),
        },
      );
      const observed = expect(pending).rejects.toThrow("reloading");
      await entered.promise;
      const reload = prepareMemoryManagerReload(providerChange, lifecycle);
      let drained = false;
      const draining = reload.drain().then((result) => {
        drained = true;
        return result;
      });
      const create = vi.fn(() => late);
      await expect(
        registry.acquire(
          { agentId: "other", purpose },
          { prepare: () => ({ key: `other:remote:${purpose}`, create, reuse: () => true }) },
        ),
      ).rejects.toThrow("reloading");
      expect(create).not.toHaveBeenCalled();
      expect(drained).toBe(false);

      // A timeout can resume the retained plugin while its old factory is still pending.
      reload.resume();
      const replacement = { close: vi.fn(async () => {}) };
      await registry.acquire(
        { agentId: "other", purpose: "default" },
        {
          prepare: () => ({
            key: "other:new:default",
            create: () => replacement,
            reuse: () => true,
          }),
        },
      );
      released.resolve();
      await observed;
      await expect(draining).resolves.toEqual({ errors: [] });
      expect(late.close).toHaveBeenCalledOnce();
      expect(replacement.close).not.toHaveBeenCalled();
      await registry.closeAll();
      expect(replacement.close).toHaveBeenCalledOnce();
    },
  );

  it("retains failed late factory cleanup for retry after provider replacement", async () => {
    const lifecycle: MemoryManagerLifecycle = {};
    const registry = new MemoryManagerRegistry(lifecycle, { retireOnProviderReload: true });
    const entered = createDeferred<void>();
    const released = createDeferred<void>();
    const failure = new Error("remote close failed");
    const late = { close: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined) };
    const pending = registry.acquire(
      { agentId: "main", purpose: "default" },
      {
        prepare: () => ({
          key: "main:remote:default",
          reuse: () => true,
          create: async () => {
            entered.resolve();
            await released.promise;
            return late;
          },
        }),
      },
    );
    const observed = expect(pending).rejects.toBe(failure);
    await entered.promise;
    const reload = prepareMemoryManagerReload(providerChange, lifecycle);
    const draining = reload.drain();
    reload.resume();
    released.resolve();
    await observed;
    await draining;
    expect(late.close).toHaveBeenCalledOnce();
    await registry.closeAll();
    expect(late.close).toHaveBeenCalledTimes(2);
    await registry.closeAll();
    expect(late.close).toHaveBeenCalledTimes(2);
  });

  it("fences an opaque registry initialized during provider replacement", async () => {
    const lifecycle: MemoryManagerLifecycle = {};
    const reload = prepareMemoryManagerReload(providerChange, lifecycle);
    const registry = new MemoryManagerRegistry(lifecycle, { retireOnProviderReload: true });
    const manager = { close: vi.fn(async () => {}) };
    const create = vi.fn(() => manager);
    const acquire = () =>
      registry.acquire(
        { agentId: "main", purpose: "default" },
        { prepare: () => ({ key: "main:remote:default", create, reuse: () => true }) },
      );
    try {
      await expect(acquire()).rejects.toThrow("reloading");
      expect(create).not.toHaveBeenCalled();
      await expect(reload.drain()).resolves.toEqual({ errors: [] });
    } finally {
      reload.resume();
    }
    expect(await acquire()).toBe(manager);
    await registry.closeAll();
  });
});
