import {
  TaskProjection,
  isActiveTask,
  normalizeTaskEventPayload,
  normalizeTasksCancelResult,
  normalizeTasksGetResult,
  normalizeTasksListResult,
  newestTaskSnapshot,
  type TaskSummary,
} from "@openclaw/gateway-client/browser";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../../../api/gateway.ts";
import { hasOperatorWriteAccess } from "../../../app/operator-access.ts";
import { t } from "../../../i18n/index.ts";
import { registerBackgroundTasksEnglish } from "../../../i18n/locales/en-background-tasks.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import type { SessionScopeHost } from "../../../lib/sessions/index.ts";
import {
  canonicalUiSessionKeyForPersistence,
  resolveUiConversationIdentity,
} from "../../../lib/sessions/session-key.ts";
import { taskMatchesSessionScope } from "./chat-background-task-scope.ts";
import {
  observeTaskTerminal,
  type BackgroundTaskObservations,
} from "./chat-background-tasks-shared.ts";
import type { BackgroundTasksProps } from "./chat-background-tasks.types.ts";
import { deriveSubagentActivity } from "./chat-subagent-activity.ts";
import {
  observeTaskDetailEvent,
  resetTaskDetail,
  type TaskTranscriptHost,
} from "./chat-task-detail-state.ts";

registerBackgroundTasksEnglish();

type BackgroundTaskSnapshotResult =
  | { kind: "ready"; active: unknown; recent: unknown }
  | { kind: "deferred"; retryAttempt: number }
  | { kind: "stale" };

type BackgroundTasksState = BackgroundTaskObservations & {
  cancellingTaskIds: Set<string>;
  collapsed: boolean;
  connectionClient: GatewayBrowserClient | null;
  connectionEpoch: number | undefined;
  error: string | null;
  explicitReadRequested: boolean;
  deferredRetryAttempt?: number;
  finishedCollapsed: boolean;
  // Loads are keyed to the client so a reconnect (or gateway switch) refreshes
  // the snapshot instead of trusting the previous connection's task list.
  loadedClient: GatewayBrowserClient | null;
  loading: boolean;
  projection: TaskProjection;
  pendingReload: boolean;
  requestId: number;
  sessionKey: string;
  agentId?: string;
  // wa-tooltip anchors by document id, so the status row's id must stay unique
  // per pane: two panes on the same agent would otherwise cross-anchor.
  statusRowId: string;
  subagentActivityExpiryAt: number | null;
  subagentActivityExpiryTimer: number | null;
  readonly tasks: TaskSummary[] | null;
  taskDetails: Map<string, TaskSummary>;
  taskDetailErrors: Map<string, string>;
  taskDetailRequests: Map<string, symbol>;
};

export type BackgroundTasksHost = TaskTranscriptHost & {
  sessionKey: string;
  assistantAgentId?: string | null;
  hello: GatewayHelloOk | null;
  agentsList?: SessionScopeHost["agentsList"];
  backgroundTasksState?: BackgroundTasksState;
  chatSecondaryReadsReady?: (explicit?: boolean) => boolean;
};

// The chat rail stays bounded to its session while the full Tasks page drains
// every active page. A separate active query still keeps long-running work
// from hiding behind newer terminal records here.
const ACTIVE_TASKS_LIMIT = 200;
const RECENT_TASKS_LIMIT = 100;
const TASK_LIST_MAX_ATTEMPTS = 2;
const TASK_LIST_RETRY_DEFAULT_MS = 250;
const TASK_LIST_RETRY_MAX_MS = 30_000;

let nextStatusRowId = 0;

