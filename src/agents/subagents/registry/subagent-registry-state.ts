import { expectDefined } from "@openclaw/normalization-core";
import { isVitestRuntimeEnv } from "../../../infra/env.js";
import {
  emitSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../../sessions/session-lifecycle-events.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../../../state/openclaw-state-db-async-lifecycle.js";
import { getActiveOpenClawStateDatabaseReadSnapshot } from "../../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import {
  projectSubagentRunForMaintenance,
  projectSubagentRunForSessionList,
} from "./subagent-delivery-state.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  persistSubagentRegistryChangesAsync,
  supersedePendingSubagentRegistryWrites,
  type SubagentRegistryWriteOptions,
} from "./subagent-registry-persistence.js";
import { publishSubagentRunChanges } from "./subagent-registry-publication.js";
import {
  acceptedFullSnapshot,
  consumeSubagentRuns,
  mergeSelectedFullRuns,
  applySubagentRunChanges,
  assertSubagentReadContext,
  captureSubagentFactsAdmission,
  getPersistedSubagentRunsSnapshot,
  loadPersistedSubagentRunsForRead,
  prepareSubagentRunsCache,
  readCompactSubagentRuns,
  readFullSubagentRuns,
  rememberSubagentRunsSnapshot,
  SubagentSessionListUnavailableError,
  type SubagentRunsCache,
} from "./subagent-registry-read-cache.js";
import type { SubagentRunReadRecord } from "./subagent-registry-read.types.js";
/**
 * Subagent registry state persistence bridge.
 *
 * Merges live runs with retained SQLite rows under the process-local registry owner.
 */
import {
  loadSubagentRunsForChildSessionFromSqlite,
  loadSubagentRunsForControllerFromSqlite,
  loadSubagentRegistryFromSqlite,
  loadSubagentMaintenanceRunsFromSqlite,
  loadSubagentRunsForSessionsFromSqlite,
  saveSubagentRegistryChangesToSqlite,
  saveSubagentRegistryToSqlite,
} from "./subagent-registry.store.sqlite.js";
import type { SubagentRunMaintenanceRecord, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  collectSubagentSessionReadKeys,
  SubagentSessionReadLookup,
} from "./subagent-session-read-scope.js";

const persistedSubagentRunsReadCache: SubagentRunsCache<SubagentRunRecord> = {
  state: {},
  captureAdmission: captureSubagentFactsAdmission,
  load: loadSubagentRegistryFromSqlite,
  copy: structuredClone,
  project: (entry) => entry,
};
const persistedSubagentSessionListRunsReadCache: SubagentRunsCache<SubagentRunReadRecord> = {
  state: {},
  captureAdmission: captureSubagentFactsAdmission,
  copy: projectSubagentRunForSessionList,
  project: projectSubagentRunForSessionList,
};
const persistedSubagentMaintenanceRunsReadCache: SubagentRunsCache<SubagentRunMaintenanceRecord> = {
  state: {},
  load: () => loadSubagentMaintenanceRunsFromSqlite(),
  copy: projectSubagentRunForMaintenance,
  project: projectSubagentRunForMaintenance,
};

// Read caches deliberately advance on failed best-effort writes. Keep notification facts
// commit-owned so a successful retry still refreshes the parent, including after archive.
const committedSwarmNotifications = new Map<
  string,
  { event: SessionLifecycleEvent; signature: string }
>();

function swarmNotification(entry: SubagentRunRecord | undefined) {
  if (
    !entry?.collect ||
    !entry.swarmRequesterSessionKey ||
    !entry.requesterAgentId ||
    !entry.groupId
  ) {
    return undefined;
  }
  return {
    event: {
      sessionKey: entry.swarmRequesterSessionKey,
      agentId: entry.requesterAgentId,
      reason: "swarm",
    },
    // Compare the summary's raw inputs, never child results, labels or error text.
    signature: JSON.stringify([
      entry.swarmRequesterSessionKey,
      entry.requesterAgentId,
      entry.groupId,
      entry.createdAt,
      entry.childSessionKey,
      entry.execution.status,
      entry.collectorCompletion?.status,
    ]),
  };
}

