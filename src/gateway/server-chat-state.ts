import type { AgentPlanStep } from "../channels/streaming.js";
// Gateway chat run state registries.
// Tracks active runs, delta buffers, tool recipients, and session subscribers.
import type { AgentEventPayload } from "../infra/agent-events.js";
import type { AssistantTextSnapshot } from "./agent-event-assistant-text.js";
import type { ChatCanvasBlock } from "./chat-display-projection.canvas.js";
import {
  normalizeLiveAssistantBufferedText,
  projectLiveAssistantBufferedText,
} from "./live-chat-projector.js";
import type { ChatRunProgressSnapshot } from "./server-chat-progress-snapshot.js";
import { updateChatRunProgressSnapshot } from "./server-chat-progress-snapshot.js";

export type ChatRunTiming = {
  ackedAtMs: number;
  connId: string;
  dispatchStartedAtMs?: number;
  firstAssistantEventSent?: boolean;
  receivedAtMs: number;
};

export type ChatRunRegistration = {
  sessionKey: string;
  agentId?: string;
  clientRunId: string;
  chatSendTiming?: ChatRunTiming;
};

export type ChatRunEntry = ChatRunRegistration & {
  registeredSequence: number;
};

export type ChatAbortMarker = { abortedAtMs: number; sequence: number };

let chatRunOrderingSequence = 0;

function nextChatRunOrderingSequence(): number {
  chatRunOrderingSequence += 1;
  return chatRunOrderingSequence;
}

/** Stamp a chat run registration with the process-local ordering metadata used for abort freshness checks. */
function createChatRunEntry(entry: ChatRunRegistration): ChatRunEntry {
  return {
    ...entry,
    registeredSequence: nextChatRunOrderingSequence(),
  };
}

/** Create an abort marker ordered against chat run registrations, using a shared monotonic sequence. */
export function createChatAbortMarker(now = Date.now()): ChatAbortMarker {
  return { abortedAtMs: now, sequence: nextChatRunOrderingSequence() };
}

/** Return the wall-clock timestamp used by maintenance TTL pruning. */
export function chatAbortMarkerTimestampMs(marker: ChatAbortMarker): number {
  return marker.abortedAtMs;
}

/**
 * Return whether an abort marker should suppress events for the given chat run registration.
 * The shared monotonic sequence keeps same-millisecond aborts ordered; a missing
 * entry preserves suppress-on-presence behavior.
 */
export function isChatAbortMarkerCurrent(
  marker: ChatAbortMarker | undefined,
  entry?: Pick<ChatRunEntry, "registeredSequence">,
): boolean {
  if (marker === undefined) {
    return false;
  }
  return !entry || marker.sequence >= entry.registeredSequence;
}

export type BufferedAgentEvent = {
  sessionKey?: string;
  agentId?: string;
  controlUiVisible?: boolean;
  isCurrent?: () => boolean;
  payload: AgentEventPayload & { spawnedBy?: string };
};

export type ChatRunPlanSnapshot = {
  steps: AgentPlanStep[];
  explanation?: string;
};

type ChatRunAgentTextState = {
  lastSentAt?: number;
  bufferedEvent?: BufferedAgentEvent;
};

type ChatRunToolRecipientState = {
  connIds: Set<string>;
  updatedAt: number;
  finalizedAt?: number;
};

type PendingLiveTextFlush = {
  timer: NodeJS.Timeout;
  flush: () => void;
};