function getBackgroundTasksState(host: BackgroundTasksHost): BackgroundTasksState {
  const { sessionKey, agentId } = resolveUiConversationIdentity(host, host.sessionKey);
  const current = host.backgroundTasksState;
  if (
    current?.sessionKey === sessionKey &&
    current.agentId === agentId &&
    current.connectionClient === host.client &&
    current.connectionEpoch === host.connectionEpoch
  ) {
    return current;
  }
  if (
    current?.subagentActivityExpiryTimer !== null &&
    current?.subagentActivityExpiryTimer !== undefined
  ) {
    window.clearTimeout(current.subagentActivityExpiryTimer);
  }
  current?.projection.dispose();
  resetTaskDetail(host);
  nextStatusRowId += 1;
  const next: BackgroundTasksState = {
    cancellingTaskIds: new Set(),
    // Keep presentation choices across thread switches while discarding all
    // task data and private details from the previous session scope.
    collapsed: current?.collapsed ?? true,
    // The pane increments this epoch even when a reconnect reuses its client.
    // Old snapshots and private task details must never enter the new scope.
    connectionClient: host.client,
    connectionEpoch: host.connectionEpoch,
    error: null,
    explicitReadRequested: false,
    // Finished history starts collapsed so active work owns the rail; the
    // section header still shows the count for discoverability.
    finishedCollapsed: current?.finishedCollapsed ?? true,
    loadedClient: null,
    loading: false,
    projection: new TaskProjection(),
    pendingReload: false,
    requestId: 0,
    sessionKey,
    agentId,
    statusRowId: `chat-tasks-status-${nextStatusRowId}`,
    subagentActivityExpiryAt: null,
    subagentActivityExpiryTimer: null,
    terminalObservedAtByTask: new Map(),
    get tasks() {
      return this.projection.tasks;
    },
    taskDetails: new Map(),
    taskDetailErrors: new Map(),
    taskDetailRequests: new Map(),
  };
  host.backgroundTasksState = next;
  return next;
}

function scheduleSubagentActivityExpiry(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  nextExpiryAt: number | null,
) {
  if (state.subagentActivityExpiryAt === nextExpiryAt) {
    return;
  }
  if (state.subagentActivityExpiryTimer !== null) {
    window.clearTimeout(state.subagentActivityExpiryTimer);
  }
  state.subagentActivityExpiryAt = nextExpiryAt;
  state.subagentActivityExpiryTimer = null;
  if (nextExpiryAt === null) {
    return;
  }
  state.subagentActivityExpiryTimer = window.setTimeout(
    () => {
      if (getBackgroundTasksState(host) !== state) {
        return;
      }
      state.subagentActivityExpiryAt = null;
      state.subagentActivityExpiryTimer = null;
      host.requestUpdate?.();
    },
    Math.max(0, nextExpiryAt - Date.now()),
  );
}

function taskListRetryDelayMs(error: unknown): number | undefined {
  if (!(error instanceof GatewayRequestError) || !error.retryable) {
    return undefined;
  }
  return Math.min(
    TASK_LIST_RETRY_MAX_MS,
    Math.max(
      0,
      typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : TASK_LIST_RETRY_DEFAULT_MS,
    ),
  );
}

