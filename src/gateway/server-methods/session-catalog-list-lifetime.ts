import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionsCatalogListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  retainSessionEntryListReads,
  type SessionEntryListReadRetention,
} from "../../config/sessions/session-accessor.sqlite-list-read-retention.js";
import type { SessionEntryListScope } from "../../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAbortError } from "../../infra/abort-signal.js";
import type { SessionCatalogListProviderParams } from "../../plugins/session-catalog.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import { captureAsyncWorkTracker } from "../../shared/async-work-scope.js";
import type { SessionCatalogInstances } from "./session-catalog-entry-snapshot.js";
import type { CatalogRegistrationSnapshot } from "./session-catalog-provider-access.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export type CatalogListResult = { catalogs: SessionCatalog[] };
export type CatalogListEnumeration = CatalogListResult & { instances: SessionCatalogInstances };
export type CatalogListCacheEntry = {
  expiresAt?: number;
  progress: SessionCatalogListLifetime;
  result: Promise<CatalogListEnumeration>;
};

type CatalogListCacheState = {
  config: OpenClawConfig;
  registrations: CatalogRegistrationSnapshot;
  entries: Map<string, CatalogListCacheEntry>;
  active: Set<SessionCatalogListLifetime>;
};

const catalogListsByContext = new WeakMap<GatewayRequestContext, CatalogListCacheState>();

export function catalogListCache(
  context: GatewayRequestContext,
  config: OpenClawConfig,
  registrations: CatalogRegistrationSnapshot,
): CatalogListCacheState {
  let state = catalogListsByContext.get(context);
  if (!state) {
    state = { config, registrations, entries: new Map(), active: new Set() };
    catalogListsByContext.set(context, state);
  } else if (state.config !== config || state.registrations !== registrations) {
    state.config = config;
    state.registrations = registrations;
    state.entries.clear();
    state.entries = new Map();
  }
  return state;
}

export function createSessionCatalogListLifetime(
  cache: CatalogListCacheState,
  isCurrent: () => boolean,
  signals: readonly AbortSignal[],
): SessionCatalogListLifetime {
  const lifetime = new SessionCatalogListLifetime(isCurrent, signals, (finished) => {
    cache.active.delete(finished);
  });
  cache.active.add(lifetime);
  return lifetime;
}

export function invalidateSessionCatalogLists(context: GatewayRequestContext): void {
  const cache = catalogListsByContext.get(context);
  if (!cache) {
    return;
  }
  // Abort callbacks can start new listings; only pre-archive work is superseded.
  const active = [...cache.active];
  cache.entries.clear();
  for (const lifetime of active) {
    lifetime.invalidateResult();
  }
}

export type CatalogListProgressSubscriber = (
  catalog: SessionCatalog,
  instances: SessionCatalogInstances,
) => void;

export type CatalogFinalResponsePermit = {
  assertCurrent: () => void;
  release: () => void;
};

const catalogCallerIds = new WeakMap<GatewayClient, number>();
let nextCatalogCallerId = 0;

export function sessionCatalogListKey(params: {
  agentId: string;
  client: GatewayClient | null;
  request: SessionsCatalogListParams;
  search?: string;
  allowProcessHomeFallback: boolean;
  visibilityKey: string;
}): string {
  // Providers inherit this exact caller through Gateway async scope, including node APIs.
  // A matching profile alone cannot make another connection's enumeration reusable.
  let callerId = params.client ? catalogCallerIds.get(params.client) : 0;
  if (params.client && callerId === undefined) {
    callerId = ++nextCatalogCallerId;
    catalogCallerIds.set(params.client, callerId);
  }
  const cursors = params.request.cursors
    ? Object.entries(params.request.cursors).toSorted(([left], [right]) =>
        left.localeCompare(right),
      )
    : null;
  return JSON.stringify([
    params.agentId,
    params.request.catalogId ?? null,
    params.search ?? null,
    params.request.limitPerHost ?? null,
    params.request.hostIds ?? null,
    cursors,
    params.allowProcessHomeFallback,
    params.visibilityKey,
    callerId,
    params.client?.connect?.scopes?.toSorted() ?? [],
    params.client?.connect?.role ?? null,
    params.client?.connect?.device?.id ?? null,
  ]);
}

