/** Best-effort durable signal log for session state changes. */
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { resolveSystemEventStorePath } from "../config/sessions/session-store-path.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import {
  captureSystemEventStorePaths,
  getPublishedSystemEventStoreSelection,
  rememberSystemEventStoreWatcher,
} from "../infra/system-event-ownership.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { InputProvenance } from "./input-provenance.js";
import type { SessionStateActorType, SessionStateEventKind } from "./session-state-event-kinds.js";
import {
  getSessionStateKysely,
  isAmbientGroupWatchCursor,
  isNotifiableWatcherKey,
  normalizeOptionalSqliteNumber,
  pruneSessionStateEventsInDatabase,
  readCursor,
  recordSessionStateEventInDatabase,
  type SessionStateEventInput,
  type SessionStateEventRow,
  type SessionStateNotice,
} from "./session-state-events.kernel.js";
import { enqueueSessionStateNotice } from "./session-state-notices.js";
import { deleteSessionUpstreamLink } from "./session-upstream-links.js";

export type { SessionStateActorType } from "./session-state-event-kinds.js";
export {
  listAmbientGroupWatchTargets,
  registerMainSessionGroupWatch,
} from "./session-state-watches.js";

type SessionStateEventRecord = {
  sequence: number;
  sessionKey: string;
  sessionId?: string;
  agentId: string;
  kind: SessionStateEventKind;
  actorType: SessionStateActorType;
  actorId?: string;
  runId?: string;
  occurredAt: number;
  summary: string;
  payload?: Record<string, unknown>;
};

const SESSION_STATE_PRUNE_INTERVAL_MS = 60 * 60_000;
const log = createSubsystemLogger("sessions/state-events");
let lastPruneAt = 0;
let prunePending = false;

