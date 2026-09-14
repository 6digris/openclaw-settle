import { setImmediate } from "node:timers/promises";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { loadDiscordComponentRegistryTestHarness } from "../../extensions/discord/test-api.js";
import { createDeferredCore } from "../shared/deferred.js";
import { LegacyPluginSdkResourceHost } from "./legacy-sdk-resource-host.js";
import { PluginInstance } from "./plugin-instance.js";

let registry: Awaited<ReturnType<typeof loadDiscordComponentRegistryTestHarness>>;

const mocked = vi.hoisted(() => {
  const state: {
    runtime?: typeof import("../../extensions/discord/runtime-api.js");
    error: ReturnType<typeof vi.fn>;
  } = { error: vi.fn() };
  return state;
});
// This registration-flow test executes the actual current plugin runtime and
// registry through the external SDK facade; source selection stays synthetic.
vi.mock("../plugin-sdk/facade-loader.js", async (original) => ({
  ...(await original<typeof import("../plugin-sdk/facade-loader.js")>()),
  createLazyFacadeObjectValue: () => ({}),
  loadBundledPluginPublicSurfaceModuleSyncCore: () => {
    if (!mocked.runtime) {
      throw new Error("runtime fixture not loaded");
    }
    return mocked.runtime;
  },
}));
vi.mock("../logging/subsystem.js", async (original) => {
  const actual = await original<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) =>
      name === "plugins/sdk"
        ? { ...actual.createSubsystemLogger(name), error: mocked.error }
        : actual.createSubsystemLogger(name),
  };
});

beforeAll(async () => {
  registry = await loadDiscordComponentRegistryTestHarness();
  mocked.runtime = await import("../../extensions/discord/runtime-api.js");
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocked.error.mockReset();
  registry.clearDiscordComponentEntriesForTest();
});

async function registrationFor(surface: "sdk" | "runtime") {
  return surface === "sdk"
    ? (await import("openclaw/plugin-sdk/discord")).registerBuiltDiscordComponentMessage
    : (await import("../../extensions/discord/runtime-api.js"))
        .registerBuiltDiscordComponentMessage;
}
function built(id: string) {
  return {
    components: [],
    entries: [{ id, kind: "button" as const, label: id }],
    modals: [{ id: `${id}-modal`, title: id, fields: [] }],
  };
}

it.each(["sdk", "runtime"] as const)(
  "%s preserves its return contract and admits no-await readers behind blocked persistence",
  async (surface) => {
    const register = await registrationFor(surface);
    const host = new LegacyPluginSdkResourceHost();
    const started = createDeferredCore();
    const release = createDeferredCore();
    registry.discordComponentRegistryState.persistentComponentStore = {
      register: async () => {
        started.resolve();
        await release.promise;
      },
      lookup: async () => undefined,
      consume: async () => undefined,
      delete: async () => true,
    };
    const params = { buildResult: built("first"), messageId: "first-message" };
    const result = host.run(() => register(params));
    const read = registry.resolveDiscordComponentEntryWithPersistence({
      id: "first",
      consume: false,
    });
    const modal = registry.resolveDiscordModalEntryWithPersistence({
      id: "first-modal",
      consume: false,
    });
    const queued = host.run(() =>
      register({ buildResult: built("second"), messageId: "second-message" }),
    );
    params.buildResult.entries[0]!.label = "changed after admission";
    params.messageId = "changed-message";
    let readSettled = false;
    const lookup = read.then((entry) => {
      readSettled = true;
      return entry;
    });
    try {
      await started.promise;
      await setImmediate();
      expect(readSettled).toBe(false);
      if (surface === "sdk") {
        expect(result).toBeUndefined();
        expect(queued).toBeUndefined();
      } else {
        expect(result).toBeInstanceOf(Promise);
        expect(queued).toBeInstanceOf(Promise);
      }
      release.resolve();
      expect(await lookup).toMatchObject({ label: "first", messageId: "first-message" });
      expect(await modal).toMatchObject({ title: "first", messageId: "first-message" });
    } finally {
      release.resolve();
      await Promise.allSettled([Promise.resolve(result), Promise.resolve(queued), lookup, modal]);
      await host.close();
    }
  },
);

it("sdk retains nested synchronous same-instance registration beyond ordinary retirement grace", async () => {
  const register = await registrationFor("sdk");
  const host = new LegacyPluginSdkResourceHost();
  const instance = new PluginInstance("discord");
  const slot = createPluginRuntimeStore<{ identity: string }>({
    pluginId: "retirement-proof",
    errorMessage: "retired slot",
  });
  instance.run(() => slot.setRuntime({ identity: "original" }));
  const started = createDeferredCore();
  const release = createDeferredCore();
  const persisted: string[] = [];
  registry.discordComponentRegistryState.persistentComponentStore = {
    register: async () => {
      started.resolve();
      await release.promise;
      persisted.push(slot.getRuntime().identity);
    },
    lookup: async () => undefined,
    consume: async () => undefined,
    delete: async () => true,
  };
  let result: unknown;
  const callback = instance.wrap(() => {
    result = register({ buildResult: built("nested"), messageId: "nested-message" });
  });
  expect(host.run(callback)).toBeUndefined();
  // Observe the defective baseline's returned Promise without returning it from
  // the synchronous managed callback; repaired calls return actual undefined.
  const observed = Promise.resolve(result);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let disposed = false;
  const retirement = instance.dispose().then((outcome) => {
    disposed = true;
    return outcome;
  });
  try {
    await started.promise;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(disposed).toBe(false);
    expect(instance.lifecycle.signal.aborted).toBe(false);
    expect(() => host.run(callback)).toThrow(/retir|unavailable|reloaded|disabled/i);
    release.resolve();
    expect(await retirement).toEqual({ errors: [] });
    expect(persisted).toEqual(["original"]);
    expect(instance.hasRetainedConsumers).toBe(false);
  } finally {
    release.resolve();
    await observed;
    await retirement;
    await host.close();
  }
});