/** The aggregate response can finish before the native host publications it owns. */
export class SessionCatalogListLifetime {
  private readonly controller = new AbortController();
  private readonly subscribers = new Map<
    string,
    { publish: CatalogListProgressSubscriber; remove: () => void; isCurrent: () => boolean }
  >();
  private readonly publishers = new Set<() => void>();
  private readonly removeAbortListeners: Array<() => void> = [];
  private entryRead: SessionEntryListReadRetention | undefined;
  private isCurrent: (() => boolean) | undefined;
  private state: "active" | "completed" | "invalidated" = "active";
  private resultInvalidated = false;
  private listing = true;
  private pending = 0;
  private finalResponses = 0;
  private syncReads = 0;
  private releaseRoot: (() => void) | undefined;
  private onFinished: ((lifetime: SessionCatalogListLifetime) => void) | undefined;

  constructor(
    isCurrent: () => boolean,
    signals: readonly AbortSignal[],
    onFinished?: (lifetime: SessionCatalogListLifetime) => void,
  ) {
    this.isCurrent = isCurrent;
    this.onFinished = onFinished;
    for (const signal of signals) {
      if (signal.aborted) {
        this.retire(signal.reason);
        break;
      }
      const retire = () => this.retire(signal.reason);
      signal.addEventListener("abort", retire, { once: true });
      this.removeAbortListeners.push(() => signal.removeEventListener("abort", retire));
    }
  }

  private active(): boolean {
    if (this.state !== "active") {
      return false;
    }
    try {
      if (this.isCurrent?.() && this.state === "active") {
        return true;
      }
    } catch {
      // A lost context is retirement, never permission to use a successor.
    }
    this.retire();
    return false;
  }

  get invalidated(): boolean {
    return this.resultInvalidated;
  }

  assertCurrent(): void {
    if (!this.active()) {
      throw createAbortError("Session catalog listing is no longer current");
    }
  }

  assertPublicationCurrent(): void {
    this.assertCurrent();
    if (this.resultInvalidated) {
      throw createAbortError("Session catalog publication was superseded");
    }
  }

  joinFinalResponse(isCallerCurrent: () => boolean): CatalogFinalResponsePermit | undefined {
    if (
      this.resultInvalidated ||
      !this.listing ||
      !this.active() ||
      !isCallerCurrent() ||
      this.state !== "active"
    ) {
      return undefined;
    }
    let released = false;
    this.finalResponses += 1;
    return {
      assertCurrent: () => {
        this.assertCurrent();
        if (released || !isCallerCurrent() || this.state !== "active") {
          throw createAbortError("Session catalog response is no longer current");
        }
      },
      release: () => {
        if (!released) {
          released = true;
          this.finalResponses -= 1;
          if (this.resultInvalidated && this.finalResponses === 0) {
            this.releaseEntryReads();
          }
          this.finish();
        }
      },
    };
  }

  readonly listEntries = (scope: SessionEntryListScope = {}) => {
    this.assertCurrent();
    this.syncReads += 1;
    try {
      this.entryRead ??= retainSessionEntryListReads({
        onRevoked: (reason) => this.retire(reason),
      });
      const entries = this.entryRead.list(scope);
      this.assertCurrent();
      return entries;
    } finally {
      this.syncReads -= 1;
      if (this.state !== "active" || (this.resultInvalidated && this.finalResponses === 0)) {
        this.releaseEntryReads();
      }
      this.finish();
    }
  };

  subscribe(
    key: string,
    publish: CatalogListProgressSubscriber,
    isCurrent: () => boolean,
    signal?: AbortSignal,
  ): void {
    this.subscribers.get(key)?.remove();
    if (this.resultInvalidated || !this.active() || signal?.aborted || !isCurrent()) {
      return;
    }
    const remove = () => {
      signal?.removeEventListener("abort", remove);
      this.subscribers.delete(key);
      this.releaseUnusedPublishers();
    };
    this.subscribers.set(key, { publish, remove, isCurrent });
    signal?.addEventListener("abort", remove, { once: true });
  }