function rowToSessionStateEvent(row: SessionStateEventRow): SessionStateEventRecord {
  const payload = row.payload_json ? safeParseJsonRecord(row.payload_json) : undefined;
  return {
    sequence: normalizeSqliteNumber(row.sequence) ?? 0,
    sessionKey: row.session_key,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    agentId: row.agent_id,
    kind: row.kind as SessionStateEventKind,
    actorType: row.actor_type as SessionStateActorType,
    ...(row.actor_id ? { actorId: row.actor_id } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    occurredAt: normalizeSqliteNumber(row.occurred_at) ?? 0,
    summary: row.summary,
    ...(payload ? { payload } : {}),
  };
}

/** Classify the actor once at producer boundaries; missing provenance is interactive human input. */
export function classifySessionStateActor(opts: {
  inputProvenance?: InputProvenance;
  internalEvents?: readonly unknown[];
  sessionEffects?: "visible" | "internal";
  humanActorId?: string;
}): { actorType: SessionStateActorType; actorId?: string } {
  if (opts.inputProvenance?.kind === "inter_session") {
    return {
      actorType: "agent",
      ...(opts.inputProvenance.sourceSessionKey
        ? { actorId: opts.inputProvenance.sourceSessionKey }
        : {}),
    };
  }
  if (
    opts.inputProvenance?.kind === "internal_system" ||
    (opts.internalEvents?.length ?? 0) > 0 ||
    opts.sessionEffects === "internal"
  ) {
    return { actorType: "system" };
  }
  return { actorType: "human", ...(opts.humanActorId ? { actorId: opts.humanActorId } : {}) };
}

/** Append a signal-log event without allowing signaling failure to fail the originating action. */
export function recordSessionStateEvent(
  input: SessionStateEventInput,
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): SessionStateEventRecord | undefined {
  const now = options.now ?? Date.now();
  try {
    const selection = getPublishedSystemEventStoreSelection();
    const watcherStorePaths = { ...(input.watcherStorePaths ?? captureSystemEventStorePaths()) };
    const explicitWatchers = (input.watcherSessionKeys ?? []).filter(isNotifiableWatcherKey);
    for (const sessionKey of explicitWatchers) {
      if (input.watcherStorePaths === undefined && watcherStorePaths[sessionKey] === undefined) {
        watcherStorePaths[sessionKey] =
          resolveSystemEventStorePath({ sessionKey, env: options.env }) ?? null;
      }
    }
    const result = runOpenClawStateWriteTransaction(({ db }) => {
      const recorded = recordSessionStateEventInDatabase(db, { ...input, watcherStorePaths }, now);
      if (recorded.row && input.kind === "child_spawned") {
        for (const key of explicitWatchers) {
          const storePath = readCursor(db, key, input.sessionKey)?.watcher_store_path ?? null;
          deferSqlitePostCommitPublication(db, () =>
            rememberSystemEventStoreWatcher(key, storePath, selection),
          );
        }
      }
      return recorded;
    }, options);
    for (const notice of result.notices) {
      enqueueSessionStateNotice(notice);
    }
    if (!prunePending && now - lastPruneAt > SESSION_STATE_PRUNE_INTERVAL_MS) {
      pruneSessionStateEvents({ ...options, now });
    }
    return result.row ? rowToSessionStateEvent(result.row) : undefined;
  } catch (error) {
    log.warn(`failed to record session state event: ${String(error)}`);
    return undefined;
  }
}

/** Return the durable signal-log head for one session; degrades to 0 on read failure. */
export function getSessionStateVersion(
  sessionKey: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): number {
  try {
    const { db } = openOpenClawStateDatabase(options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_state_heads")
        .select("last_sequence")
        .where("session_key", "=", sessionKey)
        .where("agent_id", "=", agentId),
    );
    return normalizeOptionalSqliteNumber(row?.last_sequence) ?? 0;
  } catch (error) {
    // Best-effort log: enrichment reads must never fail core session tools.
    log.warn(`failed to read session state version: ${String(error)}`);
    return 0;
  }
}

/** Batch durable signal-log heads for session-list enrichment, keyed agent → session key. */
export function getSessionStateVersions(
  refs: ReadonlyArray<{ sessionKey: string; agentId: string }>,
  options: OpenClawStateDatabaseOptions = {},
): Record<string, Record<string, number>> {
  const keys = [...new Set(refs.map((ref) => ref.sessionKey).filter(Boolean))];
  if (keys.length === 0) {
    return {};
  }
  const byAgent: Record<string, Record<string, number>> = {};
  try {
    const { db } = openOpenClawStateDatabase(options);
    // Chunk IN() binds: sessions_list accepts arbitrary limits and SQLite caps
    // host parameters per statement.
    for (let offset = 0; offset < keys.length; offset += 500) {
      const rows = executeSqliteQuerySync(
        db,
        getSessionStateKysely(db)
          .selectFrom("session_state_heads")
          .select(["session_key", "agent_id", "last_sequence"])
          .where("session_key", "in", keys.slice(offset, offset + 500)),
      ).rows;
      for (const row of rows) {
        (byAgent[row.agent_id] ??= {})[row.session_key] =
          normalizeSqliteNumber(row.last_sequence) ?? 0;
      }
    }
  } catch (error) {
    // Best-effort log: enrichment reads must never fail core session tools.
    log.warn(`failed to read session state versions: ${String(error)}`);
  }
  return byAgent;
}

/** List retained signal-log events after a version without advancing watcher cursors. */
export function listSessionStateEventsSince(
  sessionKey: string,
  agentId: string,
  afterSequence: number,
  limit = 200,
  options: OpenClawStateDatabaseOptions = {},
): {
  events: SessionStateEventRecord[];
  truncated: boolean;
  earliestAvailableSequence: number;
  historyGap: boolean;
} {
  try {
    const boundedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const { db } = openOpenClawStateDatabase(options);
    const kysely = getSessionStateKysely(db);
    const rows = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("session_state_events")
        .selectAll()
        .where("session_key", "=", sessionKey)
        .where("agent_id", "=", agentId)
        .where("sequence", ">", afterSequence)
        .orderBy("sequence", "asc")
        .limit(boundedLimit + 1),
    ).rows;
    const earliest = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("session_state_events")
        .select((eb) => eb.fn.min<number>("sequence").as("sequence"))
        .where("session_key", "=", sessionKey)
        .where("agent_id", "=", agentId),
    );
    const headRow = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("session_state_heads")
        .select(["last_sequence", "pruned_max_sequence"])
        .where("session_key", "=", sessionKey)
        .where("agent_id", "=", agentId),
    );
    const head = normalizeOptionalSqliteNumber(headRow?.last_sequence) ?? 0;
    const prunedMax = normalizeOptionalSqliteNumber(headRow?.pruned_max_sequence) ?? 0;
    const earliestAvailableSequence =
      normalizeOptionalSqliteNumber(earliest?.sequence) ?? (head > 0 ? head + 1 : 0);
    return {
      events: rows.slice(0, boundedLimit).map(rowToSessionStateEvent),
      truncated: rows.length > boundedLimit,
      earliestAvailableSequence,
      // Sequences are globally sparse, so distance from earliest retained proves nothing.
      // Only the per-session pruned watermark stamped by pruneSessionStateEvents can say
      // whether events this cursor never saw were actually removed.
      historyGap: afterSequence < prunedMax,
    };
  } catch (error) {
    // Best-effort log: enrichment reads must never fail core session tools.
    log.warn(`failed to list session state events: ${String(error)}`);
    return { events: [], truncated: false, earliestAvailableSequence: 0, historyGap: false };
  }
}

