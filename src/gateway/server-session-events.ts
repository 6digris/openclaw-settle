// Gateway session event broadcaster.
// Projects transcript and lifecycle updates to websocket subscribers.
import path from "node:path";
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  readTranscriptDisplayPosition,
  type TranscriptDisplayPosition,
} from "../chat/transcript-display-position.js";
import { getRuntimeConfig } from "../config/io.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { isSessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { SessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type { InternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { projectChatDisplayMessage } from "./chat-display-projection.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { hasSessionChangeReceivers } from "./session-change-receivers.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import {
  resolveSessionEventAgentScope,
  type SessionEventAgentScope,
} from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";
import {
  readSessionMessageByIdAsync,
  readSessionMessageCountAsync,
} from "./session-transcript-readers.js";

type SessionEventSubscribers = Pick<SessionEventSubscriberRegistry, "getAll">;
type SessionMessageSubscribers = Pick<SessionMessageSubscriberRegistry, "get">;

function readTranscriptUpdateLifecycleOwner(
  update: InternalSessionTranscriptUpdate,
  projection: SessionRowProjection | undefined,
): { lifecycleRevision?: string } | undefined {
  const marker = parseSqliteSessionFileMarker(update.sessionFile);
  const sessionKey =
    normalizeOptionalString(update.target?.sessionKey) ??
    normalizeOptionalString(update.sessionKey) ??
    (marker ? projection?.findBySessionId(marker)[0]?.key : undefined);
  if (!sessionKey) {
    return undefined;
  }
  const agentId =
    normalizeOptionalString(update.target?.agentId) ??
    normalizeOptionalString(update.agentId) ??
    marker?.agentId;
  const sessionId =
    normalizeOptionalString(update.target?.sessionId) ??
    normalizeOptionalString(update.sessionId) ??
    marker?.sessionId;
  const storePath = normalizeOptionalString(update.target?.storePath) ?? marker?.storePath;
  const scope = resolveSessionEventAgentScope(getRuntimeConfig(), sessionKey, agentId);
  const entry = scope
    ? projection?.capture({ agentId: scope.agentId, key: scope.sessionKey, storePath })?.entry
    : undefined;
  if (!entry || (sessionId && entry.sessionId !== sessionId)) {
    return undefined;
  }
  const lifecycleRevision = normalizeOptionalString(entry.lifecycleRevision);
  return lifecycleRevision ? { lifecycleRevision } : {};
}

/** Creates a serialized transcript-update broadcaster for session websocket clients. */
export function createTranscriptUpdateBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
  sessionMessageSubscribers: SessionMessageSubscribers;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
}) {
  // Ordering is a per-transcript contract: subscribers merge each session's
  // updates independently, so lanes keyed by transcript identity keep message
  // order without one session's async seq reads stalling every other session.
  const broadcastQueues = new Map<string, Promise<void>>();
  return (update: InternalSessionTranscriptUpdate): Promise<void> => {
    const projection = params.getSessionRowProjection?.();
    // Capture legacy ownership before the async queue can cross a same-id reset;
    // committed producer ownership always wins over a later session-store read.
    const lifecycleRevision =
      normalizeOptionalString(update.lifecycleRevision) ??
      (update.message !== undefined
        ? readTranscriptUpdateLifecycleOwner(update, projection)?.lifecycleRevision
        : undefined);
    const legacyMarker = parseSqliteSessionFileMarker(update.sessionFile);
    const sessionKey =
      normalizeOptionalString(update.target?.sessionKey) ??
      normalizeOptionalString(update.sessionKey) ??
      (legacyMarker ? projection?.findBySessionId(legacyMarker)[0]?.key : undefined);
    const agentId =
      normalizeOptionalString(update.target?.agentId) ??
      normalizeOptionalString(update.agentId) ??
      legacyMarker?.agentId;
    const agentScope = sessionKey
      ? resolveSessionEventAgentScope(getRuntimeConfig(), sessionKey, agentId)
      : undefined;
    if (agentScope === null) {
      return Promise.resolve();
    }
    const queuedUpdate = {
      ...update,
      ...(update.sessionKey ? agentScope : {}),
      ...(update.target && agentScope ? { target: { ...update.target, ...agentScope } } : {}),
      ...(lifecycleRevision ? { lifecycleRevision } : {}),
    };
    const laneKey = agentScope?.sessionKey ?? normalizeOptionalString(update.sessionFile) ?? "";
    // Preserve transcript update order within the lane even when counting
    // messages requires an async read from the session file.
    const tail = broadcastQueues.get(laneKey) ?? Promise.resolve();
    const task = tail.then(async () => {
      if (projection) {
        do {
          await projection.ensureMaterialized();
        } while (projection.needsMaterialization);
      }
      return handleTranscriptUpdateBroadcast(params, queuedUpdate, agentScope, projection);
    });
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    broadcastQueues.set(laneKey, settled);
    void settled.then(() => {
      // Drop drained lanes so idle sessions do not accumulate map entries.
      if (broadcastQueues.get(laneKey) === settled) {
        broadcastQueues.delete(laneKey);
      }
    });
    return task;
  };
}

