import { resolveSystemEventStorePath } from "../config/sessions/session-store-path.js";
/** Owns explicit and ambient session-watch registration and physical-store projections. */
import type { SessionEntry } from "../config/sessions/types.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import {
  getPublishedSystemEventStoreSelection,
  isSystemEventStoreCurrent,
  rememberSystemEventStoreWatcher,
  recordSystemEventStoreReplaced,
} from "../infra/system-event-ownership.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildAgentMainSessionKey, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  SESSION_WATCH_PROVENANCE_AMBIENT_GROUP,
  SESSION_WATCH_PROVENANCE_EXPLICIT,
} from "../state/session-watch-cursor-provenance.js";
import { classifySessionKind } from "./classify-session-kind.js";
import {
  getSessionStateKysely,
  isNotifiableWatcherKey,
  normalizeOptionalSqliteNumber,
  readCursor,
  upsertSeedCursor,
} from "./session-state-events.kernel.js";

const log = createSubsystemLogger("sessions/state-events");

/** List durable ambient-group targets owned by one watcher; failures grant nothing. */
export function listAmbientGroupWatchTargets(
  watcherSessionKey: string,
  options: OpenClawStateDatabaseOptions = {},
): Set<string> {
  try {
    const watcherStorePath = resolveSystemEventStorePath({
      sessionKey: watcherSessionKey,
      env: options.env,
    });
    const sameStorePath = createOpenClawAgentDatabasePathMatcher();
    const { db } = openOpenClawStateDatabase(options);
    const rows = executeSqliteQuerySync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_watch_cursors")
        .selectAll()
        .where("watcher_session_key", "=", watcherSessionKey)
        .where("provenance", "=", SESSION_WATCH_PROVENANCE_AMBIENT_GROUP),
    ).rows;
    return new Set(
      rows
        .filter(
          (row) =>
            row.watcher_store_path &&
            watcherStorePath &&
            sameStorePath(row.watcher_store_path, watcherStorePath),
        )
        .map((row) => row.target_session_key),
    );
  } catch (error) {
    log.warn(`failed to list ambient group watch targets: ${String(error)}`);
    return new Set();
  }
}

/** Register an explicit watcher (e.g. a sessions_send coordinator) for a target session. */
export function registerSessionStateWatch(
  params: {
    watcherSessionKey: string;
    watcherStorePath?: string | null;
    targetSessionKey: string;
    targetAgentId?: string;
  },
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): boolean {
  if (
    params.watcherSessionKey === params.targetSessionKey ||
    !isNotifiableWatcherKey(params.watcherSessionKey)
  ) {
    return false;
  }
  const now = options.now ?? Date.now();
  try {
    const selection = getPublishedSystemEventStoreSelection();
    const watcherStorePath =
      params.watcherStorePath !== undefined
        ? params.watcherStorePath
        : (resolveSystemEventStorePath({
            sessionKey: params.watcherSessionKey,
            env: options.env,
          }) ?? null);
    if (!isSystemEventStoreCurrent({ sessionKey: params.watcherSessionKey }, watcherStorePath)) {
      recordSystemEventStoreReplaced();
      return false;
    }
    const sameStorePath = createOpenClawAgentDatabasePathMatcher();
    let registered = false;
    runOpenClawStateWriteTransaction(({ db }) => {
      deferSqlitePostCommitPublication(db, () =>
        rememberSystemEventStoreWatcher(params.watcherSessionKey, watcherStorePath, selection),
      );
      // Re-watching must not clobber pending-notice cursor state.
      const existing = readCursor(db, params.watcherSessionKey, params.targetSessionKey);
      if (
        existing?.watcher_store_path &&
        watcherStorePath &&
        sameStorePath(existing.watcher_store_path, watcherStorePath)
      ) {
        if (existing.provenance !== SESSION_WATCH_PROVENANCE_EXPLICIT) {
          executeSqliteQuerySync(
            db,
            getSessionStateKysely(db)
              .updateTable("session_watch_cursors")
              .set({ provenance: SESSION_WATCH_PROVENANCE_EXPLICIT })
              .where("watcher_session_key", "=", params.watcherSessionKey)
              .where("target_session_key", "=", params.targetSessionKey),
          );
        }
        registered = true;
        return;
      }
      const agentId = params.targetAgentId ?? resolveAgentIdFromSessionKey(params.targetSessionKey);
      const head = executeSqliteQueryTakeFirstSync(
        db,
        getSessionStateKysely(db)
          .selectFrom("session_state_heads")
          .select("last_sequence")
          .where("session_key", "=", params.targetSessionKey)
          .where("agent_id", "=", agentId),
      );
      // Seed at the current head: the watcher is synced now; only future changes notify.
      upsertSeedCursor({
        db,
        watcherSessionKey: params.watcherSessionKey,
        watcherStorePath,
        targetSessionKey: params.targetSessionKey,
        sequence: normalizeOptionalSqliteNumber(head?.last_sequence) ?? 0,
        now,
      });
      registered = true;
    }, options);
    return registered;
  } catch (error) {
    log.warn(`failed to register session state watch: ${String(error)}`);
    return false;
  }
}