/** Ack only the frozen notice watermark; advancing to head would lose an interleaved event. */
export function acknowledgeSessionStateNotices(
  watcherSessionKey: string,
  targetSessionKeys: readonly string[],
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  const followups: SessionStateNotice[] = [];
  try {
    const watcherStorePath = resolveSystemEventStorePath({
      sessionKey: watcherSessionKey,
      env: options.env,
    });
    const sameStorePath = createOpenClawAgentDatabasePathMatcher();
    runOpenClawStateWriteTransaction(({ db }) => {
      for (const targetSessionKey of new Set(targetSessionKeys)) {
        const row = readCursor(db, watcherSessionKey, targetSessionKey);
        if (
          !row?.watcher_store_path ||
          !watcherStorePath ||
          !sameStorePath(row.watcher_store_path, watcherStorePath)
        ) {
          continue;
        }
        const notified = normalizeSqliteNumber(row.notified_sequence) ?? 0;
        const material = normalizeSqliteNumber(row.material_sequence) ?? 0;
        const nextNotified = material > notified ? material : notified;
        executeSqliteQuerySync(
          db,
          getSessionStateKysely(db)
            .updateTable("session_watch_cursors")
            .set({
              last_seen_sequence: notified,
              notified_sequence: nextNotified,
              updated_at: now,
            })
            .where("watcher_session_key", "=", watcherSessionKey)
            .where("target_session_key", "=", targetSessionKey),
        );
        if (material > notified) {
          followups.push({
            watcherSessionKey,
            watcherStorePath: row.watcher_store_path,
            targetSessionKey,
            lastSeenSequence: notified,
            queueOnly: isAmbientGroupWatchCursor(row),
          });
        }
      }
    }, options);
    for (const followup of followups) {
      enqueueSessionStateNotice(followup);
    }
  } catch (error) {
    log.warn(`failed to acknowledge session state notices: ${String(error)}`);
  }
}

/** Reset parent-side assumptions while retaining target history across session incarnations. */
export function handleSessionStateSessionReset(
  sessionKey: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      executeSqliteQuerySync(
        db,
        getSessionStateKysely(db)
          .deleteFrom("session_watch_cursors")
          .where("watcher_session_key", "=", sessionKey),
      );
    }, options);
  } catch (error) {
    log.warn(`failed to reset session state cursors: ${String(error)}`);
  }
}

/** Delete all signal-log and cursor state owned by a deleted session key. */
export function handleSessionStateSessionDeleted(
  sessionKey: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  deleteSessionUpstreamLink(sessionKey, agentId, options);
  try {
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getSessionStateKysely(db);
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("session_state_events")
          .where("session_key", "=", sessionKey)
          .where("agent_id", "=", agentId),
      );
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("session_state_heads")
          .where("session_key", "=", sessionKey)
          .where("agent_id", "=", agentId),
      );
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("session_watch_cursors")
          .where((eb) =>
            eb.or([
              eb("watcher_session_key", "=", sessionKey),
              eb("target_session_key", "=", sessionKey),
            ]),
          ),
      );
    }, options);
  } catch (error) {
    log.warn(`failed to delete session state history: ${String(error)}`);
  }
}

function sessionExists(sessionKey: string, storePath: string, env?: NodeJS.ProcessEnv): boolean {
  try {
    return Boolean(loadSessionEntryReadOnly({ sessionKey, storePath, clone: false, env }));
  } catch {
    return false;
  }
}