async function requestTaskSnapshot(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  client: GatewayBrowserClient,
  requestId: number,
): Promise<BackgroundTaskSnapshotResult> {
  const { sessionKey, agentId } = state;
  const retryAttempt = state.deferredRetryAttempt ?? 0;
  delete state.deferredRetryAttempt;
  for (let attempt = retryAttempt; attempt < TASK_LIST_MAX_ATTEMPTS; attempt += 1) {
    if (
      !host.connected ||
      host.client !== client ||
      getBackgroundTasksState(host) !== state ||
      state.requestId !== requestId
    ) {
      return { kind: "stale" };
    }
    if (host.chatSecondaryReadsReady?.(state.explicitReadRequested) === false) {
      return { kind: "deferred", retryAttempt: attempt };
    }
    const results = await Promise.allSettled([
      client.request("tasks.list", {
        sessionKey,
        agentId,
        status: ["queued", "running"],
        limit: ACTIVE_TASKS_LIMIT,
      }),
      client.request("tasks.list", {
        sessionKey,
        agentId,
        status: ["completed", "failed", "timed_out", "cancelled"],
        sortBy: "endedAt",
        limit: RECENT_TASKS_LIMIT,
      }),
    ]);
    const [active, recent] = results;
    if (active?.status === "fulfilled" && recent?.status === "fulfilled") {
      return { kind: "ready", active: active.value, recent: recent.value };
    }
    const failures = results.filter((result) => result.status === "rejected");
    const error = failures[0]?.reason;
    let retryDelayMs = 0;
    for (const failure of failures) {
      const delay = taskListRetryDelayMs(failure.reason);
      if (delay === undefined) {
        throw failure.reason;
      }
      retryDelayMs = Math.max(retryDelayMs, delay);
    }
    if (attempt === TASK_LIST_MAX_ATTEMPTS - 1) {
      throw error;
    }
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, retryDelayMs);
    });
  }
  throw new Error("unreachable task list retry state");
}

function loadBackgroundTasks(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  force = false,
) {
  const client = host.client;
  if (!client || !host.connected || getBackgroundTasksState(host) !== state) {
    return;
  }
  if (state.loading) {
    state.pendingReload ||= force;
    return;
  }
  const requestId = ++state.requestId;
  const token = state.projection.beginSnapshot();
  state.loading = true;
  state.error = null;
  state.pendingReload = false;
  host.requestUpdate?.();
  void (async () => {
    try {
      const result = await requestTaskSnapshot(host, state, client, requestId);
      const current = getBackgroundTasksState(host);
      if (
        !host.connected ||
        current !== state ||
        current.requestId !== requestId ||
        result.kind === "stale"
      ) {
        return;
      }
      if (result.kind === "deferred") {
        current.deferredRetryAttempt = current.pendingReload ? 0 : result.retryAttempt;
        current.pendingReload = true;
        return;
      }
      // Saved selections can hold newer detail without belonging to this
      // bounded window. Reconcile only rows the scoped snapshot admits.
      const active = normalizeTasksListResult(result.active)?.tasks.map((task) =>
        newestTaskSnapshot(task, current.taskDetails.get(task.id)),
      );
      const recent = normalizeTasksListResult(result.recent)?.tasks.map((task) =>
        newestTaskSnapshot(task, current.taskDetails.get(task.id)),
      );
      if (!active || !recent) {
        throw new Error(t("tasksPage.invalidResponse"));
      }
      if (!current.projection.applySnapshot(token, active, recent)) {
        return;
      }
      for (const task of current.tasks ?? []) {
        observeTaskTerminal(current, task, "snapshot");
      }
      current.loadedClient = client;
    } catch (error) {
      const current = getBackgroundTasksState(host);
      if (current === state && current.requestId === requestId) {
        current.projection.failSnapshot(token);
        for (const task of current.tasks ?? []) {
          observeTaskTerminal(current, task, "event");
        }
        current.error = formatUiError(error, t("tasksPage.loadFailed"));
      }
    } finally {
      const current = getBackgroundTasksState(host);
      if (current === state && current.requestId === requestId) {
        current.loading = false;
        const reload = current.pendingReload;
        current.pendingReload = false;
        if (reload && host.chatSecondaryReadsReady?.(current.explicitReadRequested) !== false) {
          loadBackgroundTasks(host, current, true);
        } else if (reload) {
          current.loadedClient = null;
          // The superseded read's error must not block its queued replacement on resume.
          current.error = null;
        }
      }
      host.requestUpdate?.();
    }
  })();
}

/** Apply a gateway `task` event to the pane's snapshot. Events for other
 * sessions are ignored; a registry restore forces a refetch. */
