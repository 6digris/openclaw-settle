import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { listSubagentSessionListRunsForControllers } from "../agents/subagents/registry/subagent-registry-read.js";
import {
  isConfiguredSessionStoreAgentId,
  isPerAgentSessionStoreConfig,
  resolveExistingAgentSessionStoreTargetsSync,
  resolveSessionStorePathCore,
  type SessionEntry,
  type SessionStoreTarget,
} from "../config/sessions.js";
import { listSessionChildEntriesReadOnly } from "../config/sessions/session-accessor.js";
import type {
  SessionEntryListScope,
  SessionEntryReadSource,
} from "../config/sessions/session-accessor.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isIncognitoSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import {
  loadGatewaySessionStoreReads,
  readGatewaySessionStore,
  type GatewaySessionStoreRead,
  type GatewaySessionStoreCache,
} from "./session-utils-store-read.js";
import {
  resolveGatewaySessionStoreReadResults,
  type GatewaySessionStoreLookup,
} from "./session-utils-store-selection.js";
import type {
  GatewaySessionStoreTarget,
  GatewaySessionStoreTargetWithStore,
} from "./session-utils-store.types.js";
export type { GatewaySessionStoreCache } from "./session-utils-store-read.js";

type GatewaySessionStoreDiscovery = {
  existing: SessionStoreTarget[];
  fallback: SessionStoreTarget;
};

function resolveGatewaySessionStoreCandidates(
  cfg: OpenClawConfig,
  agentId: string,
  cache?: GatewaySessionStoreDiscoveryCache,
  excludeConfiguredFallback = false,
  env: NodeJS.ProcessEnv = process.env,
  registeredDatabases?: readonly { agentId: string; path: string }[],
): GatewaySessionStoreDiscovery {
  const cached = cache?.get(agentId);
  if (cached) {
    return cached;
  }
  const storeConfig = cfg.session?.store;
  const fallback = {
    agentId,
    storePath: resolveSessionStorePathCore(storeConfig, { agentId, env }),
  };
  const discovery = {
    existing: resolveExistingAgentSessionStoreTargetsSync(cfg, agentId, {
      env,
      registeredDatabases,
      excludeStorePath:
        !cache && excludeConfiguredFallback && !isPerAgentSessionStoreConfig(storeConfig)
          ? fallback.storePath
          : undefined,
    }),
    fallback,
  };
  cache?.set(agentId, discovery);
  return discovery;
}

/**
 * Sharing resolves every returned row, but store targets are stable within one request.
 * Keep discovery agent-scoped here or each row repeats registry probes and agent-root scans.
 */
export type GatewaySessionStoreDiscoveryCache = Map<string, GatewaySessionStoreDiscovery>;

export function resolveGatewaySessionStoreLookupCandidates(params: {
  cfg: OpenClawConfig;
  agentId: string;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
  env?: NodeJS.ProcessEnv;
  registeredDatabases?: readonly { agentId: string; path: string }[];
}): {
  configured: boolean;
  fallback: SessionStoreTarget;
  candidates: SessionStoreTarget[];
  readSources?: SessionEntryReadSource[];
} {
  const configured = isConfiguredSessionStoreAgentId(params.cfg, params.agentId);
  if (!configured && params.registeredDatabases) {
    // Prepared discovery already holds registered owners; don't rescan retired roots per page.
    const readSources = params.registeredDatabases
      .filter((source) => normalizeAgentId(source.agentId) === params.agentId)
      .map((source) => ({ agentId: source.agentId, path: source.path }));
    return {
      configured,
      fallback: {
        agentId: params.agentId,
        storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
          agentId: params.agentId,
          env: params.env,
        }),
      },
      candidates: readSources.map((source) => ({
        agentId: source.agentId,
        storePath: source.path,
      })),
      readSources,
    };
  }
  const { existing, fallback } = resolveGatewaySessionStoreCandidates(
    params.cfg,
    params.agentId,
    params.targetDiscoveryCache,
    configured,
    params.env,
    params.registeredDatabases,
  );
  return {
    configured,
    fallback,
    candidates: configured
      ? [fallback, ...existing.filter((target) => target.storePath !== fallback.storePath)]
      : existing,
  };
}

type GatewaySessionStoreLookupParams = {
  cfg: OpenClawConfig;
  key: string;
  agentId?: string;
  clone?: boolean;
  projection?: SessionEntryListScope["projection"];
  readOnly?: boolean;
  exactRead?: boolean;
  includeStoreChildEntries?: boolean;
  store?: Record<string, SessionEntry>;
  storeCache?: GatewaySessionStoreCache;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
};