it("sdk owns unexpected asynchronous failure and releases the exact consumer", async () => {
  const register = await registrationFor("sdk");
  const host = new LegacyPluginSdkResourceHost();
  const instance = new PluginInstance("discord");
  const failure = new Error("synthetic unexpected registration failure");
  const completion = createDeferredCore();
  vi.spyOn(registry.discordComponentRegistryState, "withRegistryLock").mockImplementationOnce(
    () => completion.promise,
  );
  let result: unknown;
  host.run(() =>
    instance.run(() => {
      result = register({ buildResult: built("reject"), messageId: "reject-message" });
    }),
  );
  const baselineOutcome = Promise.resolve(result).then(
    () => undefined,
    (error: unknown) => error,
  );
  completion.reject(failure);
  await baselineOutcome;
  await setImmediate();
  try {
    expect(mocked.error).toHaveBeenCalledOnce();
    expect(mocked.error.mock.calls[0]?.[0]).toContain(failure.message);
    await expect(host.close()).rejects.toMatchObject({ errors: [failure] });
    expect(instance.hasRetainedConsumers).toBe(false);
  } finally {
    await host.close().catch(() => undefined);
    await instance.dispose();
  }
});

it("sdk preserves synchronous normalization throws and closed-host refusal", async () => {
  const register = await registrationFor("sdk");
  const host = new LegacyPluginSdkResourceHost();
  const instance = new PluginInstance("discord");
  const failure = new Error("synthetic normalization failure");
  const buildResult = built("invalid");
  const read = vi.fn(() => {
    throw failure;
  });
  Object.defineProperty(buildResult, "entries", { get: read });
  expect(() =>
    host.run(() => instance.run(() => register({ buildResult, messageId: "invalid" }))),
  ).toThrow(failure);
  await host.close();
  expect(instance.hasRetainedConsumers).toBe(false);
  expect(mocked.error).not.toHaveBeenCalled();
  read.mockClear();
  expect(() => host.run(() => register({ buildResult, messageId: "closed" }))).toThrow("closed");
  expect(read).not.toHaveBeenCalled();
  expect(await instance.dispose()).toEqual({ errors: [] });
});

it.each(["sdk", "runtime"] as const)(
  "%s keeps expected store rejection as reported in-memory fallback rather than a fatal handoff",
  async (surface) => {
    const register = await registrationFor(surface);
    const host = new LegacyPluginSdkResourceHost();
    registry.discordComponentRegistryState.persistentComponentStore = {
      register: async () => {
        throw new Error("synthetic expected store failure");
      },
      lookup: async () => undefined,
      consume: async () => undefined,
      delete: async () => true,
    };
    const completion = host.run(() =>
      register({ buildResult: built("fallback"), messageId: "fallback-message" }),
    );
    if (surface === "runtime") {
      expect(completion).toBeInstanceOf(Promise);
    } else {
      expect(completion).toBeUndefined();
    }
    await completion;
    expect(
      await registry.resolveDiscordComponentEntryWithPersistence({
        id: "fallback",
        consume: false,
      }),
    ).toMatchObject({ messageId: "fallback-message" });
    expect(registry.discordComponentRegistryState.persistentRegistryDisabled).toBe(true);
    await host.close();
    expect(mocked.error).not.toHaveBeenCalled();
  },
);

it("exposes an explicitly awaited runtime boundary that joins both persistence stores", async () => {
  const { registerBuiltDiscordComponentMessage: register } =
    await import("../../extensions/discord/runtime-api.js");
  const component = createDeferredCore();
  const modal = createDeferredCore();
  const componentStarted = createDeferredCore();
  const modalStarted = createDeferredCore();
  registry.discordComponentRegistryState.persistentComponentStore = {
    register: () => {
      componentStarted.resolve();
      return component.promise;
    },
    lookup: async () => undefined,
    consume: async () => undefined,
    delete: async () => true,
  };
  registry.discordComponentRegistryState.persistentModalStore = {
    register: () => {
      modalStarted.resolve();
      return modal.promise;
    },
    lookup: async () => undefined,
    consume: async () => undefined,
    delete: async () => true,
  };
  const registration = register({ buildResult: built("awaited"), messageId: "awaited-message" });
  expect(registration).toBeInstanceOf(Promise);
  let settled = false;
  const observed = registration.then(() => {
    settled = true;
  });
  try {
    await Promise.all([componentStarted.promise, modalStarted.promise]);
    component.resolve();
    await setImmediate();
    expect(settled).toBe(false);
    modal.resolve();
    await observed;
    expect(settled).toBe(true);
  } finally {
    component.resolve();
    modal.resolve();
    await observed;
  }
});