export function handleBackgroundTasksEvent(
  host: BackgroundTasksHost,
  payload: unknown,
  presented = true,
) {
  const state = host.backgroundTasksState;
  if (!state || getBackgroundTasksState(host) !== state) {
    return;
  }
  let normalizedEvent = normalizeTaskEventPayload(payload);
  if (!normalizedEvent) {
    return;
  }
  if (normalizedEvent.action === "upserted") {
    const match = taskMatchesSessionScope(host, normalizedEvent.task, state);
    if (match === "ignore") {
      return;
    }
    if (match === "refresh") {
      // Ambiguous events invalidate like a restore: coalesce visible reloads
      // and defer hidden panes until presentation without adopting the event.
      normalizedEvent = { action: "restored" };
    }
  }
  observeTaskDetailEvent(host, normalizedEvent);
  const event =
    normalizedEvent.action === "upserted"
      ? {
          ...normalizedEvent,
          task: newestTaskSnapshot(
            normalizedEvent.task,
            state.taskDetails.get(normalizedEvent.task.id),
          ),
        }
      : normalizedEvent;
  const result = state.projection.applyEvent(event);
  const readReady =
    presented && host.chatSecondaryReadsReady?.(state.explicitReadRequested) !== false;
  if (event.action === "restored") {
    state.taskDetailRequests.clear();
    state.taskDetails.clear();
    state.taskDetailErrors.clear();
    delete state.deferredRetryAttempt;
  }
  if (event.action === "restored" && !readReady) {
    // Restore replaces the registry snapshot. Retire any older page without
    // issuing hidden work; presentation will start the authoritative reload.
    state.requestId += 1;
    state.pendingReload = false;
    state.loading = false;
    state.loadedClient = null;
    state.error = null;
    host.requestUpdate?.();
    return;
  }
  if (
    event.action === "deleted" &&
    (state.taskDetails.has(event.taskId) ||
      state.taskDetailRequests.has(event.taskId) ||
      state.taskDetailErrors.has(event.taskId) ||
      state.tasks?.some((task) => task.id === event.taskId))
  ) {
    state.taskDetails.delete(event.taskId);
    state.taskDetailRequests.delete(event.taskId);
    state.taskDetailErrors.set(event.taskId, t("chat.backgroundTasks.taskUnavailable"));
    host.requestUpdate?.();
  }
  if (result.refetch || (state.tasks === null && !state.loading)) {
    if (readReady) {
      loadBackgroundTasks(host, state, true);
    } else {
      state.pendingReload = true;
      state.loadedClient = null;
    }
    host.requestUpdate?.();
    return;
  }
  if (event.action === "deleted") {
    state.terminalObservedAtByTask.delete(event.taskId);
  }
  if (event.action !== "upserted") {
    host.requestUpdate?.();
    return;
  }
  const newest = state.tasks?.find((task) => task.id === event.task.id);
  if (!newest) {
    return;
  }
  const detail = state.taskDetails.get(event.task.id);
  observeTaskTerminal(state, newest, "event");
  if (detail) {
    state.taskDetails = new Map(state.taskDetails).set(event.task.id, {
      ...newest,
      ...(detail.prompt ? { prompt: detail.prompt } : {}),
    });
  }
  host.requestUpdate?.();
}

