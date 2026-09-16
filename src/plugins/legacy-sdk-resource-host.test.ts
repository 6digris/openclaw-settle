import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { runWithTrackedCancellation, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { LegacyPluginSdkResourceHost } from "./legacy-sdk-resource-host.js";
import { PluginInstance } from "./plugin-instance.js";

const mocked = { error: vi.fn<(error: unknown) => void>() };
afterEach(() => {
  mocked.error.mockReset();
  vi.useRealTimers();
});

it("admits synchronously, returns undefined, fences close, and releases resources after work", async () => {
  const host = new LegacyPluginSdkResourceHost();
  const gate = createDeferredCore();
  const events: string[] = [];
  host.adopt(
    {},
    {
      release: async () => {
        events.push("release");
      },
    },
  );
  expect(
    host.run(() =>
      host.invokeDetached(async () => {
        events.push("admitted");
        await gate.promise;
        events.push("settled");
      }, mocked.error),
    ),
  ).toBeUndefined();
  expect(events).toEqual(["admitted"]);
  const close = host.close();
  expect(() =>
    host.run(() =>
      host.invokeDetached(() => {
        events.push("refused");
      }, mocked.error),
    ),
  ).toThrow("closed");
  await setImmediate();
  expect(events).toEqual(["admitted"]);
  gate.resolve();
  await close;
  expect(events).toEqual(["admitted", "settled", "release"]);
});

it("registers ownership before an admitted callback reenters host close", async () => {
  const host = new LegacyPluginSdkResourceHost();
  const gate = createDeferredCore();
  const release = vi.fn(async () => {});
  host.adopt({}, { release });
  let close: Promise<void> | undefined;
  host.run(() =>
    host.invokeDetached(() => {
      close = host.close();
      return gate.promise;
    }, mocked.error),
  );
  await setImmediate();
  expect(release).not.toHaveBeenCalled();
  gate.resolve();
  await close;
  expect(release).toHaveBeenCalledOnce();
});

it("holds the exact consumer for cooperating tails after a synchronous result", async () => {
  const host = new LegacyPluginSdkResourceHost();
  const instance = new PluginInstance("tail-owner");
  const slot = createPluginRuntimeStore<{ id: string }>({
    pluginId: "tail-owner",
    errorMessage: "retired",
  });
  instance.run(() => slot.setRuntime({ id: "original" }));
  const gate = createDeferredCore();
  let tail: Promise<string> | undefined;
  host.run(() =>
    instance.run(() =>
      host.invokeDetached(() => {
        tail = trackAsyncWork(async () => {
          await gate.promise;
          return slot.getRuntime().id;
        });
      }, mocked.error),
    ),
  );
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let disposed = false;
  const retirement = instance.dispose().then((value) => {
    disposed = true;
    return value;
  });
  try {
    await vi.advanceTimersByTimeAsync(6_000);
    expect(disposed).toBe(false);
    expect(instance.hasRetainedConsumers).toBe(true);
    gate.resolve();
    expect(await tail).toBe("original");
    expect(await retirement).toEqual({ errors: [] });
    expect(instance.hasRetainedConsumers).toBe(false);
  } finally {
    gate.resolve();
    await tail;
    await retirement;
    await host.close();
  }
});

it.each([false, true])(
  "retains nested cancellation-scope tails and their cancellation listener (host closing: %s)",
  async (closeHost) => {
    const host = new LegacyPluginSdkResourceHost();
    const instance = new PluginInstance("nested-cancellation-owner");
    const slot = createPluginRuntimeStore<{ id: string }>({
      pluginId: "nested-cancellation-owner",
      errorMessage: "retired",
    });
    instance.run(() => slot.setRuntime({ id: "original" }));
    const cancel = new AbortController();
    const gate = createDeferredCore();
    let tail: Promise<{ id: string; cancelled: boolean }> | undefined;
    host.run(() =>
      instance.run(() =>
        host.invokeDetached(
          () =>
            runWithTrackedCancellation(cancel.signal, (signal) => {
              host.invoke(() => {
                tail = trackAsyncWork(async () => {
                  await gate.promise;
                  return { id: slot.getRuntime().id, cancelled: signal.aborted };
                });
              });
            }),
          mocked.error,
        ),
      ),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let disposed = false;
    const retirement = instance.dispose().then((result) => {
      disposed = true;
      return result;
    });
    const closing = closeHost ? host.close() : undefined;
    try {
      await vi.advanceTimersByTimeAsync(6_000);
      expect(disposed).toBe(false);
      expect(instance.hasRetainedConsumers).toBe(true);
      cancel.abort();
      gate.resolve();
      expect(await tail).toEqual({ id: "original", cancelled: true });
      expect(await retirement).toEqual({ errors: [] });
    } finally {
      gate.resolve();
      await tail?.catch(() => undefined);
      await retirement;
      await closing;
      await host.close();
    }
  },
);

it("refuses a retained closed child work scope before invoking plugin code", async () => {
  const host = new LegacyPluginSdkResourceHost();
  const instance = new PluginInstance("closed-child-owner");
  const parentGate = createDeferredCore();
  const childDone = createDeferredCore();
  const effect = vi.fn();
  let invokeRetired: (() => void) | undefined;
  host.run(() =>
    instance.run(() =>
      host.invokeDetached(async () => {
        await runWithTrackedCancellation(new AbortController().signal, () => {
          const resume = AsyncLocalStorage.snapshot();
          invokeRetired = () => resume(() => host.invoke(effect));
        });
        childDone.resolve();
        await parentGate.promise;
      }, mocked.error),
    ),
  );
  try {
    await childDone.promise;
    await setImmediate();
    if (!invokeRetired) {
      throw new Error("missing retained child fixture");
    }
    expect(invokeRetired).toThrow(/work scope is closed/i);
    expect(effect).not.toHaveBeenCalled();
    parentGate.resolve();
    await expect(host.close()).resolves.toBeUndefined();
  } finally {
    parentGate.resolve();
    await host.close().catch(() => undefined);
    await instance.dispose();
  }
});

it("reports a rejected result immediately while keeping its cooperating tail owned", async () => {
  const host = new LegacyPluginSdkResourceHost();
  const instance = new PluginInstance("failed-tail-owner");
  const gate = createDeferredCore();
  const failure = new Error("synthetic failed detached result");
  let tail: Promise<void> | undefined;
  host.run(() =>
    instance.run(() =>
      host.invokeDetached(() => {
        tail = trackAsyncWork(() => gate.promise);
        return Promise.reject(failure);
      }, mocked.error),
    ),
  );
  const retirement = instance.dispose();
  await setImmediate();
  try {
    expect(mocked.error).toHaveBeenCalledOnce();
    expect(mocked.error).toHaveBeenCalledWith(failure);
    expect(instance.hasRetainedConsumers).toBe(true);
  } finally {
    gate.resolve();
    await tail;
    await retirement;
    await expect(host.close()).rejects.toMatchObject({ errors: [failure] });
  }
});

it("retains reporter failures without losing the original failure or consumer release", async () => {
  const host = new LegacyPluginSdkResourceHost();
  const instance = new PluginInstance("reporter-owner");
  const failure = new Error("synthetic operation failure");
  const reporterFailure = new Error("synthetic reporter failure");
  mocked.error.mockImplementationOnce(() => {
    throw reporterFailure;
  });
  host.run(() =>
    instance.run(() => host.invokeDetached(() => Promise.reject(failure), mocked.error)),
  );
  await expect(host.close()).rejects.toMatchObject({ errors: [failure, reporterFailure] });
  expect(instance.hasRetainedConsumers).toBe(false);
  expect(await instance.dispose()).toEqual({ errors: [] });
});

it("preserves a synchronous throw while retaining previously admitted tails", async () => {
  const host = new LegacyPluginSdkResourceHost();
  const instance = new PluginInstance("throw-owner");
  const gate = createDeferredCore();
  const failure = new Error("synthetic synchronous failure");
  let tail: Promise<void> | undefined;
  expect(() =>
    host.run(() =>
      instance.run(() =>
        host.invokeDetached(() => {
          tail = trackAsyncWork(() => gate.promise);
          throw failure;
        }, mocked.error),
      ),
    ),
  ).toThrow(failure);
  const retirement = instance.dispose();
  await setImmediate();
  expect(instance.hasRetainedConsumers).toBe(true);
  gate.resolve();
  await tail;
  expect(await retirement).toEqual({ errors: [] });
  await host.close();
  expect(mocked.error).not.toHaveBeenCalled();
});

it("refuses fresh detached admission from a retained caller after ordinary retirement", async () => {
  const host = new LegacyPluginSdkResourceHost();
  const instance = new PluginInstance("retired-owner");
  const parent = instance.retainConsumer();
  instance.quiesce();
  const run = vi.fn();
  expect(() => host.run(() => parent.run(() => host.invokeDetached(run, mocked.error)))).toThrow(
    /retir|unavailable|reloaded|disabled/i,
  );
  expect(run).not.toHaveBeenCalled();
  parent.release();
  expect(await instance.dispose()).toEqual({ errors: [] });
  await host.close();
});

it("keeps admitted SDK invocation tails in their detached consumer during host close", async () => {
  const host = new LegacyPluginSdkResourceHost();
  const instance = new PluginInstance("nested-sdk-owner");
  const start = createDeferredCore();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  let tail: Promise<void> | undefined;
  host.run(() =>
    instance.run(() =>
      host.invokeDetached(async () => {
        await start.promise;
        host.invoke(() => {
          tail = trackAsyncWork(async () => {
            entered.resolve();
            await release.promise;
          });
        });
      }, mocked.error),
    ),
  );
  const close = host.close();
  const retirement = instance.dispose();
  start.resolve();
  await entered.promise;
  await setImmediate();
  expect(instance.hasRetainedConsumers).toBe(true);
  release.resolve();
  await tail;
  await close;
  expect(await retirement).toEqual({ errors: [] });
});