type ChatRunRecord = {
  registrations?: ChatRunEntry[];
  rawBuffer?: string;
  buffer?: string;
  bufferIsCurrent?: () => boolean;
  /** Retire queued connection snapshots when this buffering generation is cleared. */
  liveTextGroup?: AbortController;
  /** Projection stays valid only while source and managed-media facts match the run state. */
  bufferProjection?: { source: string; suppress: boolean };
  planSnapshot?: ChatRunPlanSnapshot;
  progressSnapshot?: ChatRunProgressSnapshot;
  canvasBlocks?: ChatCanvasBlock[];
  /** Last time any buffered assistant text changed, including suppressed raw buffers. */
  bufferUpdatedAt?: number;
  deltaSentAt?: number;
  assistantScope?: AssistantTextSnapshot["scope"];
  managedMediaUrls?: Set<string>;
  deltaLastBroadcastText?: string;
  agentText?: Partial<
    Record<"assistant" | "thinking" | "preamble" | "answer_candidate", ChatRunAgentTextState>
  >;
  abortMarker?: ChatAbortMarker;
  toolRecipient?: ChatRunToolRecipientState;
  /** Fixed-deadline trailing wake-up owned by this run's buffered state. */
  pendingTextFlushes?: Partial<Record<"chat" | "agent", PendingLiveTextFlush>>;
};

type ChatRunRecordStore = {
  runs: Map<string, ChatRunRecord>;
  getOrCreate: (runId: string) => ChatRunRecord;
  releaseIfEmpty: (runId: string) => void;
};

function createChatRunRecordStore(): ChatRunRecordStore {
  const runs = new Map<string, ChatRunRecord>();
  const getOrCreate = (runId: string) => {
    const existing = runs.get(runId);
    if (existing) {
      return existing;
    }
    const record: ChatRunRecord = {};
    runs.set(runId, record);
    return record;
  };
  const releaseIfEmpty = (runId: string) => {
    const record = runs.get(runId);
    if (!record || Object.keys(record).length > 0) {
      return;
    }
    runs.delete(runId);
  };
  return { runs, getOrCreate, releaseIfEmpty };
}

function clearPendingLiveTextFlushes(record: ChatRunRecord): void {
  for (const pending of Object.values(record.pendingTextFlushes ?? {})) {
    clearTimeout(pending.timer);
  }
  delete record.pendingTextFlushes;
}

export type ChatRunRegistry = {
  add: (sessionId: string, entry: ChatRunRegistration) => void;
  peek: (sessionId: string) => ChatRunEntry | undefined;
  shift: (sessionId: string) => ChatRunEntry | undefined;
  remove: (sessionId: string, clientRunId: string, sessionKey?: string) => ChatRunEntry | undefined;
};

function createChatRunRegistryForStore(store: ChatRunRecordStore): ChatRunRegistry {
  const add = (sessionId: string, entry: ChatRunRegistration) => {
    const registeredEntry = createChatRunEntry(entry);
    const record = store.getOrCreate(sessionId);
    const queue = record.registrations;
    if (queue) {
      queue.push(registeredEntry);
    } else {
      record.registrations = [registeredEntry];
    }
  };

  const peek = (sessionId: string) => store.runs.get(sessionId)?.registrations?.[0];

  const shift = (sessionId: string) => {
    const record = store.runs.get(sessionId);
    if (!record) {
      return undefined;
    }
    const queue = record.registrations;
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const entry = queue.shift();
    if (!queue.length) {
      delete record.registrations;
      store.releaseIfEmpty(sessionId);
    }
    return entry;
  };

  const remove = (sessionId: string, clientRunId: string, sessionKey?: string) => {
    const record = store.runs.get(sessionId);
    if (!record) {
      return undefined;
    }
    const queue = record.registrations;
    if (!queue || queue.length === 0) {
      return undefined;
    }
    const idx = queue.findIndex(
      (entry) =>
        entry.clientRunId === clientRunId && (sessionKey ? entry.sessionKey === sessionKey : true),
    );
    if (idx < 0) {
      return undefined;
    }
    const [entry] = queue.splice(idx, 1);
    if (!queue.length) {
      delete record.registrations;
      store.releaseIfEmpty(sessionId);
    }
    return entry;
  };

  return { add, peek, shift, remove };
}

