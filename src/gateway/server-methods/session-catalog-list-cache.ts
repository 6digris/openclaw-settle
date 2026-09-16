import type { SessionCatalog } from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SessionCatalogInstances } from "./session-catalog-entry-snapshot.js";
import type { SessionCatalogListLifetime } from "./session-catalog-list-lifetime.js";
import type { CatalogRegistrationSnapshot } from "./session-catalog-provider-access.js";

export type CatalogListEnumeration = {
  catalogs: SessionCatalog[];
  instances: SessionCatalogInstances;
};

type CatalogListCacheEntry = {
  progress: SessionCatalogListLifetime;
  result: Promise<CatalogListEnumeration>;
};

type CatalogListCacheState = {
  pending: Map<string, CatalogListCacheEntry>;
  entries: Map<string, CatalogListCacheEntry & { expiresAt: number }>;
};

// A shared config can outlive a plugin generation. Its selected cache must also
// depend on the registration snapshot, including completed result and progress captures.
const catalogListsByConfig = new WeakMap<
  OpenClawConfig,
  {
    registrations: WeakRef<CatalogRegistrationSnapshot>;
    states: WeakMap<CatalogRegistrationSnapshot, CatalogListCacheState>;
  }
>();

export function getSessionCatalogListCache(
  config: OpenClawConfig,
  registrations: CatalogRegistrationSnapshot,
): CatalogListCacheState {
  let state = catalogListsByConfig.get(config)?.states.get(registrations);
  if (!state) {
    state = { pending: new Map(), entries: new Map() };
    // Replace the single selection: returning to an older snapshot starts a fresh listing.
    catalogListsByConfig.set(config, {
      registrations: new WeakRef(registrations),
      states: new WeakMap([[registrations, state]]),
    });
  }
  return state;
}

export function retireSessionCatalogLists(config: OpenClawConfig): void {
  const selected = catalogListsByConfig.get(config);
  const registrations = selected?.registrations.deref();
  const cache = registrations ? selected?.states.get(registrations) : undefined;
  if (!cache) {
    return;
  }
  // Host publications can outlive the aggregate response and still contain an archived row.
  for (const entries of [cache.pending, cache.entries]) {
    for (const entry of entries.values()) {
      entry.progress.retire();
    }
    entries.clear();
  }
}