/** Register the agent's main session to observe one routed group session. */
export function registerMainSessionGroupWatch(
  params: {
    sessionKey: string;
    agentId: string;
    entry?: SessionEntry;
    mainKey?: string;
    watcherStorePath?: string | null;
  },
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): boolean {
  if (classifySessionKind(params.sessionKey, params.entry) !== "group") {
    return false;
  }
  const watcherSessionKey = buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: params.mainKey,
  });
  // groupScope already chose the routed key: "main" is the watcher itself,
  // while every distinct group key is a per-group target. dmScope is orthogonal.
  if (params.sessionKey === watcherSessionKey) {
    return false;
  }
  const now = options.now ?? Date.now();
  try {
    const selection = getPublishedSystemEventStoreSelection();
    const watcherStorePath =
      params.watcherStorePath !== undefined
        ? params.watcherStorePath
        : (resolveSystemEventStorePath({ sessionKey: watcherSessionKey, env: options.env }) ??
          null);
    if (!isSystemEventStoreCurrent({ sessionKey: watcherSessionKey }, watcherStorePath)) {
      recordSystemEventStoreReplaced();
      return false;
    }
    const sameStorePath = createOpenClawAgentDatabasePathMatcher();
    const { db: readDb } = openOpenClawStateDatabase(options);
    // This runs on every human group turn. Keep the steady-state path read-only;
    // the transaction below is only for first registration and its race recheck.
    const current = readCursor(readDb, watcherSessionKey, params.sessionKey);
    if (
      current?.watcher_store_path &&
      watcherStorePath &&
      sameStorePath(current.watcher_store_path, watcherStorePath)
    ) {
      rememberSystemEventStoreWatcher(watcherSessionKey, watcherStorePath, selection);
      return true;
    }
    let registered = false;
    runOpenClawStateWriteTransaction(({ db }) => {
      deferSqlitePostCommitPublication(db, () =>
        rememberSystemEventStoreWatcher(watcherSessionKey, watcherStorePath, selection),
      );
      const existing = readCursor(db, watcherSessionKey, params.sessionKey);
      if (
        existing?.watcher_store_path &&
        watcherStorePath &&
        sameStorePath(existing.watcher_store_path, watcherStorePath)
      ) {
        // An explicit watch already owns this pair. Do not downgrade it when
        // later human group turns revisit registration.
        registered = true;
        return;
      }
      const head = executeSqliteQueryTakeFirstSync(
        db,
        getSessionStateKysely(db)
          .selectFrom("session_state_heads")
          .select("last_sequence")
          .where("session_key", "=", params.sessionKey)
          .where("agent_id", "=", params.agentId),
      );
      const sequence = normalizeOptionalSqliteNumber(head?.last_sequence) ?? 0;
      upsertSeedCursor({
        db,
        watcherSessionKey,
        watcherStorePath,
        targetSessionKey: params.sessionKey,
        sequence,
        now,
        provenance: SESSION_WATCH_PROVENANCE_AMBIENT_GROUP,
      });
      registered = true;
    }, options);
    return registered;
  } catch (error) {
    log.warn(`failed to register ambient group watch: ${String(error)}`);
    return false;
  }
}