export type ChatRunState = {
  runs: Map<string, ChatRunRecord>;
  registry: ChatRunRegistry;
  toolEventRecipients: ToolEventRecipientRegistry;
  getOrCreate: (runId: string) => ChatRunRecord;
  resolveBuffer: (
    runId: string,
    options?: { final?: boolean },
  ) => { text: string; suppress: boolean };
  flushPendingText: (runId: string) => void;
  hasAbortMarker: (runId: string) => boolean;
  deleteAbortMarker: (runId: string) => void;
  recordProgressEvent: (runId: string, event: AgentEventPayload, mode?: "full" | "summary") => void;
  clearRun: (runId: string) => void;
  clear: () => void;
};

/** Create the single record map used by Gateway chat-run runtime state. */
export function createChatRunState(): ChatRunState {
  const store = createChatRunRecordStore();
  const registry = createChatRunRegistryForStore(store);
  const toolEventRecipients = createToolEventRecipientRegistryForStore(store);

  const recordProgressEvent = (
    runId: string,
    event: AgentEventPayload,
    mode?: "full" | "summary",
  ) => {
    const progressSnapshot = updateChatRunProgressSnapshot(
      store.runs.get(runId)?.progressSnapshot,
      event,
      mode,
    );
    if (progressSnapshot) {
      store.getOrCreate(runId).progressSnapshot = progressSnapshot;
    }
  };

  const clearRun = (runId: string) => {
    const record = store.runs.get(runId);
    if (!record) {
      return;
    }
    delete record.rawBuffer;
    delete record.buffer;
    delete record.bufferIsCurrent;
    record.liveTextGroup?.abort();
    delete record.liveTextGroup;
    delete record.bufferProjection;
    delete record.planSnapshot;
    delete record.progressSnapshot;
    delete record.canvasBlocks;
    delete record.bufferUpdatedAt;
    delete record.deltaSentAt;
    delete record.assistantScope;
    delete record.managedMediaUrls;
    delete record.deltaLastBroadcastText;
    clearPendingLiveTextFlushes(record);
    delete record.agentText;
    store.releaseIfEmpty(runId);
  };

  const clear = () => {
    for (const record of store.runs.values()) {
      clearPendingLiveTextFlushes(record);
      record.liveTextGroup?.abort();
    }
    store.runs.clear();
  };

  const resolveBuffer = (runId: string, options?: { final?: boolean }) => {
    const record = store.runs.get(runId);
    if (!record || record.bufferIsCurrent?.() === false) {
      return projectLiveAssistantBufferedText("");
    }
    const rawText = record.rawBuffer;
    if (rawText === undefined) {
      return projectLiveAssistantBufferedText(record.buffer ?? "");
    }
    if (
      !options?.final &&
      record.bufferProjection?.source === rawText &&
      record.buffer !== undefined
    ) {
      return {
        text: record.buffer,
        suppress: record.bufferProjection.suppress,
      };
    }
    // Protected blocks and directive tags can span delta frames, so the
    // projection cache belongs to the complete merged raw buffer.
    const normalizedText = normalizeLiveAssistantBufferedText(rawText, {
      ...options,
      managedMediaUrls: record.managedMediaUrls ? [...record.managedMediaUrls] : undefined,
    });
    const projected = projectLiveAssistantBufferedText(normalizedText);
    // A terminal read releases ambiguous directive prefixes as ordinary text;
    // caching it would expose that prefix again if a late live reader races cleanup.
    if (!options?.final) {
      record.buffer = projected.text;
      record.bufferProjection = { source: rawText, suppress: projected.suppress };
    }
    return projected;
  };

  return {
    runs: store.runs,
    registry,
    toolEventRecipients,
    getOrCreate: store.getOrCreate,
    resolveBuffer,
    flushPendingText: (runId) => {
      const record = store.runs.get(runId);
      if (!record) {
        return;
      }
      const pending = Object.values(record.pendingTextFlushes ?? {});
      clearPendingLiveTextFlushes(record);
      for (const flush of pending) {
        flush.flush();
      }
    },
    hasAbortMarker: (runId) => store.runs.get(runId)?.abortMarker !== undefined,
    deleteAbortMarker: (runId) => {
      const record = store.runs.get(runId);
      if (!record) {
        return;
      }
      delete record.abortMarker;
      store.releaseIfEmpty(runId);
    },
    recordProgressEvent,
    clearRun,
    clear,
  };
}

