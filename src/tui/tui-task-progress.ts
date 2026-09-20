import { Container, Text } from "@earendil-works/pi-tui";
import {
  TaskProjection,
  isActiveTask,
  normalizeTaskEventPayload,
  normalizeTasksListResult,
  type TaskSummary,
} from "@openclaw/gateway-client";
import type { ProgressCard } from "../../packages/gateway-protocol/src/index.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { tuiTheme as theme } from "./theme/theme.js";
import type { TuiBackend } from "./tui-backend.js";
import { sanitizeRenderableText } from "./tui-formatters.js";

const ACTIVE_STATUSES = ["queued", "running"] as const;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "timed_out"] as const;

function taskLines(task: TaskSummary): string[] {
  const active = isActiveTask(task);
  const execution = task.execution?.state;
  const status = active
    ? execution === "running" || execution === "waiting" || execution === "queued"
      ? execution
      : "unknown"
    : task.status;
  const lines = [`${task.title || task.taskId} [${status}]`];
  if (active && status !== "unknown") {
    for (const item of task.progress?.items ?? []) {
      if (item.hideFromChannelProgress || item.suppressChannelProgress) {
        continue;
      }
      const itemStatus = item.status ?? (item.phase === "end" ? "unknown" : "running");
      const detail = item.progressText || item.summary || item.meta || item.error;
      lines.push(`  ${item.title} [${itemStatus}]${detail ? ` — ${detail}` : ""}`);
    }
  }
  if (lines.length === 1 && (!active || !task.progress || status === "unknown")) {
    const detail = active
      ? execution === "unknown" || !execution
        ? "Current activity unavailable"
        : task.progressSummary || task.lastActivity
      : task.terminalSummary || task.error;
    if (detail) {
      lines.push(`  ${detail}`);
    }
  }
  return lines;
}