function updateCommittedSwarmNotifications(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds?: readonly string[],
): SessionLifecycleEvent[] {
  const events = new Map<string, SessionLifecycleEvent>();
  const ids = changedRunIds ?? new Set([...committedSwarmNotifications.keys(), ...runs.keys()]);
  for (const runId of ids) {
    const previous = committedSwarmNotifications.get(runId);
    const next = swarmNotification(runs.get(runId));
    if (previous?.signature === next?.signature) {
      continue;
    }
    if (next) {
      committedSwarmNotifications.set(runId, next);
    } else {
      committedSwarmNotifications.delete(runId);
    }
    for (const notification of [previous, next]) {
      if (notification) {
        const event = notification.event;
        events.set(JSON.stringify([event.sessionKey, event.agentId]), event);
      }
    }
  }
  return [...events.values()];
}

type SubagentRegistryPersistListener = () => void;

const SUBAGENT_REGISTRY_PERSIST_LISTENERS = new Set<SubagentRegistryPersistListener>();

function emitSubagentRegistryPersisted(keys?: Array<string | undefined>): void {
  publishSubagentRunChanges(keys);
  for (const listener of SUBAGENT_REGISTRY_PERSIST_LISTENERS) {
    try {
      listener();
    } catch {
      // Persistence already succeeded; observers are best-effort.
    }
  }
}

/** Wake process-local readers after a registry mutation, even if persistence failed. */
export function onSubagentRegistryPersisted(listener: SubagentRegistryPersistListener): () => void {
  SUBAGENT_REGISTRY_PERSIST_LISTENERS.add(listener);
  return () => {
    SUBAGENT_REGISTRY_PERSIST_LISTENERS.delete(listener);
  };
}

function rememberPersistedSubagentRunsSnapshot(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds?: readonly string[],
  databasePath?: string,
): Array<string | undefined> | undefined {
  const previous = persistedSubagentSessionListRunsReadCache.state.snapshot;
  const keys =
    previous &&
    changedRunIds?.flatMap((runId) =>
      [previous.get(runId), runs.get(runId)].flatMap((run) => [
        run?.childSessionKey,
        run?.requesterSessionKey,
        run?.controllerSessionKey,
        run?.swarmRequesterSessionKey,
      ]),
    );
  for (const cache of [
    persistedSubagentRunsReadCache,
    persistedSubagentSessionListRunsReadCache,
    persistedSubagentMaintenanceRunsReadCache,
  ]) {
    rememberSubagentRunsSnapshot(cache, runs, changedRunIds, databasePath);
  }
  return keys;
}

/** Publishes registry rows already committed by a cross-owner shared-state transaction. */
export function publishSubagentRunsAfterAtomicStore(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
  deferredObserverEvents: Array<() => void>,
): void {
  supersedePendingSubagentRegistryWrites(changedRunIds);
  const keys = rememberPersistedSubagentRunsSnapshot(runs, changedRunIds);
  const events = updateCommittedSwarmNotifications(runs, changedRunIds);
  deferredObserverEvents.push(() => {
    emitSubagentRegistryPersisted(keys);
    events.forEach(emitSessionLifecycleEvent);
  });
}

function shouldReadPersistedSubagentRuns(): boolean {
  return !isVitestRuntimeEnv() || process.env.OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE === "1";
}

/** Existing resident facts, fenced by the physical source rather than a publisher's scope. */
export function getSubagentSessionListReadSnapshotIdentity(): object | undefined {
  if (!shouldReadPersistedSubagentRuns()) {
    return subagentRuns;
  }
  try {
    return getPersistedSubagentRunsSnapshot(persistedSubagentSessionListRunsReadCache) ?? undefined;
  } catch (error) {
    if (!isStateDatabaseReadAdmissionInvalidatedError(error)) {
      throw error;
    }
    return undefined;
  }
}

export async function prepareSubagentSessionListReadCache(): Promise<void> {
  if (!shouldReadPersistedSubagentRuns()) {
    return;
  }
  if (getActiveOpenClawStateDatabaseReadSnapshot()) {
    throw new Error("Resident subagent preparation cannot adopt a private database snapshot");
  }
  await prepareSubagentRunsCache(
    persistedSubagentSessionListRunsReadCache,
    readCompactSubagentRuns,
  );
}

/** History can omit retained child hints only after a failed query has settled cleanly. */
export async function prepareOptionalSubagentSessionListReadCache(): Promise<boolean> {
  if (!shouldReadPersistedSubagentRuns()) {
    return true;
  }
  const context = captureOpenClawStateWorkerContext();
  try {
    await prepareSubagentSessionListReadCache();
    assertSubagentReadContext(context);
    return true;
  } catch (error) {
    if (!(error instanceof SubagentSessionListUnavailableError)) {
      throw error;
    }
    assertSubagentReadContext(context);
    return false;
  }
}