async function handleTranscriptUpdateBroadcast(
  params: {
    broadcastToConnIds: GatewayBroadcastToConnIdsFn;
    sessionEventSubscribers: SessionEventSubscribers;
    sessionMessageSubscribers: SessionMessageSubscribers;
    chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  },
  update: InternalSessionTranscriptUpdate,
  capturedAgentScope: SessionEventAgentScope | undefined,
  projection: SessionRowProjection | undefined,
): Promise<void> {
  const legacyMarker = parseSqliteSessionFileMarker(update.sessionFile);
  const targetAgentId = normalizeOptionalString(update.target?.agentId);
  const targetSessionId = normalizeOptionalString(update.target?.sessionId);
  const targetSessionKey = normalizeOptionalString(update.target?.sessionKey);
  const suppliedSessionKey = normalizeOptionalString(update.sessionKey);
  const candidateSessionKey = targetSessionKey ?? suppliedSessionKey;
  const targetKeyAgentId = parseAgentSessionKey(candidateSessionKey)?.agentId;
  const targetStorePath = normalizeOptionalString(update.target?.storePath);
  const completeTarget = Boolean(
    targetAgentId && targetSessionId && targetSessionKey && targetStorePath,
  );
  const markerMatches =
    legacyMarker && !completeTarget ? (projection?.findBySessionId(legacyMarker) ?? []) : [];
  const candidateKeyEntry =
    candidateSessionKey && legacyMarker && !completeTarget
      ? projection?.capture({
          agentId: legacyMarker.agentId,
          key: candidateSessionKey,
          storePath: legacyMarker.storePath,
        })?.entry
      : undefined;
  if (targetKeyAgentId && targetAgentId && targetKeyAgentId !== targetAgentId) {
    return;
  }
  if (
    legacyMarker &&
    !completeTarget &&
    ((targetAgentId && targetAgentId !== legacyMarker.agentId) ||
      (targetSessionId &&
        targetSessionId !== legacyMarker.sessionId &&
        candidateKeyEntry?.sessionId !== legacyMarker.sessionId) ||
      (targetKeyAgentId && targetKeyAgentId !== legacyMarker.agentId) ||
      (candidateSessionKey &&
        ((candidateKeyEntry && candidateKeyEntry.sessionId !== legacyMarker.sessionId) ||
          (!candidateKeyEntry && markerMatches.length > 0))) ||
      (targetStorePath && path.resolve(targetStorePath) !== path.resolve(legacyMarker.storePath)))
  ) {
    return;
  }
  const compatibleLegacyMarker = completeTarget ? undefined : legacyMarker;
  const resolvedSessionKey = compatibleLegacyMarker
    ? candidateKeyEntry?.sessionId === compatibleLegacyMarker.sessionId ||
      (!candidateKeyEntry && markerMatches.length === 0)
      ? candidateSessionKey
      : markerMatches[0]?.key
    : candidateSessionKey;
  if (!resolvedSessionKey) {
    return;
  }
  const agentScope =
    (candidateSessionKey ? capturedAgentScope : undefined) ??
    resolveSessionEventAgentScope(
      getRuntimeConfig(),
      resolvedSessionKey,
      compatibleLegacyMarker?.agentId ?? targetAgentId ?? update.agentId,
    );
  if (!agentScope) {
    return;
  }
  const { agentId, sessionKey } = agentScope;
  const connIds = new Set<string>();
  for (const connId of params.sessionEventSubscribers.getAll()) {
    connIds.add(connId);
  }
  for (const connId of params.sessionMessageSubscribers.get(sessionKey)) {
    connIds.add(connId);
  }
  if (connIds.size === 0) {
    if (
      !hasSessionChangeReceivers(connIds) ||
      (update.message !== undefined && projectChatDisplayMessage(update.message))
    ) {
      return;
    }
  }
  const lifecycleRevision = normalizeOptionalString(update.lifecycleRevision);
  let message = update.message;
  let messageSeq = asPositiveSafeInteger(update.messageSeq);
  let transcriptPosition: TranscriptDisplayPosition | undefined;
  if (message !== undefined && update.messageId && completeTarget && targetSessionId) {
    // A queued append can cross a rewrite. Read content and placement together;
    // never attach a new generation to the producer's stale queued payload.
    try {
      const stored = await readSessionMessageByIdAsync(
        {
          agentId: targetAgentId,
          sessionId: targetSessionId,
          sessionKey,
          storePath: targetStorePath,
        },
        update.messageId,
      );
      message = stored.message;
      messageSeq = stored.seq;
      transcriptPosition = readTranscriptDisplayPosition(
        asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.transcriptPosition,
      );
    } catch (error) {
      if (!isSessionTranscriptProjectionUnavailableError(error)) {
        throw error;
      }
      message = undefined;
    }
  } else if (message !== undefined && messageSeq === undefined) {
    // Updates from raw transcript events may not carry seq; fall back to the
    // current transcript line count for cursor-compatible live history.
    const updateStorePath = targetStorePath ?? compatibleLegacyMarker?.storePath;
    const fallbackTarget = projection?.selectEntries({
      agentId,
      key: sessionKey,
      storePath: updateStorePath,
    })[0];
    const entry = fallbackTarget?.entry;
    const messageSessionId =
      compatibleLegacyMarker?.sessionId ??
      normalizeOptionalString(update.target?.sessionId) ??
      entry?.sessionId;
    const storePath = updateStorePath ?? fallbackTarget?.storeTarget.storePath;
    messageSeq = messageSessionId
      ? asPositiveSafeInteger(
          await readSessionMessageCountAsync({
            agentId: update.target?.agentId ?? agentId,
            sessionEntry: entry,
            sessionId: messageSessionId,
            sessionKey,
            storePath,
          }),
        )
      : undefined;
  }
  if (projection) {
    do {
      await projection.ensureMaterialized();
    } while (projection.needsMaterialization);
  }
  if (lifecycleRevision) {
    // A reset can retain sessionId, so validate the captured owner after every
    // awaited transcript read before projecting the current session snapshot.
    const currentLifecycleOwner = readTranscriptUpdateLifecycleOwner(update, projection);
    if (
      !currentLifecycleOwner ||
      (currentLifecycleOwner.lifecycleRevision &&
        currentLifecycleOwner.lifecycleRevision !== lifecycleRevision)
    ) {
      return;
    }
  }
  const sessionRow = projection?.snapshot({
    key: sessionKey,
    agentId,
    storePath: targetStorePath,
  }).row;
  const activeRunState = sessionRow
    ? resolveVisibleActiveSessionRunState({
        context: params,
        requestedKey: sessionKey,
        canonicalKey: sessionRow.key,
        sessionId: sessionRow.sessionId,
        agentId,
        projectedAgentRunIndex: projection?.state.rowContext.projectedAgentRuns,
      })
    : null;
  const sessionSnapshot = buildGatewaySessionSnapshot({
    sessionRow,
    agentId,
    includeSession: true,
    activeRunState,
  });
  if (message === undefined) {
    // A committed batch or unavailable selected row must invalidate
    // both session-list and targeted transcript subscribers exactly once.
    params.broadcastToConnIds(
      "sessions.changed",
      {
        sessionKey,
        agentId,
        phase: "message",
        ts: Date.now(),
        ...sessionSnapshot,
      },
      connIds,
    );
    return;
  }
  const projected = projectSessionMessagePayload({
    sessionKey,
    agentId,
    message,
    transcriptPosition,
    ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
    ...(messageSeq !== undefined ? { messageSeq } : {}),
    ...(update.runId ? { runId: update.runId } : {}),
    sessionSnapshot,
  });
  if (projected.payload) {
    params.broadcastToConnIds("session.message", projected.payload, connIds);
    return;
  }

  // Messages suppressed from display can still change transcript state, so
  // notify broad session listeners even when no session.message is emitted.
  const sessionEventConnIds = params.sessionEventSubscribers.getAll();
  if (!hasSessionChangeReceivers(sessionEventConnIds)) {
    return;
  }
  params.broadcastToConnIds(
    "sessions.changed",
    {
      sessionKey,
      agentId,
      phase: "message",
      ts: Date.now(),
      ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
      ...(messageSeq !== undefined ? { messageSeq } : {}),
      ...sessionSnapshot,
    },
    sessionEventConnIds,
    { dropIfSlow: true },
  );
}