/** Re-materialize pending notices after the in-memory queue is lost on restart. */
export function sweepSessionStateWatchNotices(
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  try {
    const { db } = openOpenClawStateDatabase(options);
    const pendingRows = executeSqliteQuerySync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_watch_cursors")
        .selectAll()
        .whereRef("material_sequence", ">", "last_seen_sequence"),
    ).rows.filter((row) => {
      const storePath = row.watcher_store_path ?? null;
      return storePath === null || sessionExists(row.watcher_session_key, storePath, options.env);
    });
    runOpenClawStateWriteTransaction(({ db: writeDb }) => {
      for (const row of pendingRows) {
        executeSqliteQuerySync(
          writeDb,
          getSessionStateKysely(writeDb)
            .updateTable("session_watch_cursors")
            .set({ notified_sequence: row.material_sequence, updated_at: now })
            .where("watcher_session_key", "=", row.watcher_session_key)
            .where("target_session_key", "=", row.target_session_key),
        );
      }
    }, options);
    for (const row of pendingRows) {
      enqueueSessionStateNotice({
        watcherSessionKey: row.watcher_session_key,
        watcherStorePath: row.watcher_store_path ?? null,
        targetSessionKey: row.target_session_key,
        lastSeenSequence: normalizeSqliteNumber(row.last_seen_sequence) ?? 0,
        queueOnly: isAmbientGroupWatchCursor(row),
      });
    }
    pruneSessionStateEvents({ ...options, now });
  } catch (error) {
    log.warn(`failed to sweep session state notices: ${String(error)}`);
  }
}

/** Enforce bounded retained history without regressing durable per-session heads. */
function pruneSessionStateEvents(
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): void {
  const now = options.now ?? Date.now();
  try {
    runOpenClawStateWriteTransaction(
      ({ db }) => pruneSessionStateEventsInDatabase(db, now),
      options,
    );
    lastPruneAt = now;
  } catch (error) {
    log.warn(`failed to prune session state history: ${String(error)}`);
  }
}

/** Record one successful compaction from the two concrete v1 owners. */
export function recordSessionCompacted(params: {
  sessionKey?: string;
  operationId: string;
  sessionId?: string;
  agentId?: string;
  runId?: string;
}): void {
  if (!params.sessionKey) {
    return;
  }
  // Native-harness-only compaction remains log-incomplete in v1; this signal is reconciliation aid.
  recordSessionStateEvent({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
    kind: "compacted",
    actorType: "system",
    runId: params.runId,
    dedupeKey: `compacted:${params.operationId}`,
    summary: "session compacted",
  });
}

/** Record a persisted goal mutation using lineage already available at the session-store seam. */
export async function recordSessionGoalChanged(params: {
  sessionKey: string;
  entry: SessionEntry;
  actor?: { type: SessionStateActorType; id?: string };
  agentId?: string;
  summary: string;
  watcherStorePaths: Readonly<Record<string, string | null>>;
}): Promise<void> {
  try {
    const context = captureOpenClawStateWorkerContext();
    const now = Date.now();
    const watcherSessionKey = params.entry.spawnedBy ?? params.entry.parentSessionKey;
    // Bare "global" does not encode its store owner; carry the producer's resolved agent.
    const input = {
      sessionKey: params.sessionKey,
      sessionId: params.entry.sessionId,
      agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
      kind: "goal_changed",
      actorType: params.actor?.type ?? "system",
      ...(params.actor?.id ? { actorId: params.actor.id } : {}),
      summary: params.summary,
      ...(watcherSessionKey ? { watcherSessionKeys: [watcherSessionKey] } : {}),
      watcherStorePaths: params.watcherStorePaths,
    } satisfies SessionStateEventInput & { kind: "goal_changed" };
    await runOpenClawStateWorkerOperation(context, async (scope) => {
      const notices = await scope.execute({
        type: "sessionState.recordGoalChange",
        input: { event: input, now },
      });
      for (const notice of notices) {
        enqueueSessionStateNotice(notice);
      }
      if (!prunePending && now - lastPruneAt > SESSION_STATE_PRUNE_INTERVAL_MS) {
        prunePending = true;
        try {
          await scope.execute({ type: "sessionState.prune", input: { now } });
          // A synchronous sweep may have completed while this operation was awaiting its worker.
          lastPruneAt = Math.max(lastPruneAt, now);
        } catch (error) {
          log.warn(`failed to prune session state history: ${String(error)}`);
        } finally {
          prunePending = false;
        }
      }
    });
  } catch (error) {
    // Goal persistence already succeeded; neither an uncertain event nor logging may replace it.
    try {
      log.warn(`failed to record session state event: ${String(error)}`);
    } catch {
      // Keep the originating durable result even when the diagnostic sink fails.
    }
  }
}

