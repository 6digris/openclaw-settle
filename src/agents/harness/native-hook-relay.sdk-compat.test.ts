import path from "node:path";
import { nativeHookRelayTesting } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as store from "./native-hook-relay-store.js";
import { registerOwnedNativeHookRelay, testing } from "./native-hook-relay.js";

async function withRelayState(operation: () => Promise<void>): Promise<void> {
  await withOpenClawTestState({ label: "native-hook-sdk-compat" }, async () => {
    try {
      await operation();
    } finally {
      vi.restoreAllMocks();
      await testing.clearNativeHookRelaysForTests();
    }
  });
}

function register(relayId: string) {
  return registerOwnedNativeHookRelay({
    provider: "codex",
    relayId,
    sessionId: "sdk-compat-session",
    runId: "sdk-compat-run",
  });
}

describe("published native hook testing contract", () => {
  it("returns the persisted record synchronously through the public SDK", async () => {
    await withRelayState(async () => {
      const relay = register("sdk-record");
      await relay.ready;
      const record: Record<string, unknown> | undefined =
        nativeHookRelayTesting.getNativeHookRelayBridgeRecordForTests(relay.relayId);
      expect(record).toMatchObject({ relayId: relay.relayId, pid: process.pid });
      expect(record).not.toHaveProperty("then");
      expect(record).toEqual(
        await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId }),
      );
    });
  });

  it("returns undefined immediately for a missing record", async () => {
    await withRelayState(async () => {
      expect(
        nativeHookRelayTesting.getNativeHookRelayBridgeRecordForTests("missing-sdk-record"),
      ).toBeUndefined();
    });
  });

  it("clears published records and logical ownership before its void return", async () => {
    await withRelayState(async () => {
      const relay = register("sdk-clear");
      await relay.ready;
      const result: void = nativeHookRelayTesting.clearNativeHookRelaysForTests();
      expect(result).toBeUndefined();
      expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
      expect(
        await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId }),
      ).toBeUndefined();
      await relay.drain();
    });
  });

  it("clears owned records from another state location before returning", async () => {
    await withRelayState(async () => {
      const originalPath = resolveOpenClawStateSqlitePath();
      const alternateStateDir = path.join(path.dirname(originalPath), "alternate-state");
      const { relay, alternatePath } = await withEnvAsync(
        { OPENCLAW_STATE_DIR: alternateStateDir },
        async () => {
          const stateDbPath = resolveOpenClawStateSqlitePath();
          expect(stateDbPath).not.toBe(originalPath);
          const registered = register("sdk-other-state");
          await registered.ready;
          return { relay: registered, alternatePath: stateDbPath };
        },
      );
      const cleanup = Promise.resolve(nativeHookRelayTesting.clearNativeHookRelaysForTests());
      try {
        expect(
          await store.readNativeHookRelayBridgeRecord({
            relayId: relay.relayId,
            stateDbPath: alternatePath,
          }),
        ).toBeUndefined();
      } finally {
        await cleanup;
        await relay.drain();
      }
    });
  });

  it("reports a synchronous cleanup failure instead of a successful reset", async () => {
    await withRelayState(async () => {
      const alternateStateDir = path.join(
        path.dirname(resolveOpenClawStateSqlitePath()),
        "failed-reset",
      );
      const relay = await withEnvAsync({ OPENCLAW_STATE_DIR: alternateStateDir }, async () => {
        const registered = register("sdk-failed-reset");
        await registered.ready;
        return registered;
      });
      const failure = new Error("fixture state transaction refused");
      const remove = vi
        .spyOn(store, "deleteNativeHookRelayBridgeRecordSynchronouslyIfOwned")
        .mockImplementationOnce(() => {
          throw failure;
        });
      try {
        expect(() => nativeHookRelayTesting.clearNativeHookRelaysForTests()).toThrow(failure);
        expect(testing.getNativeHookRelayRegistrationForTests(relay.relayId)).toBeUndefined();
      } finally {
        remove.mockRestore();
        await relay.drain();
      }
    });
  });

  it.each(["publication", "renewal"] as const)(
    "keeps a successor when pre-clear %s finishes later",
    async (stage) => {
      await withRelayState(async () => {
        const entered = createDeferredCore();
        const resume = createDeferredCore();
        const first = stage === "renewal" ? register("sdk-successor") : undefined;
        if (first) {
          await first.ready;
        }
        if (stage === "publication") {
          const write = store.writeNativeHookRelayBridgeRecord;
          vi.spyOn(store, "writeNativeHookRelayBridgeRecord").mockImplementationOnce(
            async (params) => {
              entered.resolve();
              await resume.promise;
              return write(params);
            },
          );
        } else {
          const renew = store.renewOrRestoreNativeHookRelayBridgeRecord;
          vi.spyOn(store, "renewOrRestoreNativeHookRelayBridgeRecord").mockImplementationOnce(
            async (params) => {
              entered.resolve();
              await resume.promise;
              return renew(params);
            },
          );
        }
        const retired = first ?? register("sdk-successor");
        const ready = retired.ready.catch((error: unknown) => error);
        if (stage === "renewal") {
          retired.renew(60_000);
        }
        try {
          await entered.promise;
          const legacyCleanup = Promise.resolve(
            nativeHookRelayTesting.clearNativeHookRelaysForTests(),
          );
          const successor = register("sdk-successor");
          await successor.ready;
          const expected = await store.readNativeHookRelayBridgeRecord({
            relayId: successor.relayId,
          });
          expect(expected).toBeDefined();
          resume.resolve();
          await retired.drain();
          await ready;
          await legacyCleanup;
          expect(
            await store.readNativeHookRelayBridgeRecord({ relayId: successor.relayId }),
          ).toEqual(expected);
          expect(testing.getNativeHookRelayRegistrationForTests(successor.relayId)).toBeDefined();
          successor.unregister();
          await successor.drain();
        } finally {
          resume.resolve();
          await ready;
        }
      });
    },
  );

  it("retains the awaited internal cleanup barrier while publication is pending", async () => {
    await withRelayState(async () => {
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      const write = store.writeNativeHookRelayBridgeRecord;
      vi.spyOn(store, "writeNativeHookRelayBridgeRecord").mockImplementationOnce(async (params) => {
        entered.resolve();
        await resume.promise;
        return write(params);
      });
      const relay = register("sdk-internal-drain");
      const ready = relay.ready.catch((error: unknown) => error);
      try {
        await entered.promise;
        let settled = false;
        const cleanup = testing.clearNativeHookRelaysForTests().then(() => {
          settled = true;
        });
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(settled).toBe(false);
        resume.resolve();
        await cleanup;
        await ready;
        expect(settled).toBe(true);
        expect(
          await store.readNativeHookRelayBridgeRecord({ relayId: relay.relayId }),
        ).toBeUndefined();
      } finally {
        resume.resolve();
        await ready;
      }
    });
  });
});