/** Creates a lifecycle-event broadcaster for session list refreshes. */
export function createLifecycleEventBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  getSessionRowProjection?: () => SessionRowProjection | undefined;
}) {
  return async (event: SessionLifecycleEvent): Promise<void> => {
    const connIds = params.sessionEventSubscribers.getAll();
    if (!hasSessionChangeReceivers(connIds)) {
      return;
    }
    const cfg = getRuntimeConfig();
    const agentScope = resolveSessionEventAgentScope(
      cfg,
      event.sessionKey,
      normalizeOptionalString(event.agentId),
    );
    if (!agentScope) {
      return;
    }
    const { agentId, sessionKey } = agentScope;
    const parentSessionKey = event.parentSessionKey
      ? resolveStoredSessionKeyForAgentStore({ cfg, sessionKey: event.parentSessionKey, agentId })
      : undefined;
    const broadcastOptions = { agentId, sessionKeys: [sessionKey], dropIfSlow: true };
    // Key-only lifecycle deletes invalidate membership; a later row is not deletion evidence.
    if (event.reason === "delete") {
      params.broadcastToConnIds(
        "sessions.changed",
        {
          sessionKey,
          agentId,
          reason: event.reason,
          ...(event.catalogChanged ? { catalogChanged: true } : {}),
          ts: Date.now(),
        },
        connIds,
        broadcastOptions,
      );
      return;
    }
    const projection = params.getSessionRowProjection?.();
    const query = { key: sessionKey, agentId };
    const captured = projection?.capture(query);
    const readActiveState = (session: { key: string; sessionId?: string }) =>
      resolveVisibleActiveSessionRunState({
        context: params,
        requestedKey: sessionKey,
        canonicalKey: session.key,
        sessionId: session.sessionId,
        agentId,
        // Capacity transitions retain their synchronous memory edge before row preparation.
        projectedAgentRunIndex:
          event.reason === "run-capacity"
            ? undefined
            : projection?.state.rowContext.projectedAgentRuns,
      });
    // Capacity acquisition and release can both occur before row preparation settles.
    const capacityState =
      event.reason === "run-capacity"
        ? readActiveState({
            key: captured?.key ?? sessionKey,
            sessionId: captured?.entry?.sessionId,
          })
        : undefined;
    if (projection) {
      do {
        await projection.ensureMaterialized();
      } while (projection.needsMaterialization);
    }
    if (projection && (!captured || !projection.isCurrent(captured))) {
      return;
    }
    const sessionRow = projection?.snapshot(query).row;
    const activeRunState = capacityState ?? (sessionRow ? readActiveState(sessionRow) : null);
    params.broadcastToConnIds(
      "sessions.changed",
      {
        sessionKey,
        agentId,
        reason: event.reason,
        ...(event.catalogChanged ? { catalogChanged: true } : {}),
        parentSessionKey,
        label: event.label,
        displayName: event.displayName,
        ts: Date.now(),
        ...buildGatewaySessionSnapshot({
          sessionRow,
          includeSession: true,
          agentId,
          label: event.label,
          displayName: event.displayName,
          parentSessionKey,
          activeRunState,
        }),
        ...(event.swarmGroupId
          ? {
              swarmGroupId: event.swarmGroupId,
              kind: event.kind,
              text: event.text,
            }
          : {}),
      },
      connIds,
      broadcastOptions,
    );
  };
}