/** Captured Maps remain caller-owned, including prompt overlays of full result records. */
async function readSubagentSessionListRunsSnapshot(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Promise<Map<string, SubagentRunReadRecord>> {
  const context = shouldReadPersistedSubagentRuns()
    ? captureOpenClawStateWorkerContext()
    : undefined;
  const runs = shouldReadPersistedSubagentRuns()
    ? new Map(
        await prepareSubagentRunsCache(
          persistedSubagentSessionListRunsReadCache,
          readCompactSubagentRuns,
        ),
      )
    : new Map<string, SubagentRunReadRecord>();
  if (context) {
    assertSubagentReadContext(context);
  }
  for (const [runId, entry] of inMemoryRuns) {
    runs.set(runId, projectSubagentRunForSessionList(entry));
  }
  return runs;
}

function getSessionListLookup<T extends SubagentRunReadRecord>(
  cache: SubagentRunsCache<T>,
): SubagentSessionReadLookup | undefined {
  const state = cache.state;
  if (cache !== persistedSubagentSessionListRunsReadCache || !state.snapshot) {
    return undefined;
  }
  return (state.lookup ??= new SubagentSessionReadLookup(state.snapshot));
}

function indexedSnapshotRows<T>(snapshot: Map<string, T>, keys: readonly string[]): T[] {
  return keys.map((key) => expectDefined(snapshot.get(key), "indexed subagent cache entry"));
}

export function clearSubagentRunsReadCacheForTest(): void {
  supersedePendingSubagentRegistryWrites();
  committedSwarmNotifications.clear();
  persistedSubagentRunsReadCache.state = {};
  persistedSubagentSessionListRunsReadCache.state = {};
  persistedSubagentMaintenanceRunsReadCache.state = {};
}

function persistSubagentRuns(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[] | undefined,
  strict: boolean,
): void {
  supersedePendingSubagentRegistryWrites(changedRunIds);
  let committed = false;
  try {
    if (changedRunIds) {
      saveSubagentRegistryChangesToSqlite(runs, changedRunIds);
    } else {
      saveSubagentRegistryToSqlite(runs);
    }
    committed = true;
  } catch (error) {
    if (strict) {
      throw error;
    }
  }
  // In-process readers must observe the authoritative memory snapshot before the wake.
  const keys = rememberPersistedSubagentRunsSnapshot(runs, changedRunIds);
  const events = committed ? updateCommittedSwarmNotifications(runs, changedRunIds) : [];
  emitSubagentRegistryPersisted(keys);
  events.forEach(emitSessionLifecycleEvent);
}

export function persistSubagentRunsToDisk(
  runs: Map<string, SubagentRunRecord>,
  // Undefined replaces the complete snapshot; an array applies exact row mutations.
  changedRunIds?: readonly string[],
) {
  persistSubagentRuns(runs, changedRunIds, false);
}

export function persistSubagentRunsToDiskOrThrow(
  runs: Map<string, SubagentRunRecord>,
  // Undefined replaces the complete snapshot; an array applies exact row mutations.
  changedRunIds?: readonly string[],
) {
  persistSubagentRuns(runs, changedRunIds, true);
}

export function persistSubagentRunsToDiskAsyncOrThrow(
  runs: Map<string, SubagentRunRecord>,
  changedRunIds: readonly string[],
  options: SubagentRegistryWriteOptions,
): Promise<void> {
  return persistSubagentRegistryChangesAsync(runs, changedRunIds, options, (snapshot, runIds) => {
    options.onCommitted?.();
    const keys = rememberPersistedSubagentRunsSnapshot(
      snapshot,
      runIds,
      options.context.admission.databasePath,
    );
    const events = updateCommittedSwarmNotifications(snapshot, runIds);
    emitSubagentRegistryPersisted(keys);
    events.forEach(emitSessionLifecycleEvent);
  });
}

export function restoreSubagentRunsFromDisk(params: {
  runs: Map<string, SubagentRunRecord>;
  mergeOnly?: boolean;
}) {
  const restored = loadSubagentRegistryFromSqlite();
  supersedePendingSubagentRegistryWrites();
  const keys = rememberPersistedSubagentRunsSnapshot(restored);
  let added = 0;
  for (const [runId, entry] of restored.entries()) {
    if (!runId || !entry) {
      continue;
    }
    if (params.mergeOnly && params.runs.has(runId)) {
      continue;
    }
    params.runs.set(runId, entry);
    const notification = swarmNotification(entry);
    if (notification) {
      committedSwarmNotifications.set(runId, notification);
    } else {
      committedSwarmNotifications.delete(runId);
    }
    subagentRuns.commitOwnership(entry);
    added += 1;
  }
  emitSubagentRegistryPersisted(keys);
  return added;
}

function getSubagentRunsSnapshot<T extends SubagentRunReadRecord>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  cache: SubagentRunsCache<T>,
  scope?: {
    load?: () => Iterable<T>;
    fresh?: boolean;
    borrowPersisted?: boolean;
    matches: (entry: SubagentRunReadRecord) => boolean;
  },
): Map<string, T> {
  if (
    shouldReadPersistedSubagentRuns() &&
    !cache.load &&
    !getPersistedSubagentRunsSnapshot(cache)
  ) {
    throw new Error("Subagent session-list facts must be prepared before synchronous reads");
  }
  const merged = new Map<string, T>();
  if (shouldReadPersistedSubagentRuns()) {
    try {
      // Scoped reads use indexed SQL until a complete owner snapshot is available.
      const cached = scope?.load && !scope.fresh ? getPersistedSubagentRunsSnapshot(cache) : null;
      const persisted = scope?.load
        ? (cached?.values() ?? scope.load())
        : loadPersistedSubagentRunsForRead(cache).values();
      for (const entry of persisted) {
        if (!scope || scope.matches(entry)) {
          merged.set(
            entry.runId,
            scope?.load && !scope.borrowPersisted ? structuredClone(entry) : entry,
          );
        }
      }
    } catch {
      // Ignore disk read failures and fall back to local memory.
    }
  }
  if (shouldReadPersistedSubagentRuns()) {
    for (const [runId, entry] of cache.state.changes ?? []) {
      if (entry && (!scope || scope.matches(entry))) {
        merged.set(runId, scope?.load && !scope.borrowPersisted ? structuredClone(entry) : entry);
      } else {
        merged.delete(runId);
      }
    }
  }
  for (const [runId, entry] of inMemoryRuns) {
    if (!scope || scope.matches(entry)) {
      merged.set(runId, cache.project(entry));
    } else {
      // Live memory wins even when a run moved out of the persisted scope.
      merged.delete(runId);
    }
  }
  return merged;
}