/** True when any seeded or explicitly registered watcher cursor targets this session. */
function hasSessionStateWatchers(
  targetSessionKey: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  try {
    const { db } = openOpenClawStateDatabase(options);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getSessionStateKysely(db)
        .selectFrom("session_watch_cursors")
        .select("watcher_session_key")
        .where("target_session_key", "=", targetSessionKey)
        .limit(1),
    );
    return row !== undefined;
  } catch (error) {
    // Best-effort log: enrichment reads must never fail core session tools.
    log.warn(`failed to probe session state watchers: ${String(error)}`);
    return false;
  }
}

export function recordSessionHumanDirectMessage(
  params: {
    sessionKey: string;
    entry?: SessionEntry;
    agentId?: string;
    actor: { actorType: SessionStateActorType; actorId?: string };
    channel?: string;
    runId?: string;
    dedupeKey?: string;
    payload?: Record<string, unknown>;
    occurredAt?: number;
    watcherStorePaths: Readonly<Record<string, string | null>>;
  },
  options: OpenClawStateDatabaseOptions & { now?: number } = {},
): SessionStateEventRecord | undefined {
  const watcherSessionKey = params.entry?.spawnedBy ?? params.entry?.parentSessionKey;
  if (params.actor.actorType !== "human") {
    return undefined;
  }
  // One indexed watcher probe keeps ordinary un-watched human turns write-free.
  if (!watcherSessionKey && !hasSessionStateWatchers(params.sessionKey, options)) {
    return undefined;
  }
  return recordSessionStateEvent(
    {
      sessionKey: params.sessionKey,
      sessionId: params.entry?.sessionId,
      agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
      kind: "human_direct_message",
      actorType: "human",
      ...(params.actor.actorId ? { actorId: params.actor.actorId } : {}),
      runId: params.runId,
      ...(params.dedupeKey ? { dedupeKey: params.dedupeKey } : {}),
      summary: `human message via ${params.channel?.trim() || "unknown"}`,
      payload: params.payload,
      ...(params.occurredAt === undefined ? {} : { occurredAt: params.occurredAt }),
      ...(watcherSessionKey ? { watcherSessionKeys: [watcherSessionKey] } : {}),
      watcherStorePaths: params.watcherStorePaths,
    },
    options,
  );
}

/** Seed the parent cursor at the child-spawn version. */
export function recordSubagentSpawned(params: {
  childSessionKey: string;
  childRunId: string;
  requesterSessionKey: string;
  agentId: string;
  watcherStorePath?: string;
}): void {
  recordSessionStateEvent({
    sessionKey: params.childSessionKey,
    agentId: params.agentId,
    kind: "child_spawned",
    actorType: "agent",
    actorId: params.requesterSessionKey,
    runId: params.childRunId,
    dedupeKey: `child-spawned:${params.childRunId}`,
    summary: "child session spawned",
    watcherSessionKeys: [params.requesterSessionKey],
    ...(params.watcherStorePath
      ? { watcherStorePaths: { [params.requesterSessionKey]: params.watcherStorePath } }
      : {}),
  });
}

type SubagentTerminalStatus = "ok" | "error" | "timeout" | "cancelled";

const SUBAGENT_TERMINAL_SUMMARY: Record<SubagentTerminalStatus, string> = {
  ok: "child run completed",
  error: "child run failed",
  timeout: "child run timed out",
  cancelled: "child run cancelled",
};

/** Project an already-normalized subagent terminal outcome into the signal log. */
export function recordSubagentTerminalState(params: {
  childSessionKey: string;
  runId: string;
  requesterSessionKey: string;
  outcomeStatus: SubagentTerminalStatus;
}): void {
  // Non-ok statuses share kind run_failed: the closed kind union mirrors the sibling
  // SubagentRunOutcome status projection, which also folds cancel/timeout into error
  // status. The precise outcome survives in payload for changesSince consumers.
  recordSessionStateEvent({
    sessionKey: params.childSessionKey,
    agentId: resolveAgentIdFromSessionKey(params.childSessionKey),
    kind: params.outcomeStatus === "ok" ? "run_completed" : "run_failed",
    actorType: "system",
    runId: params.runId,
    dedupeKey: `run-terminal:${params.runId}`,
    summary: SUBAGENT_TERMINAL_SUMMARY[params.outcomeStatus],
    ...(params.outcomeStatus === "ok" ? {} : { payload: { outcome: params.outcomeStatus } }),
    watcherSessionKeys: [params.requesterSessionKey],
  });
}
