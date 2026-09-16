import type {
  SessionCatalog,
  SessionsCatalogListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionCatalogInstances } from "./session-catalog-entry-snapshot.js";
import { SessionCatalogListLifetime } from "./session-catalog-list-lifetime.js";
import type { CatalogRegistrationSnapshot } from "./session-catalog-provider-access.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

export type CatalogListResult = { catalogs: SessionCatalog[] };
export type CatalogListEnumeration = CatalogListResult & { instances: SessionCatalogInstances };
export type CatalogListCacheEntry = {
  progress: SessionCatalogListLifetime;
  result: Promise<CatalogListEnumeration>;
};

type CatalogListCacheState = {
  config: OpenClawConfig;
  registrations: CatalogRegistrationSnapshot;
  pending: Map<string, CatalogListCacheEntry>;
  entries: Map<string, CatalogListCacheEntry & { expiresAt: number }>;
  active: Set<SessionCatalogListLifetime>;
};

const catalogListsByContext = new WeakMap<GatewayRequestContext, CatalogListCacheState>();

export function getSessionCatalogListCache(
  context: GatewayRequestContext,
  config: OpenClawConfig,
  registrations: CatalogRegistrationSnapshot,
): CatalogListCacheState {
  let state = catalogListsByContext.get(context);
  if (!state) {
    state = { config, registrations, pending: new Map(), entries: new Map(), active: new Set() };
    catalogListsByContext.set(context, state);
  } else if (state.config !== config || state.registrations !== registrations) {
    state.config = config;
    state.registrations = registrations;
    state.pending.clear();
    state.entries.clear();
    state.pending = new Map();
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
  cache.pending.clear();
  cache.entries.clear();
  for (const lifetime of active) {
    lifetime.invalidateResult();
  }
}

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