type GatewaySessionStorePlan<T> = {
  reads: GatewaySessionStoreRead[];
  resolve: () => T;
};

function prepareGatewaySessionStoreLookup(
  params: GatewaySessionStoreLookupParams & { canonicalKey: string; agentId: string },
): GatewaySessionStorePlan<GatewaySessionStoreLookup> {
  const scanTargets = uniqueStrings([params.canonicalKey, params.key].filter(Boolean));
  const { configured, fallback, candidates } = resolveGatewaySessionStoreLookupCandidates(params);
  if (candidates.length === 0) {
    // Retired/manual agents require an existing discovered store; lookup never creates one.
    return {
      reads: [],
      resolve: () => ({ storePath: fallback.storePath, store: {}, match: undefined }),
    };
  }
  const reads = candidates.map((target, index): GatewaySessionStoreRead => ({
    storePath: target.storePath,
    agentId: target.agentId,
    clone: params.clone,
    options: {
      readOnly: configured ? params.readOnly : true,
      ...(params.exactRead ? { exactKeys: scanTargets } : {}),
      ...(params.projection ? { projection: params.projection } : {}),
      ...(params.storeCache ? { cache: params.storeCache } : {}),
    },
    result:
      configured &&
      index === 0 &&
      target.storePath === fallback.storePath &&
      params.store !== undefined
        ? ok(params.store)
        : undefined,
  }));
  return {
    reads,
    resolve: () =>
      resolveGatewaySessionStoreReadResults({
        ...params,
        reads,
        readStore: readGatewaySessionStore,
        scanTargets,
      }),
  };
}

function prepareGatewaySessionStoreTarget(
  params: GatewaySessionStoreLookupParams,
): GatewaySessionStorePlan<GatewaySessionStoreTargetWithStore> {
  const key = params.key;
  const { canonicalKey, agentId } = resolveSessionStoreIdentity({
    cfg: params.cfg,
    sessionKey: key,
    agentId: params.agentId,
  });
  if (isIncognitoSessionKey(canonicalKey)) {
    const storePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId });
    const read: GatewaySessionStoreRead = {
      storePath,
      agentId,
      clone: params.clone,
      options: {
        // Arbitrary stale keys must not materialize process-lifetime incognito state.
        readOnly: true,
        ...(params.exactRead ? { exactKeys: [canonicalKey] } : {}),
        ...(params.projection ? { projection: params.projection } : {}),
        ...(params.storeCache ? { cache: params.storeCache } : {}),
      },
    };
    return {
      reads: [read],
      resolve: () => ({
        agentId,
        storePath,
        canonicalKey,
        storeKeys: [canonicalKey],
        store: readGatewaySessionStore(read),
        ...(read.readSource ? { readSource: read.readSource } : {}),
      }),
    };
  }
  const lookup = prepareGatewaySessionStoreLookup({ ...params, canonicalKey, agentId });
  return {
    reads: lookup.reads,
    resolve: () => {
      const { storePath, store, readSource } = lookup.resolve();
      const storeKeys = uniqueStrings([canonicalKey, key].filter(Boolean));
      return {
        agentId,
        storePath,
        canonicalKey,
        storeKeys,
        store,
        ...(readSource ? { readSource } : {}),
      };
    },
  };
}

export function resolveGatewaySessionStoreTargetWithStore(
  params: GatewaySessionStoreLookupParams,
): GatewaySessionStoreTargetWithStore {
  const normalized = { ...params, key: normalizeOptionalString(params.key) ?? "" };
  return includeDirectChildEntries(
    prepareGatewaySessionStoreTarget(normalized).resolve(),
    params.includeStoreChildEntries,
    params.cfg,
  );
}

/** Exact row owners supply missing parent facts without expanding their selected store. */
export function createGatewaySessionEntryReader(params: {
  cfg: OpenClawConfig;
  agentId: string;
  store: Record<string, SessionEntry>;
  readSource?: SessionEntryReadSource;
}): (key: string) => SessionEntry | undefined {
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  return (key) => {
    if (params.store[key]) {
      return params.store[key];
    }
    const target = resolveGatewaySessionStoreTargetWithStore({
      cfg: params.cfg,
      key,
      // Unqualified parents are child-relative; qualified aliases retain their own owner.
      ...(parseAgentSessionKey(key) ? {} : { agentId: params.agentId }),
      readOnly: true,
      exactRead: true,
      clone: false,
      projection: "list",
      targetDiscoveryCache,
    });
    return target.store[target.canonicalKey];
  };
}