export function getSubagentRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache);
}

export function getSubagentMaintenanceRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
): Map<string, SubagentRunMaintenanceRecord> {
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentMaintenanceRunsReadCache);
}

type SubagentRunReadSelection = {
  runIds: readonly string[];
  sessionKeys: readonly string[];
};

/** Hydrate selected payloads, then capture their current graph and raw owners in one frame. */
export async function withSubagentRunReadSnapshot<S extends SubagentRunReadSelection, T>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  select: (snapshot: Map<string, SubagentRunReadRecord>) => S,
  consume: (selection: S, runs: ReadonlyMap<string, SubagentRunRecord>) => T,
): Promise<T> {
  const context = shouldReadPersistedSubagentRuns()
    ? captureOpenClawStateWorkerContext()
    : undefined;
  let snapshot = await readSubagentSessionListRunsSnapshot(inMemoryRuns);
  let refreshedMissingRows = false;
  for (;;) {
    const selected = select(snapshot);
    const runIds = new Set(selected.runIds);
    const sessionKeys = new Set(selected.sessionKeys);
    const matches = (entry: SubagentRunReadRecord) =>
      runIds.has(entry.runId) ||
      sessionKeys.has(entry.requesterSessionKey.trim()) ||
      Boolean(entry.controllerSessionKey && sessionKeys.has(entry.controllerSessionKey.trim()));
    let persisted = context
      ? acceptedFullSnapshot(persistedSubagentRunsReadCache, context)
      : undefined;
    if (!persisted) {
      persisted = new Map<string, SubagentRunRecord>();
      if (context) {
        const scopes = [
          { kind: "ids" as const, runIds: [...runIds] },
          ...[...sessionKeys].map((sessionKey) => ({ kind: "session" as const, sessionKey })),
        ];
        for (const scope of scopes) {
          for (const [runId, entry] of await readFullSubagentRuns(context, scope)) {
            persisted.set(runId, entry);
          }
        }
      }
    }
    if (context) {
      assertSubagentReadContext(context);
    }
    snapshot = getActiveOpenClawStateDatabaseReadSnapshot()
      ? await readSubagentSessionListRunsSnapshot(inMemoryRuns)
      : getSubagentSessionListRunsSnapshotForRead(inMemoryRuns);
    if (context) {
      assertSubagentReadContext(context);
    }
    const full = mergeSelectedFullRuns(
      persistedSubagentRunsReadCache,
      inMemoryRuns,
      persisted,
      matches,
      context,
    );
    for (const entry of full.values()) {
      snapshot.set(entry.runId, projectSubagentRunForSessionList(entry));
    }
    const current = select(snapshot);
    if (!refreshedMissingRows && current.runIds.some((runId) => !full.has(runId))) {
      // A durable replacement may precede this process's bridge publication.
      if (!getActiveOpenClawStateDatabaseReadSnapshot()) {
        persistedSubagentSessionListRunsReadCache.state = {};
      }
      snapshot = await readSubagentSessionListRunsSnapshot(inMemoryRuns);
      refreshedMissingRows = true;
      continue;
    }
    if (
      current.sessionKeys.some((key) => !sessionKeys.has(key)) ||
      current.runIds.some((runId) => {
        const entry = snapshot.get(runId);
        return entry && !matches(entry);
      })
    ) {
      continue;
    }
    return consumeSubagentRuns(full, (runs) => consume(current, runs));
  }
}

