import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionCatalogHost,
  SessionsCatalogListResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { GatewayRequestEntryLifetime } from "../server-request-entry.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import {
  hoisted,
  markPluginRegistryActive,
  provider,
  resetSessionCatalogTestState,
  sessionCatalogHandlers,
  type PluginRegistry,
  type SessionCatalogProvider,
} from "./session-catalog.test-helpers.js";

const { listSessionCatalogProvider } = await import("./session-catalog-provider-access.js");

describe("catalog list step owner", () => {
  beforeEach(resetSessionCatalogTestState);

  it("settles admitted callers with only errors after a mixed enumeration retires", async () => {
    const lateStarted = createDeferredCore();
    const releaseLate = createDeferredCore();
    const entryOwner = new GatewayRequestEntryLifetime();
    const host: SessionCatalogHost = {
      hostId: "gateway:retired",
      label: "Retired",
      kind: "gateway",
      connected: true,
      sessions: [
        {
          threadId: "retired-thread",
          status: "idle",
          archived: false,
          canContinue: false,
          canArchive: false,
        },
      ],
    };
    let lateSignal: AbortSignal | undefined;
    const ready = vi.fn<SessionCatalogProvider["list"]>(async ({ onHost }) => {
      onHost?.(host);
      return [host];
    });
    const late = vi.fn<SessionCatalogProvider["list"]>(async (params) => {
      lateSignal = params.signal;
      lateStarted.resolve();
      await releaseLate.promise;
      params.onHost?.(host);
      return [host];
    });
    const specificError = new Error("specific catalog failure");
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("ready", { audience: "session-viewers", list: ready }) },
      { provider: provider("late", { audience: "session-viewers", list: late }) },
      {
        provider: provider("failed", {
          audience: "session-viewers",
          list: async () => {
            throw specificError;
          },
        }),
      },
    ];
    const config = {};
    const broadcastToConnIds = vi.fn();
    const context = {
      getRuntimeConfig: () => config,
      requestEntryLifetime: entryOwner,
      broadcastToConnIds,
    };
    const handler = vi.fn(sessionCatalogHandlers["sessions.catalog.list"]!);
    const harness = createDispatchTestHarness({
      extraHandlers: { "sessions.catalog.list": handler },
      buildRequestContext: () => context,
    });
    const client = createOperatorWsClient();
    const dispatch = (id: string) =>
      harness.dispatcher.dispatch(
        { type: "req", id, method: "sessions.catalog.list", params: { progressId: id } },
        client,
      );
    const leader = dispatch("leader");
    let follower: Promise<void> | undefined;
    try {
      await Promise.race([lateStarted.promise, leader]);
      expect(late).toHaveBeenCalledOnce();
      follower = dispatch("follower");
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
      expect(ready).toHaveBeenCalledOnce();
      expect(late).toHaveBeenCalledOnce();
      expect(broadcastToConnIds).toHaveBeenCalled();
      const progressCount = broadcastToConnIds.mock.calls.length;
      markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
      expect(lateSignal?.aborted).toBe(true);
      expect(entryOwner.signal.aborted).toBe(false);
      releaseLate.resolve();
      await Promise.all([leader, follower]);
      for (const id of ["leader", "follower"]) {
        const response = await harness.awaitResponseFrame(id);
        expect(response.ok).toBe(true);
        const result = response.payload as SessionsCatalogListResult;
        expect(result.catalogs.map((catalog) => catalog.id)).toEqual(["failed", "late", "ready"]);
        expect(result.catalogs.every((catalog) => catalog.hosts.length === 0)).toBe(true);
        expect(result.catalogs.every((catalog) => catalog.error?.message)).toBe(true);
        expect(result.catalogs.find((catalog) => catalog.id === "failed")?.error?.message).toBe(
          specificError.message,
        );
      }
      expect(harness.send).toHaveBeenCalledTimes(2);
      expect(broadcastToConnIds).toHaveBeenCalledTimes(progressCount);
      expect(hoisted.listSessionEntriesReadOnly).not.toHaveBeenCalled();
    } finally {
      releaseLate.resolve();
      await Promise.allSettled([leader, follower]);
      entryOwner.beginClose();
      await entryOwner.sealAndJoin();
    }
  });

  it.each(["gateway context", "catalog source", "registry epoch", "disconnect"] as const)(
    "preserves the list owner boundary across %s before resuming source work",
    async (change) => {
      const blockers = createDeferredCore<SessionCatalogHost[]>();
      const first = createDeferredCore<{ done: false }>();
      const sourceStarted = createDeferredCore();
      const healthyStarted = createDeferredCore();
      const healthyGate = createDeferredCore<SessionCatalogHost[]>();
      const entryOwner = new GatewayRequestEntryLifetime();
      const connection = new AbortController();
      const instance = new PluginInstance("source");
      const sourceRead = vi.fn();
      const close = vi.fn();
      let sourceSignal: AbortSignal | undefined;
      let currentContext = true;
      const config = {};
      const context: Record<string, unknown> = {
        getRuntimeConfig: () => config,
        requestEntryLifetime: entryOwner,
        broadcastToConnIds: vi.fn(),
      };
      context.resolveGatewayContext = () => (currentContext ? context : undefined);
      const catalog = instance.wrap(
        provider("source", {
          audience: "session-viewers",
          createListOperation: (params) => {
            sourceSignal = params.signal;
            return {
              async next() {
                sourceRead();
                sourceStarted.resolve();
                return sourceRead.mock.calls.length === 1
                  ? await first.promise
                  : { done: true, hosts: [] };
              },
              close,
            };
          },
        }),
      );
      hoisted.activeRegistry.sessionCatalogs = [{ provider: catalog }];
      const blocker = provider("blocking", { list: () => blockers.promise });
      const active = Array.from({ length: 3 }, () => listSessionCatalogProvider(blocker, {}));
      const client = createOperatorWsClient({ connId: "fixture" });
      client.connectionSignal = connection.signal;
      const harness = createDispatchTestHarness({
        extraHandlers: sessionCatalogHandlers,
        buildRequestContext: () => context,
      });
      context.logGateway = harness.logGateway;
      const pending = harness.dispatcher.dispatch(
        {
          type: "req",
          id: "owner-proof",
          method: "sessions.catalog.list",
          params: { catalogId: "source", progressId: "owner-proof" },
        },
        client,
      );
      let healthy: Promise<SessionCatalogHost[]> | undefined;
      try {
        await Promise.race([sourceStarted.promise, pending]);
        expect(sourceRead.mock.calls, JSON.stringify(harness.send.mock.calls)).toHaveLength(1);
        healthy = listSessionCatalogProvider(
          provider("healthy", {
            list: () => {
              healthyStarted.resolve();
              return healthyGate.promise;
            },
          }),
          {},
        );
        first.resolve({ done: false });
        await healthyStarted.promise;
        expect(sourceRead.mock.calls, JSON.stringify(harness.send.mock.calls)).toHaveLength(1);
        expect(sourceSignal?.aborted).toBe(false);
        expect(instance.acceptingCalls).toBe(true);
        if (change === "gateway context") {
          currentContext = false;
        } else if (change === "catalog source") {
          hoisted.activeRegistry.sessionCatalogs = [...hoisted.activeRegistry.sessionCatalogs];
        } else if (change === "registry epoch") {
          markPluginRegistryActive(hoisted.activeRegistry as PluginRegistry);
        } else {
          connection.abort();
        }
        expect(entryOwner.signal.aborted).toBe(false);
        expect(sourceSignal?.aborted).toBe(change === "registry epoch");
        expect(instance.acceptingCalls).toBe(true);
        healthyGate.resolve([]);
        await pending;
        expect(sourceRead).toHaveBeenCalledTimes(change === "disconnect" ? 2 : 1);
        expect(close).toHaveBeenCalledOnce();
        const response = await harness.awaitResponseFrame("owner-proof");
        expect(response.ok).toBe(true);
        expect(harness.send).toHaveBeenCalledOnce();
        const result = (response.payload as SessionsCatalogListResult).catalogs[0]!;
        expect(result.hosts).toEqual([]);
        if (change === "disconnect") {
          expect(result.error).toBeUndefined();
        } else {
          expect(result.error).toMatchObject({ message: expect.any(String) });
        }
      } finally {
        first.resolve({ done: false });
        blockers.resolve([]);
        healthyGate.resolve([]);
        await Promise.allSettled([...active, pending, healthy]);
        await instance.dispose();
        entryOwner.beginClose();
        await entryOwner.sealAndJoin();
      }
    },
  );
});