/** A session-scoped observation surface, independent of foreground run/composer ownership. */
export function createTuiTaskProgressController(params: {
  client: Pick<TuiBackend, "listTasks" | "getProgressCard">;
  getScope: () => { sessionKey: string; agentId: string };
  requestRender: () => void;
}) {
  const component = new Container();
  let projection = new TaskProjection();
  let scope = params.getScope();
  let generation = 0;
  let connected = false;
  let disposed = false;
  let unavailable = false;
  let card: ProgressCard | null = null;
  let cardRead = 0;
  let refreshPromise: Promise<void> | undefined;
  let refreshAgain = false;
  const pending = new Set<Promise<void>>();

  const render = () => {
    component.clear();
    if (unavailable) {
      component.addChild(new Text(theme.dim("Task activity unavailable"), 1, 0));
    }
    const tasks = unavailable ? [] : (projection.tasks ?? []);
    if (tasks.length) {
      const active = tasks.filter(isActiveTask);
      const recent = tasks.filter((task) => !isActiveTask(task)).slice(0, 3);
      const lines = [...active, ...recent].flatMap(taskLines);
      component.addChild(
        new Text(theme.dim("Tasks") + "\n" + sanitizeRenderableText(lines.join("\n")), 1, 0),
      );
    }
    if (card) {
      const lines = ["Session checklist"];
      if (card.markdown) {
        lines.push(card.markdown);
      }
      for (const step of card.steps ?? []) {
        const mark = step.status === "completed" ? "x" : step.status === "in_progress" ? ">" : " ";
        lines.push(`[${mark}] ${step.step}`);
      }
      component.addChild(new Text(sanitizeRenderableText(lines.join("\n")), 1, 0));
    }
    params.requestRender();
  };

  const track = (promise: Promise<void>) => {
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  };

  const refreshCard = () => {
    const expectedGeneration = generation;
    const request = ++cardRead;
    const selected = scope;
    return track(
      params.client.getProgressCard(selected).then(
        (result) => {
          if (disposed || expectedGeneration !== generation || request !== cardRead) {
            return;
          }
          card = result.card;
          render();
        },
        () => {
          if (!disposed && expectedGeneration === generation && request === cardRead) {
            card = null;
            render();
          }
        },
      ),
    );
  };

  const refresh = (): Promise<void> => {
    if (disposed || !connected || !scope.sessionKey) {
      return Promise.resolve();
    }
    if (refreshPromise) {
      refreshAgain = true;
      return refreshPromise;
    }
    const current = projection;
    const expectedGeneration = generation;
    const selected = scope;
    const token = current.beginSnapshot();
    const owns = () => !disposed && expectedGeneration === generation && connected;
    const request = (async () => {
      try {
        const active: TaskSummary[] = [];
        let cursor: string | undefined;
        do {
          const page = normalizeTasksListResult(
            await params.client.listTasks({
              ...selected,
              status: [...ACTIVE_STATUSES],
              limit: 100,
              ...(cursor ? { cursor } : {}),
            }),
          );
          if (!owns()) {
            return;
          }
          if (!page) {
            // Reject malformed wire pages instead of admitting an unscoped partial snapshot.
            throw new Error("Invalid task page");
          }
          active.push(...page.tasks);
          cursor = page.nextCursor;
        } while (cursor);
        const history = normalizeTasksListResult(
          await params.client.listTasks({
            ...selected,
            status: [...TERMINAL_STATUSES],
            sortBy: "endedAt",
            limit: 3,
          }),
        );
        if (!owns()) {
          return;
        }
        if (!history) {
          throw new Error("Invalid task history page");
        }
        current.applySnapshot(token, active, history.tasks);
        unavailable = false;
        render();
      } catch {
        if (owns()) {
          current.failSnapshot(token);
          unavailable = true;
          render();
        }
      } finally {
        if (owns()) {
          refreshPromise = undefined;
          if (refreshAgain) {
            refreshAgain = false;
            void refresh();
          }
        }
      }
    })();
    refreshPromise = track(request);
    return request;
  };

  const reset = (clearCard: boolean) => {
    generation += 1;
    cardRead += 1;
    projection.dispose();
    projection = new TaskProjection();
    refreshPromise = undefined;
    refreshAgain = false;
    if (clearCard) {
      card = null;
    }
  };

  return {
    component,
    async connect() {
      connected = true;
      scope = params.getScope();
      reset(true);
      await Promise.all([refresh(), refreshCard()]);
    },
    sessionChanged() {
      scope = params.getScope();
      reset(true);
      unavailable = false;
      render();
      if (connected) {
        void refresh();
        void refreshCard();
      }
    },
    disconnect() {
      connected = false;
      const hadTasks = Boolean(projection.tasks?.length);
      reset(false);
      unavailable = hadTasks;
      render();
    },
    async reload() {
      reset(false);
      render();
      await Promise.all([refresh(), refreshCard()]);
    },
    handleEvent(event: string, payload: unknown) {
      if (disposed || !connected) {
        return;
      }
      if (event === "progressCard.changed") {
        const expected = parseAgentSessionKey(scope.sessionKey)
          ? scope.sessionKey
          : `agent:${scope.agentId}:${scope.sessionKey}`;
        if (
          payload &&
          typeof payload === "object" &&
          "sessionKey" in payload &&
          payload.sessionKey === expected
        ) {
          void refreshCard();
        }
        return;
      }
      if (event !== "task") {
        return;
      }
      let change = normalizeTaskEventPayload(payload);
      if (!change) {
        void refresh();
        return;
      }
      if (change.action === "upserted") {
        // Raw requester aliases do not encode the owner; executor agentId is not that owner.
        // Only an authoritative session+agent query can admit those events.
        if (!parseAgentSessionKey(scope.sessionKey)) {
          void refresh();
          return;
        }
        const task = change.task;
        const relatedKeys = [task.sessionKey, task.ownerKey, task.childSessionKey];
        if (!relatedKeys.includes(scope.sessionKey)) {
          if (
            !relatedKeys.some(Boolean) ||
            relatedKeys.some((key) => key && !parseAgentSessionKey(key))
          ) {
            void refresh();
            return;
          }
          // Scope moves must also retract rows from snapshots that have not arrived yet.
          change = { action: "deleted", taskId: task.taskId };
        }
      }
      const result = projection.applyEvent(change);
      if (result.changed) {
        render();
      }
      if (result.refetch || unavailable) {
        void refresh();
      }
    },
    dispose() {
      disposed = true;
      connected = false;
      reset(true);
    },
    async settled() {
      await Promise.allSettled(pending);
    },
  };
}