export async function withSubagentRunsSnapshotForRunIds<T>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  runIds: readonly string[],
  consume: (runs: ReadonlyMap<string, SubagentRunRecord>) => T,
): Promise<T> {
  const requested = new Set(runIds.map((runId) => runId.trim()));
  if (requested.size === 0) {
    return consumeSubagentRuns(new Map(), consume);
  }
  const matches = (entry: SubagentRunReadRecord) =>
    requested.has(entry.runId) || Boolean(entry.swarmRunId && requested.has(entry.swarmRunId));
  const context = shouldReadPersistedSubagentRuns()
    ? captureOpenClawStateWorkerContext()
    : undefined;
  let persisted = context
    ? acceptedFullSnapshot(persistedSubagentRunsReadCache, context)
    : undefined;
  if (context && !persisted) {
    const readSelected = async () => {
      const projection = await prepareSubagentRunsCache(
        persistedSubagentSessionListRunsReadCache,
        readCompactSubagentRuns,
      );
      assertSubagentReadContext(context);
      const physicalRunIds = [...projection.values()].filter(matches).map((entry) => entry.runId);
      return {
        physicalRunIds,
        entries: await readFullSubagentRuns(context, { kind: "ids", runIds: physicalRunIds }),
      };
    };
    let selected = await readSelected();
    if (
      selected.entries.size !== selected.physicalRunIds.length ||
      [...selected.entries.values()].some((entry) => !matches(entry))
    ) {
      // Stable collector aliases can move to a different physical row in another process.
      persistedSubagentSessionListRunsReadCache.state = {};
      selected = await readSelected();
    }
    persisted = selected.entries;
  }
  if (context) {
    assertSubagentReadContext(context);
  }
  const runs = mergeSelectedFullRuns(
    persistedSubagentRunsReadCache,
    inMemoryRuns,
    persisted ?? new Map(),
    matches,
    context,
  );
  return consumeSubagentRuns(runs, consume);
}

export function getSubagentSessionListRunsSnapshotForRead(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  controllerSessionKeys?: readonly string[],
): Map<string, SubagentRunReadRecord> {
  if (controllerSessionKeys) {
    const keys = new Set(controllerSessionKeys.map((key) => key.trim()).filter(Boolean));
    if (keys.size === 0) {
      return new Map();
    }
    const cache = persistedSubagentSessionListRunsReadCache;
    const cached = shouldReadPersistedSubagentRuns()
      ? getPersistedSubagentRunsSnapshot(cache)
      : null;
    const lookup = cached ? getSessionListLookup(cache) : undefined;
    if (!cached || !lookup) {
      if (!shouldReadPersistedSubagentRuns()) {
        return getSubagentRunsSnapshot(inMemoryRuns, cache, {
          matches: (entry) =>
            keys.has(entry.controllerSessionKey?.trim() || entry.requesterSessionKey),
        });
      }
      throw new Error("Subagent session-list facts must be prepared before synchronous reads");
    }
    return getSubagentRunsSnapshot(inMemoryRuns, cache, {
      fresh: true,
      load: () => indexedSnapshotRows(cached, lookup.selectControllers(keys)),
      matches: (entry) => keys.has(entry.controllerSessionKey?.trim() || entry.requesterSessionKey),
    });
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentSessionListRunsReadCache);
}

