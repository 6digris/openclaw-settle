import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionCatalogListProviderParams } from "../../plugins/session-catalog.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
  getGatewayRestartDrainSignal,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { GatewayConnectionWork } from "../server-connection-work.js";
import {
  catalogListCache,
  createSessionCatalogListLifetime,
  invalidateSessionCatalogLists,
  SessionCatalogListLifetime,
} from "./session-catalog-list-lifetime.js";
import type { CatalogRegistrationSnapshot } from "./session-catalog-provider-access.js";
import type { GatewayRequestContext } from "./types.js";

const host: SessionCatalogHost = {
  hostId: "node:late",
  kind: "node",
  label: "Late host",
  connected: true,
  sessions: [],
};
const catalog = {
  id: "fixture",
  label: "Fixture",
  capabilities: { continueSession: false, archive: false },
  hosts: [host],
};

function cacheFixture(config: OpenClawConfig = {}) {
  let currentConfig = config;
  const context = { getRuntimeConfig: () => currentConfig } as GatewayRequestContext;
  const registrations: CatalogRegistrationSnapshot = {
    registry: null,
    source: undefined,
    registrations: [],
    providers: [],
    shareRoutes: new Map(),
  };
  return {
    config,
    context,
    registrations,
    cache: catalogListCache(context, config, registrations),
    setConfig: (next: OpenClawConfig) => {
      currentConfig = next;
    },
  };
}

describe("catalog cache lifetime custody", () => {
  it.each([false, true])(
    "keeps active custody across config and registration replacement and provider failure=%s",
    async (fails) => {
      const before = getActiveGatewayRootWorkCount();
      const root = tryBeginGatewayRootWorkAdmission("catalog-cache-custody");
      expect(root).not.toBeNull();
      const { config, context, registrations, cache, setConfig } = cacheFixture();
      const lifetime = createSessionCatalogListLifetime(cache, () => true, []);
      const response = lifetime.joinFinalResponse(() => true)!;
      const late = createDeferredCore();
      const listing = root!.run(() =>
        lifetime.runProvider(undefined, async ({ waitUntil }) => {
          waitUntil(late.promise);
          if (fails) {
            throw new Error("provider failed");
          }
        }),
      );
      try {
        if (fails) {
          await expect(listing).rejects.toThrow("provider failed");
        } else {
          await listing;
        }
        root!.release();
        lifetime.finishListing();
        const nextRegistrations = { ...registrations };
        catalogListCache(context, config, nextRegistrations);
        const nextConfig = { ...config };
        setConfig(nextConfig);
        const updated = catalogListCache(context, nextConfig, nextRegistrations);
        expect(updated.active.has(lifetime)).toBe(true);
        expect(lifetime.invalidated).toBe(false);
        expect(() => response.assertCurrent()).not.toThrow();
        invalidateSessionCatalogLists(context);
        expect(() => response.assertCurrent()).not.toThrow();
        response.release();
        expect(updated.active.has(lifetime)).toBe(true);
        expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
        late.resolve();
        await late.promise;
        expect(updated.active.size).toBe(0);
        expect(getActiveGatewayRootWorkCount()).toBe(before);
        lifetime.finishListing();
        expect(updated.active.size).toBe(0);
      } finally {
        late.resolve();
        await Promise.allSettled([listing, late.promise]);
        response.release();
        lifetime.finishListing();
        root!.release();
      }
    },
  );

  it("preserves a new config generation's listing created by an archive abort callback", async () => {
    const { config, context, registrations, cache, setConfig } = cacheFixture();
    const original = createSessionCatalogListLifetime(cache, () => true, []);
    let replacement: SessionCatalogListLifetime | undefined;
    const finished = createDeferredCore();
    const result = Promise.resolve({ catalogs: [], instances: new Map() });
    cache.entries.set("original", { progress: original, result });
    const listing = original.runProvider(undefined, async ({ signal }) => {
      signal.addEventListener(
        "abort",
        () => {
          const nextConfig = { ...config };
          setConfig(nextConfig);
          const current = catalogListCache(context, nextConfig, registrations);
          replacement = createSessionCatalogListLifetime(current, () => true, []);
          current.entries.set("replacement", { progress: replacement, result });
          finished.resolve();
        },
        { once: true },
      );
      await finished.promise;
    });
    try {
      invalidateSessionCatalogLists(context);
      expect(cache.entries.has("original")).toBe(false);
      expect(cache.entries.has("replacement")).toBe(true);
      expect(replacement?.invalidated).toBe(false);
      await listing;
      original.finishListing();
      expect(cache.active.size).toBe(1);
      replacement!.finishListing();
      expect(cache.active.size).toBe(0);
    } finally {
      finished.resolve();
      await listing;
      original.finishListing();
      replacement?.finishListing();
    }
  });

  it("invalidates only the exact Gateway when two contexts share a config object", () => {
    const config = {};
    const first = cacheFixture(config);
    const second = cacheFixture(config);
    const original = createSessionCatalogListLifetime(first.cache, () => true, []);
    const other = createSessionCatalogListLifetime(second.cache, () => true, []);
    const originalResponse = original.joinFinalResponse(() => true)!;
    const otherResponse = other.joinFinalResponse(() => true)!;
    try {
      original.finishListing();
      other.finishListing();
      invalidateSessionCatalogLists(first.context);
      expect(original.invalidated).toBe(true);
      expect(other.invalidated).toBe(false);
      expect(() => otherResponse.assertCurrent()).not.toThrow();
      expect(second.cache.active.has(other)).toBe(true);
    } finally {
      originalResponse.release();
      otherResponse.release();
      original.finishListing();
      other.finishListing();
    }
  });
});