  publish(catalog: SessionCatalog, instances: SessionCatalogInstances): void {
    if (this.resultInvalidated || !this.active()) {
      return;
    }
    for (const subscriber of this.subscribers.values()) {
      if (subscriber.isCurrent()) {
        subscriber.publish(catalog, instances);
      } else {
        subscriber.remove();
      }
    }
  }

  async runProvider<T>(
    onHost: ((host: SessionCatalogHost) => void) | undefined,
    run: (
      params: Required<Pick<SessionCatalogListProviderParams, "onHost" | "waitUntil" | "signal">>,
    ) => Promise<T>,
  ): Promise<T> {
    const trackWork = captureAsyncWorkTracker();
    let publish = onHost;
    const controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, controller.signal]);
    let listing = true;
    let pending = 0;
    const releasePublisher = () => {
      publish = undefined;
      this.publishers.delete(releasePublisher);
    };
    this.publishers.add(releasePublisher);
    const settle = () => {
      pending -= 1;
      this.pending -= 1;
      if (!listing && pending === 0) {
        releasePublisher();
      }
      this.finish();
    };
    try {
      signal.throwIfAborted();
      // Completion callbacks can arrive from a different async context; both owners
      // belong to this listing, and finishListing releases zero-background lists.
      this.releaseRoot ??= retainGatewayRootWorkAdmissionContinuation() ?? undefined;
      return await run({
        signal,
        onHost: (host) => {
          if (!this.resultInvalidated && this.active()) {
            publish?.(host);
          }
        },
        waitUntil: (completion) => {
          if (!listing) {
            throw new Error("Session catalog completion registration is closed");
          }
          // Retirement closes delivery, not accounting for work already started.
          // Join the publication finalizer before the Gateway releases its dependencies.
          pending += 1;
          this.pending += 1;
          void trackWork(() => completion.then(settle, settle));
        },
      });
    } catch (error) {
      releasePublisher();
      controller.abort(error);
      throw error;
    } finally {
      listing = false;
      if (pending === 0) {
        releasePublisher();
      }
    }
  }

  finishListing(): void {
    this.listing = false;
    this.releaseUnusedPublishers();
    this.finish();
  }

  private releaseUnusedPublishers(): void {
    // Active lists can gain followers; settled lists cannot. Retirement clears every capture.
    if (
      !this.resultInvalidated &&
      this.state === "active" &&
      this.isCurrent &&
      (this.listing || this.subscribers.size > 0)
    ) {
      return;
    }
    for (const release of this.publishers) {
      release();
    }
  }

  private finish(): void {
    if (this.listing || this.pending > 0 || this.finalResponses > 0 || this.syncReads > 0) {
      return;
    }
    if (this.state === "active") {
      this.state = "completed";
      this.closeAuthority();
    }
    this.releaseEntryReads();
    this.releaseRoot?.();
    this.releaseRoot = undefined;
    const onFinished = this.onFinished;
    this.onFinished = undefined;
    onFinished?.(this);
  }

  retire(reason?: unknown): void {
    if (this.state === "invalidated") {
      return;
    }
    this.state = "invalidated";
    this.resultInvalidated = true;
    this.closeAuthority(reason);
    this.releaseEntryReads();
    this.finish();
  }

  /** Archive invalidation stops old progress while admitted calls still owe their final reply. */
  invalidateResult(): void {
    this.resultInvalidated = true;
    this.stopPublishing();
    if (this.finalResponses === 0) {
      this.releaseEntryReads();
    }
    this.finish();
  }

  private releaseEntryReads(): void {
    if (this.syncReads > 0) {
      return;
    }
    const read = this.entryRead;
    this.entryRead = undefined;
    try {
      read?.release();
    } catch {
      // The database resource owner retains failed native disposal for later drainage.
    }
  }

  private closeAuthority(reason?: unknown): void {
    this.isCurrent = undefined;
    for (const remove of this.removeAbortListeners.splice(0)) {
      remove();
    }
    this.stopPublishing(reason);
  }

  private stopPublishing(reason?: unknown): void {
    // Clear captured clients and snapshots immediately, even when a producer ignores abort.
    for (const subscriber of this.subscribers.values()) {
      subscriber.remove();
    }
    this.releaseUnusedPublishers();
    this.controller.abort(reason);
  }
}