export type ToolEventRecipientRegistry = {
  add: (runId: string, connId: string) => void;
  get: (runId: string) => ReadonlySet<string> | undefined;
  markFinal: (runId: string) => void;
  pruneExpired: (now?: number) => void;
};

export type SessionEventSubscriberRegistry = {
  subscribe: (connId: string) => void;
  unsubscribe: (connId: string) => void;
  getAll: () => ReadonlySet<string>;
};

export type SessionMessageSubscriberRegistry = {
  subscribe: (
    connId: string,
    sessionKey: string,
    opts?: { includeApprovals?: boolean; provisional?: boolean; wireKey?: string },
  ) => SessionMessageSubscription | undefined;
  beginWireSelection: (connId: string, wireKey: string) => SessionWireSelection | undefined;
  getWireKey: (connId: string, sessionKey: string) => string | undefined;
  unsubscribe: (connId: string, sessionKey: string) => void;
  unsubscribeAll: (connId: string) => void;
  get: (sessionKey: string) => ReadonlySet<string>;
  getApprovals: (sessionKey: string) => ReadonlySet<string>;
  onChange: (listener: (sessionKey: string) => void) => () => void;
};

type SessionMessageSubscription = (() => void) & { commit: () => void };

export type SessionWireSelection = {
  key: string;
  accept: (canonicalKey: string) => void;
};

type SessionSubscriptionSelection = {
  sequence: number;
  includeApprovals: boolean;
  wireKey?: string;
};

type SessionConnectionState = {
  committed?: SessionSubscriptionSelection;
  pending: Map<number, SessionSubscriptionSelection>;
  observed?: { sequence: number; key: string };
};

const TOOL_EVENT_RECIPIENT_TTL_MS = 10 * 60 * 1000;
const TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS = 30 * 1000;

/** Create the broad sessions.changed subscriber registry. */
export function createSessionEventSubscriberRegistry(
  isConnectionActive?: (connId: string) => boolean,
): SessionEventSubscriberRegistry {
  const connIds = new Set<string>();
  const empty = new Set<string>();

  return {
    subscribe: (connId: string) => {
      const normalized = connId.trim();
      if (!normalized || isConnectionActive?.(normalized) === false) {
        return;
      }
      connIds.add(normalized);
    },
    unsubscribe: (connId: string) => {
      const normalized = connId.trim();
      if (!normalized) {
        return;
      }
      connIds.delete(normalized);
    },
    getAll: () => (connIds.size > 0 ? connIds : empty),
  };
}