describe("catalog list completion ownership", () => {
  it("keeps admitted final responses current until the last caller finishes", async () => {
    const before = getActiveGatewayRootWorkHolders();
    const root = tryBeginGatewayRootWorkAdmission("catalog-final-followers");
    const lifetime = new SessionCatalogListLifetime(() => true, []);
    const leader = lifetime.joinFinalResponse(() => true)!;
    const follower = lifetime.joinFinalResponse(() => true)!;
    let retained: SessionCatalogListProviderParams | undefined;
    const publish = vi.fn();
    try {
      await root!.run(() =>
        lifetime.runProvider(publish, async (params) => {
          retained = params;
          params.onHost(host);
        }),
      );
      root!.release();
      leader.release();
      lifetime.finishListing();
      expect(retained?.signal?.aborted).toBe(false);
      expect(() => follower.assertCurrent()).not.toThrow();
      expect(lifetime.joinFinalResponse(() => true)).toBeUndefined();
      follower.release();
      expect(retained?.signal?.aborted).toBe(true);
      retained?.onHost?.(host);
      expect(publish).toHaveBeenCalledOnce();
      expect(lifetime.invalidated).toBe(false);
      expect(getActiveGatewayRootWorkHolders()).toEqual(before);
    } finally {
      leader.release();
      follower.release();
      lifetime.finishListing();
      root!.release();
    }
  });

  it("invalidates final execution immediately while keeping its settlement owned", async () => {
    const before = getActiveGatewayRootWorkCount();
    const root = tryBeginGatewayRootWorkAdmission("catalog-retired-final");
    const lifetime = new SessionCatalogListLifetime(() => true, []);
    const response = lifetime.joinFinalResponse(() => true)!;
    try {
      await root!.run(() => lifetime.runProvider(undefined, async () => []));
      root!.release();
      lifetime.finishListing();
      lifetime.retire();
      expect(() => response.assertCurrent()).toThrow(/no longer current/);
      expect(lifetime.invalidated).toBe(true);
      expect(lifetime.joinFinalResponse(() => true)).toBeUndefined();
      expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
      response.release();
      response.release();
      expect(getActiveGatewayRootWorkCount()).toBe(before);
    } finally {
      response.release();
      lifetime.finishListing();
      root!.release();
    }
  });

  it("rechecks each final caller without invalidating another caller's response", () => {
    const lifetime = new SessionCatalogListLifetime(() => true, []);
    let current = true;
    const revoked = lifetime.joinFinalResponse(() => current)!;
    const live = lifetime.joinFinalResponse(() => true)!;
    try {
      lifetime.finishListing();
      current = false;
      expect(() => revoked.assertCurrent()).toThrow(/no longer current/);
      revoked.release();
      expect(() => live.assertCurrent()).not.toThrow();
      expect(lifetime.invalidated).toBe(false);
    } finally {
      revoked.release();
      live.release();
      lifetime.finishListing();
    }
  });

  it("supersedes cached progress without revoking an admitted final response", async () => {
    const abort = new AbortController();
    const lifetime = new SessionCatalogListLifetime(() => true, [abort.signal]);
    const response = lifetime.joinFinalResponse(() => true)!;
    const publish = vi.fn();
    let retained: SessionCatalogListProviderParams | undefined;
    try {
      await lifetime.runProvider(publish, async (params) => {
        retained = params;
      });
      lifetime.invalidateResult();
      expect(retained?.signal?.aborted).toBe(true);
      expect(lifetime.invalidated).toBe(true);
      expect(lifetime.joinFinalResponse(() => true)).toBeUndefined();
      expect(() => response.assertCurrent()).not.toThrow();
      expect(() => lifetime.assertPublicationCurrent()).toThrow(/superseded/);
      retained?.onHost?.(host);
      expect(publish).not.toHaveBeenCalled();
      abort.abort();
      expect(() => response.assertCurrent()).toThrow(/no longer current/);
    } finally {
      response.release();
      lifetime.finishListing();
    }
  });

  it("keeps work started before retirement owned when registration follows an await", async () => {
    const before = getActiveGatewayRootWorkCount();
    const root = tryBeginGatewayRootWorkAdmission("catalog-register-after-retirement");
    expect(root).not.toBeNull();
    const lifetime = new SessionCatalogListLifetime(() => true, []);
    const releaseListing = createDeferredCore();
    const releaseWork = createDeferredCore();
    const publish = vi.fn();
    let publication: Promise<void> | undefined;
    let signal: AbortSignal | undefined;
    const listing = root!.run(() =>
      lifetime.runProvider(publish, async (params) => {
        signal = params.signal;
        publication = releaseWork.promise.then(() => params.onHost(host));
        await releaseListing.promise;
        params.waitUntil(publication);
      }),
    );
    try {
      lifetime.retire();
      releaseListing.resolve();
      await expect(listing).resolves.toBeUndefined();
      root!.release();
      lifetime.finishListing();
      expect(signal?.aborted).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
      releaseWork.resolve();
      await publication;
      expect(publish).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(before);
    } finally {
      releaseListing.resolve();
      releaseWork.resolve();
      await Promise.allSettled([listing, publication]);
      lifetime.finishListing();
      root!.release();
    }
  });

  it.each([false, true])(
    "closes zero-background callbacks, registration, and root ownership (throws=%s)",
    async (throws) => {
      const before = getActiveGatewayRootWorkHolders();
      const root = tryBeginGatewayRootWorkAdmission("catalog-zero-background");
      expect(root).not.toBeNull();
      const lifetime = new SessionCatalogListLifetime(() => true, []);
      const publish = vi.fn();
      let retained: SessionCatalogListProviderParams | undefined;
      try {
        const listing = root!.run(() =>
          lifetime.runProvider(publish, async (params) => {
            retained = params;
            params.onHost(host);
            if (throws) {
              throw new Error("catalog list failed");
            }
            return [];
          }),
        );
        if (throws) {
          await expect(listing).rejects.toThrow("catalog list failed");
        } else {
          await expect(listing).resolves.toEqual([]);
        }
        root!.release();
        lifetime.finishListing();
        retained?.onHost?.(host);
        expect(publish).toHaveBeenCalledOnce();
        expect(() => retained?.waitUntil?.(Promise.resolve())).toThrow(/registration is closed/);
        expect(retained?.signal?.aborted).toBe(true);
        expect(getActiveGatewayRootWorkHolders()).toEqual(before);
      } finally {
        lifetime.finishListing();
        root!.release();
      }
    },
  );

  it("keeps completion on its admitted owner when an external callback registers it", async () => {
    const before = getActiveGatewayRootWorkHolders();
    const ownerOrigin = "catalog-original-owner";
    const foreignOrigin = "catalog-foreign-callback";
    const root = tryBeginGatewayRootWorkAdmission(ownerOrigin);
    const foreignRoot = tryBeginGatewayRootWorkAdmission(foreignOrigin);
    expect(root).not.toBeNull();
    expect(foreignRoot).not.toBeNull();
    const owner = new GatewayConnectionWork();
    const foreign = new GatewayConnectionWork();
    const lifetime = new SessionCatalogListLifetime(() => true, [owner.signal]);
    lifetime.subscribe(
      "active",
      () => undefined,
      () => true,
    );
    const callback = new EventEmitter();
    const registered = createDeferredCore();
    const release = createDeferredCore();
    const publish = vi.fn();
    let publication: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    let ownerDrained = false;
    let foreignDrained = false;
    let rootsAtOwnerDrain: string[] | undefined;
    const listing = owner.track(() =>
      root!.run(() =>
        lifetime.runProvider(publish, async (params) => {
          publication = release.promise.then(() => params.onHost(host));
          // EventEmitter invokes the callback in the emitter's current context.
          callback.once("register", () => {
            params.waitUntil(publication!);
            registered.resolve();
          });
          await registered.promise;
        }),
      ),
    );
    try {
      await foreign.track(() => foreignRoot!.run(async () => callback.emit("register")));
      foreignRoot!.release();
      await listing;
      root!.release();
      lifetime.finishListing();
      const retained = getActiveGatewayRootWorkHolders();
      closing = Promise.all([
        owner.drain().then(() => {
          rootsAtOwnerDrain = getActiveGatewayRootWorkHolders();
          ownerDrained = true;
        }),
        foreign.drain().then(() => {
          foreignDrained = true;
        }),
      ]).then(() => undefined);
      await nextTurn();
      const whileHeld = { ownerDrained, foreignDrained };
      release.resolve();
      await publication;
      await closing;
      expect(whileHeld).toEqual({ ownerDrained: false, foreignDrained: true });
      expect(retained).toEqual([...before, ownerOrigin].toSorted((a, b) => a.localeCompare(b)));
      expect(rootsAtOwnerDrain).toEqual(before);
      expect(getActiveGatewayRootWorkHolders()).toEqual(before);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      registered.resolve();
      release.resolve();
      await Promise.allSettled([listing, publication, closing]);
      lifetime.finishListing();
      root!.release();
      foreignRoot!.release();
      callback.removeAllListeners();
      await Promise.all([owner.drain(), foreign.drain()]);
    }
  });

  it.each([false, true])(
    "retains the admitted root through the full publication chain (throws=%s)",
    async (throws) => {
      const before = getActiveGatewayRootWorkCount();
      const root = tryBeginGatewayRootWorkAdmission("catalog-test");
      expect(root).not.toBeNull();
      const lifetime = new SessionCatalogListLifetime(() => true, []);
      lifetime.subscribe(
        "active",
        () => undefined,
        () => true,
      );
      const release = createDeferredCore();
      let publication: Promise<void> | undefined;
      let retained: SessionCatalogListProviderParams | undefined;
      const publish = vi.fn(() => {
        expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
        if (throws) {
          throw new Error("publication failed");
        }
      });
      try {
        await root!.run(() =>
          lifetime.runProvider(publish, async (params) => {
            retained = params;
            publication = release.promise.then(() => params.onHost(host));
            params.waitUntil(publication);
            return [];
          }),
        );
        root!.release();
        lifetime.finishListing();
        expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
        expect(retained?.signal?.aborted).toBe(false);
        release.resolve();
        await publication?.catch(() => undefined);
        expect(publish).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(before);
        retained?.onHost?.(host);
        expect(publish).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await publication?.catch(() => undefined);
        lifetime.finishListing();
        root!.release();
      }
    },
  );

  it("disconnects subscribers without cancelling the native discovery", async () => {
    const lifetime = new SessionCatalogListLifetime(() => true, []);
    const connection = new AbortController();
    const disconnected = vi.fn();
    const live = vi.fn();
    lifetime.subscribe("old", disconnected, () => true, connection.signal);
    lifetime.subscribe("live", live, () => true);
    const release = createDeferredCore();
    let publication: Promise<void> | undefined;
    let producerSignal: AbortSignal | undefined;
    try {
      await lifetime.runProvider(
        () => lifetime.publish(catalog, new Map()),
        async (params) => {
          producerSignal = params.signal;
          publication = release.promise.then(() => params.onHost(host));
          params.waitUntil(publication);
        },
      );
      lifetime.finishListing();
      connection.abort();
      expect(producerSignal?.aborted).toBe(false);
      release.resolve();
      await publication;
      expect(disconnected).not.toHaveBeenCalled();
      expect(live).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await publication;
      lifetime.finishListing();
    }
  });

  it("joins native completion when the Gateway starts draining", async () => {
    const root = tryBeginGatewayRootWorkAdmission("catalog-drain-test");
    expect(root).not.toBeNull();
    const lifetime = new SessionCatalogListLifetime(() => true, [getGatewayRestartDrainSignal()]);
    lifetime.subscribe(
      "active",
      () => undefined,
      () => true,
    );
    const publish = vi.fn();
    let publication: Promise<void> | undefined;
    try {
      await root!.run(() =>
        lifetime.runProvider(publish, async (params) => {
          publication = new Promise<void>((resolve) => {
            params.signal.addEventListener("abort", () => resolve(), { once: true });
          }).then(() => params.onHost(host));
          params.waitUntil(publication);
        }),
      );
      root!.release();
      lifetime.finishListing();
      expect(getActiveGatewayRootWorkCount()).toBe(1);
      markGatewayRestartDraining();
      expect(tryBeginGatewayRootWorkAdmission("after-drain")).toBeNull();
      await publication;
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(publish).not.toHaveBeenCalled();
    } finally {
      lifetime.retire();
      await publication;
      lifetime.finishListing();
      root!.release();
      resetGatewayWorkAdmission();
    }
  });

  it("releases the final subscriber's publisher while keeping native completion owned", async () => {
    const before = getActiveGatewayRootWorkCount();
    const root = tryBeginGatewayRootWorkAdmission("catalog-last-subscriber");
    expect(root).not.toBeNull();
    const lifetime = new SessionCatalogListLifetime(() => true, []);
    const connection = new AbortController();
    const listener = vi.fn();
    lifetime.subscribe("only", listener, () => true, connection.signal);
    const publishSnapshot = vi.fn(() => lifetime.publish(catalog, new Map()));
    const release = createDeferredCore();
    let publication: Promise<void> | undefined;
    let signal: AbortSignal | undefined;
    try {
      await root!.run(() =>
        lifetime.runProvider(publishSnapshot, async (params) => {
          signal = params.signal;
          publication = release.promise.then(() => params.onHost(host));
          params.waitUntil(publication);
        }),
      );
      root!.release();
      lifetime.finishListing();
      connection.abort();
      expect(signal?.aborted).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
      release.resolve();
      await publication;
      expect(publishSnapshot).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(getActiveGatewayRootWorkCount()).toBe(before);
    } finally {
      release.resolve();
      await publication;
      lifetime.finishListing();
      root!.release();
    }
  });

  it.each(["signal", "aggregate-failure", "provider-failure"] as const)(
    "retires delivery on %s without declaring an ignoring producer finished",
    async (retirement) => {
      const before = getActiveGatewayRootWorkCount();
      const root = tryBeginGatewayRootWorkAdmission("catalog-retirement-test");
      expect(root).not.toBeNull();
      const controller = new AbortController();
      const lifetime = new SessionCatalogListLifetime(() => true, [controller.signal]);
      lifetime.subscribe(
        "active",
        () => undefined,
        () => true,
      );
      const publish = vi.fn();
      const release = createDeferredCore();
      let publication: Promise<void> | undefined;
      let signal: AbortSignal | undefined;
      try {
        const listing = root!.run(() =>
          lifetime.runProvider(publish, async (params) => {
            signal = params.signal;
            publication = release.promise.then(() => params.onHost(host));
            params.waitUntil(publication);
            if (retirement === "provider-failure") {
              throw new Error("provider failed");
            }
          }),
        );
        if (retirement === "provider-failure") {
          await expect(listing).rejects.toThrow("provider failed");
        } else {
          await listing;
        }
        root!.release();
        lifetime.finishListing();
        if (retirement === "signal") {
          controller.abort();
        } else if (retirement === "aggregate-failure") {
          lifetime.retire(new Error("response failed"));
        }
        expect(signal?.aborted).toBe(true);
        expect(getActiveGatewayRootWorkCount()).toBe(before + 1);
        release.resolve();
        await publication;
        expect(publish).not.toHaveBeenCalled();
        expect(getActiveGatewayRootWorkCount()).toBe(before);
      } finally {
        release.resolve();
        await publication;
        lifetime.finishListing();
        root!.release();
      }
    },
  );
});