async function loadBackgroundTaskDetail(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  rowId: string,
) {
  const client = host.client;
  if (
    !client ||
    !host.connected ||
    getBackgroundTasksState(host) !== state ||
    state.taskDetails.has(rowId) ||
    state.taskDetailRequests.has(rowId)
  ) {
    return;
  }
  const request = Symbol(rowId);
  state.taskDetailRequests.set(rowId, request);
  const isCurrent = () =>
    getBackgroundTasksState(host) === state && state.taskDetailRequests.get(rowId) === request;
  const nextErrors = new Map(state.taskDetailErrors);
  nextErrors.delete(rowId);
  state.taskDetailErrors = nextErrors;
  host.requestUpdate?.();
  try {
    const payload = await client.request("tasks.get", { taskId: rowId });
    if (!isCurrent()) {
      return;
    }
    const detail = normalizeTasksGetResult(payload);
    if (!detail || detail.id !== rowId) {
      throw new Error(t("chat.backgroundTasks.detailFailed"));
    }
    const current = state.tasks?.find((candidate) => candidate.id === rowId);
    if (!current && taskMatchesSessionScope(host, detail, state) !== "match") {
      throw new Error(t("chat.backgroundTasks.taskUnavailable"));
    }
    const newest = current ? newestTaskSnapshot(current, detail) : detail;
    observeTaskTerminal(state, newest, "snapshot");
    state.taskDetails = new Map(state.taskDetails).set(rowId, {
      ...newest,
      ...(detail.prompt ? { prompt: detail.prompt } : {}),
    });
    if (current) {
      state.projection.applyEvent({ action: "upserted", task: newest });
    }
  } catch (error) {
    if (isCurrent()) {
      const message = formatUiError(error, t("chat.backgroundTasks.detailFailed"));
      state.taskDetailErrors = new Map(state.taskDetailErrors).set(rowId, message);
    }
  } finally {
    if (isCurrent()) {
      state.taskDetailRequests.delete(rowId);
    }
    host.requestUpdate?.();
  }
}

async function cancelBackgroundTask(
  host: BackgroundTasksHost,
  state: BackgroundTasksState,
  taskId: string,
) {
  const client = host.client;
  if (
    !client ||
    !host.connected ||
    getBackgroundTasksState(host) !== state ||
    state.cancellingTaskIds.has(taskId)
  ) {
    return;
  }
  state.cancellingTaskIds = new Set([...state.cancellingTaskIds, taskId]);
  state.error = null;
  host.requestUpdate?.();
  try {
    const payload = await client.request("tasks.cancel", { taskId });
    if (getBackgroundTasksState(host) !== state) {
      return;
    }
    const result = normalizeTasksCancelResult(payload);
    if (result?.task) {
      state.projection.applyEvent({ action: "upserted", task: result.task });
      const current = state.tasks?.find((task) => task.id === result.task?.id);
      if (current) {
        observeTaskTerminal(state, current, "event");
      }
    }
    // Refusals (already terminal, stale id, no cancellation handle) are
    // successful responses with cancelled=false; surface them like errors.
    if (!result?.cancelled) {
      const reason = result?.reason?.trim();
      state.error = reason ? formatUiError(reason) : t("tasksPage.cancelFailed");
    }
  } catch (error) {
    if (getBackgroundTasksState(host) === state) {
      state.error = formatUiError(error, t("tasksPage.cancelFailed"));
    }
  } finally {
    if (getBackgroundTasksState(host) === state) {
      const next = new Set(state.cancellingTaskIds);
      next.delete(taskId);
      state.cancellingTaskIds = next;
    }
    host.requestUpdate?.();
  }
}

export function refreshBackgroundTasks(
  host: BackgroundTasksHost,
  state = getBackgroundTasksState(host),
): void {
  delete state.deferredRetryAttempt;
  state.explicitReadRequested = true;
  loadBackgroundTasks(host, state, true);
}