/** Create the per-session message subscriber registry. */
export function createSessionMessageSubscriberRegistry(
  isConnectionActive?: (connId: string) => boolean,
): SessionMessageSubscriberRegistry {
  const sessionToConnIds = new Map<string, Set<string>>();
  // Record identity fences settlements after unsubscribe or connection replacement.
  const connections = new Map<string, Map<string, SessionConnectionState>>();
  const approvalSessionToConnIds = new Map<string, Set<string>>();
  const changeListeners = new Set<(sessionKey: string) => void>();
  const empty = new Set<string>();
  let subscriptionSequence = 0;

  const normalize = (value: string): string => value.trim();
  const setMessageSubscription = (connId: string, sessionKey: string, subscribed: boolean) => {
    const connIds = sessionToConnIds.get(sessionKey);
    const wasSubscribed = connIds?.has(connId) === true;
    if (subscribed) {
      const nextConnIds = connIds ?? new Set<string>();
      nextConnIds.add(connId);
      sessionToConnIds.set(sessionKey, nextConnIds);
      if (!wasSubscribed) {
        for (const listener of changeListeners) {
          listener(sessionKey);
        }
      }
      return;
    }
    connIds?.delete(connId);
    if (connIds?.size === 0) {
      sessionToConnIds.delete(sessionKey);
    }
    if (wasSubscribed) {
      for (const listener of changeListeners) {
        listener(sessionKey);
      }
    }
  };
  const setApprovalSubscription = (connId: string, sessionKey: string, subscribed: boolean) => {
    const connIds = approvalSessionToConnIds.get(sessionKey);
    if (subscribed) {
      const nextConnIds = connIds ?? new Set<string>();
      nextConnIds.add(connId);
      approvalSessionToConnIds.set(sessionKey, nextConnIds);
      return;
    }
    connIds?.delete(connId);
    if (connIds?.size === 0) {
      approvalSessionToConnIds.delete(sessionKey);
    }
  };

  const connection = (connId: string) => {
    if (!connId || isConnectionActive?.(connId) === false) {
      return undefined;
    }
    let states = connections.get(connId);
    if (!states) {
      states = new Map();
      connections.set(connId, states);
    }
    return states;
  };
  const latestSubscription = (state: SessionConnectionState) => {
    let latest = state.committed;
    for (const pending of state.pending.values()) {
      if (!latest || pending.sequence > latest.sequence) {
        latest = pending;
      }
    }
    return latest;
  };
  const registry: SessionMessageSubscriberRegistry = {
    beginWireSelection: (connId, wireKey) => {
      const normalizedConnId = normalize(connId);
      const states = connection(normalizedConnId);
      if (!states) {
        return undefined;
      }
      const observed = { sequence: ++subscriptionSequence, key: wireKey.trim() };
      return {
        key: observed.key,
        accept: (canonicalKey) => {
          if (
            connections.get(normalizedConnId) !== states ||
            isConnectionActive?.(normalizedConnId) === false
          ) {
            return;
          }
          const state: SessionConnectionState = states.get(canonicalKey) ?? { pending: new Map() };
          if (!state.observed || state.observed.sequence < observed.sequence) {
            state.observed = observed;
            states.set(canonicalKey, state);
          }
        },
      };
    },
    getWireKey: (connId, sessionKey) => {
      const state = connections.get(connId)?.get(sessionKey);
      // Explicit subscriptions own presentation while active; history/outbox reads
      // only choose spelling for clients that do not subscribe to message events.
      return state ? (latestSubscription(state)?.wireKey ?? state.observed?.key) : undefined;
    },
    subscribe: (connId: string, sessionKey: string, opts) => {
      const normalizedConnId = normalize(connId);
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedSessionKey) {
        return undefined;
      }
      const states = connection(normalizedConnId);
      if (!states) {
        return undefined;
      }
      const state: SessionConnectionState = states.get(normalizedSessionKey) ?? {
        pending: new Map(),
      };
      const selection: SessionSubscriptionSelection = {
        sequence: ++subscriptionSequence,
        includeApprovals: opts?.includeApprovals === true,
        wireKey: opts?.wireKey,
      };
      state.pending.set(selection.sequence, selection);
      states.set(normalizedSessionKey, state);
      const publish = () => {
        const latest = latestSubscription(state);
        setMessageSubscription(normalizedConnId, normalizedSessionKey, latest !== undefined);
        setApprovalSubscription(
          normalizedConnId,
          normalizedSessionKey,
          latest?.includeApprovals === true,
        );
      };
      publish();
      const settle = (succeeded: boolean) => {
        if (
          connections.get(normalizedConnId)?.get(normalizedSessionKey) !== state ||
          !state.pending.delete(selection.sequence)
        ) {
          return;
        }
        if (succeeded && (!state.committed || state.committed.sequence < selection.sequence)) {
          state.committed = selection;
        }
        publish();
        if (!state.committed && state.pending.size === 0 && !state.observed) {
          states.delete(normalizedSessionKey);
        }
      };
      const rollback = (() => settle(false)) as SessionMessageSubscription;
      rollback.commit = () => settle(true);
      if (!opts?.provisional) {
        rollback.commit();
        return undefined;
      }
      return rollback;
    },
    unsubscribe: (connId: string, sessionKey: string) => {
      const normalizedConnId = normalize(connId);
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedConnId || !normalizedSessionKey) {
        return;
      }
      const states = connections.get(normalizedConnId);
      states?.delete(normalizedSessionKey);
      setMessageSubscription(normalizedConnId, normalizedSessionKey, false);
      setApprovalSubscription(normalizedConnId, normalizedSessionKey, false);
    },
    unsubscribeAll: (connId: string) => {
      const normalizedConnId = normalize(connId);
      if (!normalizedConnId) {
        return;
      }
      const states = connections.get(normalizedConnId);
      if (!states) {
        return;
      }
      connections.delete(normalizedConnId);
      for (const sessionKey of states.keys()) {
        setMessageSubscription(normalizedConnId, sessionKey, false);
      }
      for (const sessionKey of states.keys()) {
        setApprovalSubscription(normalizedConnId, sessionKey, false);
      }
    },
    get: (sessionKey: string) => {
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedSessionKey) {
        return empty;
      }
      return sessionToConnIds.get(normalizedSessionKey) ?? empty;
    },
    getApprovals: (sessionKey: string) => {
      const normalizedSessionKey = normalize(sessionKey);
      if (!normalizedSessionKey) {
        return empty;
      }
      return approvalSessionToConnIds.get(normalizedSessionKey) ?? empty;
    },
    onChange: (listener) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
  };
  return registry;
}

