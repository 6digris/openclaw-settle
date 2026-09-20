import { createHash, randomUUID } from "node:crypto";
import type { TaskSummary } from "../../packages/gateway-protocol/src/index.js";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/config.js";
import { canonicalizeMainSessionAlias } from "../config/sessions/main-session.js";
import { progressCardStore, onSessionProgressCardChanged } from "../gateway/progress-card-store.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { listTaskRecordPage } from "../tasks/task-registry-query.js";
import { prepareTaskRegistryRead } from "../tasks/task-registry-read.js";
import { onTaskRegistryChange } from "../tasks/task-registry.store.js";
import type { TaskStatus } from "../tasks/task-registry.types.js";
import { mapTaskSummary } from "../tasks/task-summary.js";
import type { TuiBackend, TuiEvent } from "./tui-backend.js";

const TASK_STATUSES: Record<TaskSummary["status"], TaskStatus[]> = {
  queued: ["queued"],
  running: ["running"],
  completed: ["succeeded"],
  failed: ["failed", "lost"],
  cancelled: ["cancelled"],
  timed_out: ["timed_out"],
};

/** Local transport for existing task/card owners; it never admits or schedules work. */
export class EmbeddedTaskObserver {
  private lifetime = new AbortController();
  private id = randomUUID();
  private unsubscribe: Array<() => void> = [];
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly emit: (event: TuiEvent) => void) {}

  start() {
    if (this.unsubscribe.length) {
      return;
    }
    this.lifetime = new AbortController();
    this.id = randomUUID();
    const signal = this.lifetime.signal;
    this.unsubscribe.push(
      onTaskRegistryChange((event) => {
        if (!event || event.kind === "restored") {
          this.emit({ event: "task", payload: { action: "restored" } });
          return;
        }
        const taskId = event.kind === "upserted" ? event.task.taskId : event.taskId;
        void this.track(
          (async () => {
            const read = await prepareTaskRegistryRead();
            if (signal.aborted) {
              return;
            }
            if (!read) {
              this.emit({ event: "task", payload: { action: "restored" } });
              return;
            }
            const task = read.getTaskById(taskId);
            this.emit({
              event: "task",
              payload: task
                ? { action: "upserted", task: mapTaskSummary(task) }
                : { action: "deleted", taskId },
            });
          })(),
        ).catch(() => {
          if (!signal.aborted) {
            this.emit({ event: "task", payload: { action: "restored" } });
          }
        });
      }),
      onSessionProgressCardChanged(({ sessionKey, agentId, revision }) => {
        this.emit({
          event: "progressCard.changed",
          payload: {
            sessionKey: parseAgentSessionKey(sessionKey)
              ? sessionKey
              : `agent:${agentId}:${sessionKey}`,
            revision,
          },
        });
      }),
      onSessionLifecycleEvent((event) => {
        if (event.reason === "progress-card-reset" && event.agentId) {
          this.emit({
            event: "progressCard.changed",
            payload: {
              sessionKey: parseAgentSessionKey(event.sessionKey)
                ? event.sessionKey
                : `agent:${event.agentId}:${event.sessionKey}`,
              revision: null,
            },
          });
        }
      }),
      sessionChanges.subscribe((change) => {
        if ("sessionKey" in change || change.scope === "agent-runs") {
          this.emit({ event: "task", payload: { action: "restored" } });
        }
      }),
    );
  }

  async stop() {
    this.lifetime.abort();
    for (const unsubscribe of this.unsubscribe.splice(0)) {
      unsubscribe();
    }
    await Promise.allSettled(this.pending);
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }

  listTasks(opts: Parameters<TuiBackend["listTasks"]>[0]) {
    const signal = this.lifetime.signal;
    return this.track(
      (async () => {
        signal.throwIfAborted();
        const cfg = getRuntimeConfig();
        const agentId = opts.sessionKey
          ? resolveSessionAgentId({
              config: cfg,
              sessionKey: opts.sessionKey,
              agentId: opts.agentId,
            })
          : opts.agentId;
        const sessionKey =
          opts.sessionKey && agentId
            ? canonicalizeMainSessionAlias({ cfg, agentId, sessionKey: opts.sessionKey })
            : undefined;
        const statuses = opts.status
          ? (Array.isArray(opts.status) ? opts.status : [opts.status]).flatMap(
              (status) => TASK_STATUSES[status],
            )
          : undefined;
        const binding = createHash("sha256")
          .update(JSON.stringify([this.id, sessionKey, agentId, statuses, opts.sortBy]))
          .digest("base64url");
        let offset = 0;
        let expectedRevision: number | undefined;
        if (opts.cursor) {
          const cursor: unknown = JSON.parse(
            Buffer.from(opts.cursor, "base64url").toString("utf8"),
          );
          if (
            !Array.isArray(cursor) ||
            cursor.length !== 3 ||
            cursor[0] !== binding ||
            !Number.isSafeInteger(cursor[1]) ||
            cursor[1] < 0 ||
            !Number.isSafeInteger(cursor[2]) ||
            cursor[2] < 0
          ) {
            throw new Error("Invalid task cursor. Refresh tasks.");
          }
          expectedRevision = cursor[1];
          offset = cursor[2];
        }
        const result = await listTaskRecordPage({
          cfg,
          offset,
          expectedRevision,
          statuses,
          sortBy: opts.sortBy,
          limit: Math.max(1, Math.min(opts.limit ?? 100, 500)),
          ...(sessionKey ? { sessionKey, sessionAgentId: agentId } : { agentId }),
        });
        signal.throwIfAborted();
        if (!result.ok || !result.value.isCurrent()) {
          throw new Error("Task activity changed. Refresh tasks.");
        }
        const page = result.value;
        return {
          tasks: page.tasks.map((task) => mapTaskSummary(task)),
          ...(page.hasMore
            ? {
                nextCursor: Buffer.from(
                  JSON.stringify([binding, page.revision, offset + page.tasks.length]),
                ).toString("base64url"),
              }
            : {}),
        };
      })(),
    );
  }

  getProgressCard(opts: Parameters<TuiBackend["getProgressCard"]>[0]) {
    const signal = this.lifetime.signal;
    return this.track(
      (async () => {
        signal.throwIfAborted();
        const card = await progressCardStore.get(opts.sessionKey, opts.agentId);
        signal.throwIfAborted();
        return { card };
      })(),
    );
  }
}