/** Resolve one synchronous set of logical metadata targets using exact grouped reads. */
export function resolveGatewaySessionStoreTargetsReadOnly(params: {
  cfg: OpenClawConfig;
  targets: readonly { key: string; agentId?: string }[];
  projection?: SessionEntryListScope["projection"];
}): GatewaySessionStoreTargetWithStore[] {
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const requests = params.targets.map((target) => {
    const lookup: GatewaySessionStoreLookupParams = {
      ...target,
      key: normalizeOptionalString(target.key) ?? "",
      cfg: params.cfg,
      clone: false,
      readOnly: true,
      exactRead: true,
      projection: params.projection ?? "list",
      targetDiscoveryCache,
    };
    return prepareGatewaySessionStoreTarget(lookup);
  });
  loadGatewaySessionStoreReads(requests.flatMap((request) => request.reads));
  return requests.map((request) => request.resolve());
}

function captureSessionStoreTargetResult<T>(resolve: () => T): Result<T, unknown> {
  try {
    return ok(resolve());
  } catch (error) {
    return err(error);
  }
}

/** Read exact groups now, retaining logical errors for the caller's ordered visitor. */
export function prepareGatewaySessionStoreTargetsReadOnly(params: {
  cfg: OpenClawConfig;
  targets: readonly { key: string; agentId?: string }[];
  projection: SessionEntryListScope["projection"];
}): Array<Result<GatewaySessionStoreTargetWithStore, unknown>> {
  const targetDiscoveryCache: GatewaySessionStoreDiscoveryCache = new Map();
  const requests = params.targets.map((target) =>
    captureSessionStoreTargetResult(() => {
      const lookup: GatewaySessionStoreLookupParams = {
        ...target,
        key: normalizeOptionalString(target.key) ?? "",
        cfg: params.cfg,
        clone: false,
        readOnly: true,
        exactRead: true,
        projection: params.projection,
        targetDiscoveryCache,
      };
      return prepareGatewaySessionStoreTarget(lookup);
    }),
  );
  loadGatewaySessionStoreReads(
    requests.flatMap((request) => (request.ok ? request.value.reads : [])),
  );
  return requests.map((request) =>
    request.ok ? captureSessionStoreTargetResult(request.value.resolve) : request,
  );
}

function includeDirectChildEntries(
  target: GatewaySessionStoreTargetWithStore,
  include: boolean | undefined,
  cfg: OpenClawConfig,
): GatewaySessionStoreTargetWithStore {
  if (!include) {
    return target;
  }
  try {
    const parentKeys = new Set([target.canonicalKey, ...target.storeKeys]);
    const childKeys = new Set<string>();
    for (const parentKey of parentKeys) {
      for (const { sessionKey, entry } of listSessionChildEntriesReadOnly({
        agentId: target.agentId,
        clone: false,
        projection: "list",
        sessionKey: parentKey,
        storePath: target.storePath,
      })) {
        // Child discovery must not replace a selected full entry with metadata.
        if (!parentKeys.has(sessionKey)) {
          target.store[sessionKey] = entry;
        }
      }
    }
    for (const { childSessionKey } of listSubagentSessionListRunsForControllers([...parentKeys])) {
      childKeys.add(childSessionKey);
    }
    // Retained runs are discovery hints, not existence: deduplicate and batch exact reads.
    const targets = [...childKeys].filter((key) => !target.store[key]).map((key) => ({ key }));
    for (const child of resolveGatewaySessionStoreTargetsReadOnly({
      cfg,
      targets,
      projection: "list",
    })) {
      const entry = child.store[child.canonicalKey];
      if (entry && !parentKeys.has(child.canonicalKey)) {
        target.store[child.canonicalKey] = entry;
      }
    }
  } catch {
    // Match the existing read-only lookup contract: unavailable stores degrade to no rows.
  }
  return target;
}

export function resolveGatewaySessionStoreTarget(params: {
  cfg: OpenClawConfig;
  key: string;
  agentId?: string;
  clone?: boolean;
  store?: Record<string, SessionEntry>;
}): GatewaySessionStoreTarget {
  // Read selected metadata exactly, keeping the scalar caller's database admission mode.
  const {
    store: _store,
    readSource: _readSource,
    ...target
  } = resolveGatewaySessionStoreTargetWithStore({
    ...params,
    projection: "list",
    exactRead: true,
    readOnly: params.clone === false,
  });
  return target;
}