export function createBackgroundTasksProps(
  host: BackgroundTasksHost,
  opts: {
    narrowLayout?: boolean;
    selectedTaskId?: string;
    onOpenTaskDetail?: (task: TaskSummary) => void;
    onOpenTaskList?: () => void;
    presented?: boolean;
  } = {},
): BackgroundTasksProps {
  const state = getBackgroundTasksState(host);
  if (!host.connected) {
    // Reconnect replaces observation authority even when the client is reused.
    state.requestId += 1;
    state.projection.invalidate();
    state.loading = false;
    state.taskDetails.clear();
    state.taskDetailRequests.clear();
    state.taskDetailErrors.clear();
    resetTaskDetail(host);
    state.loadedClient = null;
  }
  // Load eagerly even while collapsed: the toggle badge is how running work
  // gets detected at all, so it cannot wait for the rail to be opened first.
  if (
    opts.presented !== false &&
    host.chatSecondaryReadsReady?.(state.explicitReadRequested) !== false &&
    host.connected &&
    !state.loading &&
    (!state.error || state.pendingReload) &&
    (state.tasks === null || state.loadedClient !== host.client)
  ) {
    loadBackgroundTasks(host, state);
  }
  if (
    opts.presented !== false &&
    opts.selectedTaskId &&
    !state.loading &&
    state.tasks !== null &&
    host.chatSecondaryReadsReady?.(state.explicitReadRequested) !== false &&
    !state.tasks?.some((task) => task.id === opts.selectedTaskId) &&
    !state.taskDetails.has(opts.selectedTaskId) &&
    !state.taskDetailErrors.has(opts.selectedTaskId)
  ) {
    void loadBackgroundTaskDetail(host, state, opts.selectedTaskId);
  }
  const subagentActivity = deriveSubagentActivity({
    tasks: state.tasks ?? [],
    sessionKey: state.sessionKey,
    terminalObservedAtByTask: state.terminalObservedAtByTask,
    canonicalizeSessionKey: (sessionKey) =>
      canonicalUiSessionKeyForPersistence(host, sessionKey) ||
      normalizeOptionalString(sessionKey) ||
      "",
  });
  scheduleSubagentActivityExpiry(host, state, subagentActivity.nextExpiryAt);
  return {
    sessionKey: state.sessionKey,
    statusRowId: state.statusRowId,
    collapsed: state.collapsed,
    narrowLayout: opts.narrowLayout === true,
    connected: host.connected,
    // tasks.cancel needs operator.write; read-only operators get no button.
    canCancel: host.connected && hasOperatorWriteAccess(host.hello?.auth ?? null),
    loading: state.loading,
    error: state.error,
    tasks: state.tasks,
    activeCount: state.tasks?.filter(isActiveTask).length ?? 0,
    subagentActivity,
    selectedTaskId: opts.selectedTaskId,
    taskDetails: state.taskDetails,
    taskDetailErrors: state.taskDetailErrors,
    taskDetailLoadingIds: new Set(state.taskDetailRequests.keys()),
    cancellingTaskIds: state.cancellingTaskIds,
    finishedCollapsed: state.finishedCollapsed,
    onToggleCollapsed: () => {
      const current = getBackgroundTasksState(host);
      current.collapsed = !current.collapsed;
      host.requestUpdate?.();
    },
    onToggleFinished: () => {
      state.finishedCollapsed = !state.finishedCollapsed;
      host.requestUpdate?.();
    },
    onRefresh: () => refreshBackgroundTasks(host, state),
    onCancel: (taskId) => void cancelBackgroundTask(host, state, taskId),
    onLoadDetail: (task) => void loadBackgroundTaskDetail(host, state, task.id),
    onOpenTaskList: () => {
      if (getBackgroundTasksState(host) !== state) {
        return;
      }
      resetTaskDetail(host);
      state.collapsed = false;
      opts.onOpenTaskList?.();
      host.requestUpdate?.();
    },
    onOpenTaskDetail: opts.onOpenTaskDetail
      ? (task) => {
          if (getBackgroundTasksState(host) !== state) {
            return;
          }
          if (host.taskDetailState?.taskId !== task.id) {
            resetTaskDetail(host);
          }
          // Opening retries a failed tasks.get: the panel's render-driven load
          // must skip errored tasks (a retry there would loop every paint), so
          // user selection is the one path that clears the error.
          if (state.taskDetailErrors.has(task.id)) {
            const next = new Map(state.taskDetailErrors);
            next.delete(task.id);
            state.taskDetailErrors = next;
          }
          opts.onOpenTaskDetail?.(task);
          host.requestUpdate?.();
        }
      : undefined,
  };
}