function getSubagentSessionTreeSnapshot<T extends SubagentRunReadRecord>(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
  cache: SubagentRunsCache<T>,
  load?: () => { sessionKeys: Set<string>; runs: Map<string, T>; complete: boolean },
): Map<string, T> {
  if (!sessionKeys.some((key) => key.trim())) {
    return new Map();
  }
  const cached = shouldReadPersistedSubagentRuns() ? getPersistedSubagentRunsSnapshot(cache) : null;
  const lookup = cached ? getSessionListLookup(cache) : undefined;
  const indexed = lookup?.selectSessions(sessionKeys, inMemoryRuns.values());
  let selected =
    indexed?.sessionKeys ??
    collectSubagentSessionReadKeys(sessionKeys, cached?.values() ?? [], inMemoryRuns.values());
  return getSubagentRunsSnapshot(inMemoryRuns, cache, {
    // The loader owns cache selection so topology and metadata use the same source.
    fresh: true,
    // Descendant queries only inspect records, matching their unscoped snapshots.
    borrowPersisted: true,
    load: () => {
      if (cached) {
        return indexed ? indexedSnapshotRows(cached, indexed.cacheKeys) : cached.values();
      }
      if (!load) {
        throw new Error("Subagent session-list facts must be prepared before synchronous reads");
      }
      const snapshot = load();
      // A tree covering every physical row may populate the existing full cache.
      if (snapshot.complete) {
        applySubagentRunChanges(snapshot.runs, cache.state.changes);
        const loadedLookup =
          cache === persistedSubagentSessionListRunsReadCache
            ? new SubagentSessionReadLookup(snapshot.runs)
            : undefined;
        const loadedIndex = loadedLookup?.selectSessions(sessionKeys, inMemoryRuns.values());
        snapshot.sessionKeys =
          loadedIndex?.sessionKeys ??
          collectSubagentSessionReadKeys(
            sessionKeys,
            snapshot.runs.values(),
            inMemoryRuns.values(),
          );
        const admission = cache.captureAdmission?.();
        cache.state = {
          snapshot: snapshot.runs,
          admission,
          sourceIdentity: admission?.identity.key,
          ...(loadedLookup ? { lookup: loadedLookup } : {}),
        };
        if (loadedIndex) {
          selected = snapshot.sessionKeys;
          return indexedSnapshotRows(snapshot.runs, loadedIndex.cacheKeys);
        }
      }
      selected = snapshot.sessionKeys;
      return snapshot.runs.values();
    },
    matches: (entry) => selected.has(entry.childSessionKey.trim()),
  });
}

/** Exact rows share the owner snapshot while projecting only their complete requester trees. */
export function getSubagentSessionListRunsSnapshotForSessions(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
): Map<string, SubagentRunReadRecord> {
  return getSubagentSessionTreeSnapshot(
    inMemoryRuns,
    sessionKeys,
    persistedSubagentSessionListRunsReadCache,
  );
}

/** Settlement reads retain the canonical codec and raw local reservation ownership. */
export function getSubagentRunsSnapshotForSessions(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  sessionKeys: readonly string[],
): Map<string, SubagentRunRecord> {
  return getSubagentSessionTreeSnapshot(
    inMemoryRuns,
    sessionKeys,
    persistedSubagentRunsReadCache,
    () => loadSubagentRunsForSessionsFromSqlite(sessionKeys, inMemoryRuns.values(), "full"),
  );
}

export function getSubagentRunsSnapshotForController(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  controllerSessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = controllerSessionKey.trim();
  if (!key) {
    return new Map();
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    load: () => loadSubagentRunsForControllerFromSqlite(key),
    matches: (entry) => (entry.controllerSessionKey?.trim() || entry.requesterSessionKey) === key,
  });
}

export function getSubagentRunsSnapshotForChildSession(
  inMemoryRuns: Map<string, SubagentRunRecord>,
  childSessionKey: string,
): Map<string, SubagentRunRecord> {
  const key = childSessionKey.trim();
  if (!key) {
    return new Map();
  }
  return getSubagentRunsSnapshot(inMemoryRuns, persistedSubagentRunsReadCache, {
    load: () => loadSubagentRunsForChildSessionFromSqlite(key),
    matches: (entry) => entry.childSessionKey === key,
  });
}