function createToolEventRecipientRegistryForStore(
  store: ChatRunRecordStore,
): ToolEventRecipientRegistry {
  let nextPruneAt = Infinity;
  const pruneExpired = (now = Date.now()) => {
    if (now < nextPruneAt) {
      return;
    }
    nextPruneAt = Infinity;
    for (const [runId, record] of store.runs) {
      const entry = record.toolRecipient;
      if (!entry) {
        continue;
      }
      const cutoff = entry.finalizedAt
        ? entry.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : entry.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS;
      if (now >= cutoff) {
        delete record.toolRecipient;
        store.releaseIfEmpty(runId);
      } else {
        nextPruneAt = Math.min(nextPruneAt, cutoff);
      }
    }
  };

  const prune = (updated: ChatRunToolRecipientState) => {
    // Refreshes can move expiry later; a conservative lower bound avoids a
    // full run scan on each tool event while retaining exact expiry cleanup.
    nextPruneAt = Math.min(
      nextPruneAt,
      updated.finalizedAt
        ? updated.finalizedAt + TOOL_EVENT_RECIPIENT_FINAL_GRACE_MS
        : updated.updatedAt + TOOL_EVENT_RECIPIENT_TTL_MS,
    );
    pruneExpired();
  };

  const add = (runId: string, connId: string) => {
    if (!runId || !connId) {
      return;
    }
    const now = Date.now();
    const entry = (store.getOrCreate(runId).toolRecipient ??= {
      connIds: new Set<string>(),
      updatedAt: now,
    });
    entry.connIds.add(connId);
    entry.updatedAt = now;
    prune(entry);
  };

  const get = (runId: string) => {
    const entry = store.runs.get(runId)?.toolRecipient;
    if (entry) {
      entry.updatedAt = Date.now();
      prune(entry);
    }
    // Pruning may retire this finalized run; never return its former audience.
    return store.runs.get(runId)?.toolRecipient?.connIds;
  };

  const markFinal = (runId: string) => {
    const entry = store.runs.get(runId)?.toolRecipient;
    if (!entry) {
      return;
    }
    entry.finalizedAt = Date.now();
    prune(entry);
  };

  return { add, get, markFinal, pruneExpired };
}
