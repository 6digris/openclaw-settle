import {
  TaskSummarySchema,
  TasksCancelResultSchema,
  TasksGetResultSchema,
  TasksListResultSchema,
  TasksRecoveryResultSchema,
  type TaskSummary as ProtocolTaskSummary,
  type TasksCancelResult,
  type TasksRecoveryResult,
} from "@openclaw/gateway-protocol";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Value } from "typebox/value";

export type TaskStatus = ProtocolTaskSummary["status"];
export type TaskSummary = Omit<ProtocolTaskSummary, "taskId"> & { taskId: string };
export type TaskEventPayload =
  | { action: "upserted"; task: TaskSummary }
  | { action: "deleted"; taskId: string }
  | { action: "restored" };
export type CoalescedTaskEvent =
  | { action: "deleted" }
  | { action: "upserted"; task: TaskSummary; afterDelete: boolean };

type TaskSnapshotProvenance = "snapshot" | "event" | "detail";

// Browser-shared validation must interpret schemas: compiled validators probe eval under CSP.
export function normalizeTaskSummary(value: unknown): TaskSummary | null {
  if (!Value.Check(TaskSummarySchema, value)) {
    return null;
  }
  const id = value.id.trim();
  const taskId = value.taskId?.trim() || id;
  return id && taskId ? { ...value, id, taskId } : null;
}

export function isActiveTask(task: TaskSummary): boolean {
  return task.status === "queued" || task.status === "running";
}

export function taskTimestampMs(value: string | number | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  const parsed = typeof value === "string" ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function retainTaskDisplayFacts(
  selected: TaskSummary,
  current: TaskSummary,
  incoming: TaskSummary,
): TaskSummary {
  const other = selected === current ? incoming : current;
  const sameExecution =
    (!selected.runId || !other.runId || selected.runId === other.runId) &&
    (!selected.progress || !other.progress || selected.progress.runId === other.progress.runId);
  const prompt = selected.prompt ?? (sameExecution ? other.prompt : undefined);
  const detailResult =
    selected.result ??
    (sameExecution && !isActiveTask(selected) && !isActiveTask(other) ? other.result : undefined);
  const retainActivity =
    sameExecution && (!current.progress || current.progress.runId === selected.progress?.runId);
  const lastActivity = isActiveTask(selected)
    ? (selected.lastActivity ?? (retainActivity ? current.lastActivity : undefined))
    : undefined;
  const diffStat = selected.diffStat ?? (sameExecution ? current.diffStat : undefined);
  if (
    prompt === selected.prompt &&
    detailResult === selected.result &&
    lastActivity === selected.lastActivity &&
    diffStat === selected.diffStat
  ) {
    return selected;
  }
  const result = {
    ...selected,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(detailResult !== undefined ? { result: detailResult } : {}),
    ...(diffStat ? { diffStat } : {}),
  };
  if (lastActivity !== undefined) {
    result.lastActivity = lastActivity;
  } else {
    delete result.lastActivity;
  }
  // Never inherit progress: omission retires a generation's transient public observations.
  return result;
}

export function newestTaskSnapshot(
  current: TaskSummary,
  incoming: TaskSummary | undefined,
  provenance: TaskSnapshotProvenance = "detail",
): TaskSummary {
  if (!incoming) {
    return current;
  }
  const select = (task: TaskSummary) => retainTaskDisplayFacts(task, current, incoming);
  const currentAt = taskTimestampMs(current.updatedAt ?? current.endedAt ?? current.createdAt);
  const incomingAt = taskTimestampMs(incoming.updatedAt ?? incoming.endedAt ?? incoming.createdAt);
  if (incomingAt > currentAt) {
    return select(incoming);
  }
  if (incomingAt < currentAt) {
    return current;
  }
  const currentActive = isActiveTask(current);
  const incomingActive = isActiveTask(incoming);
  if (currentActive !== incomingActive) {
    return select(currentActive ? incoming : current);
  }
  if (!currentActive) {
    return select(provenance === "event" ? incoming : current);
  }
  if (current.status === "running" && incoming.status === "queued") {
    return select(current);
  }
  if (current.status === "queued" && incoming.status === "running") {
    return select(incoming);
  }
  // Within one client/registry epoch, progress revisions survive replacement
  // executions of the same task. Wall clocks do not order those replacements.
  if (current.progress && incoming.progress && current.runId === incoming.runId) {
    if (incoming.progress.revision !== current.progress.revision) {
      return select(incoming.progress.revision > current.progress.revision ? incoming : current);
    }
  }
  const currentActivityAt = taskTimestampMs(current.execution?.lastActivityAt);
  const incomingActivityAt = taskTimestampMs(incoming.execution?.lastActivityAt);
  if (incomingActivityAt !== currentActivityAt) {
    return select(incomingActivityAt > currentActivityAt ? incoming : current);
  }
  const currentToolCount = current.toolUseCount ?? 0;
  const incomingToolCount = incoming.toolUseCount ?? 0;
  if (currentToolCount > incomingToolCount) {
    return select(current);
  }
  return incomingToolCount > currentToolCount || provenance !== "detail"
    ? select(incoming)
    : select(current);
}

export function sortTasks(tasks: readonly TaskSummary[]): TaskSummary[] {
  return tasks.toSorted((left, right) => {
    const leftAt = Math.max(
      taskTimestampMs(left.updatedAt),
      isActiveTask(left) ? taskTimestampMs(left.execution?.lastActivityAt) : 0,
    );
    const rightAt = Math.max(
      taskTimestampMs(right.updatedAt),
      isActiveTask(right) ? taskTimestampMs(right.execution?.lastActivityAt) : 0,
    );
    return rightAt - leftAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  });
}

export function mergeTaskLists(...lists: readonly (readonly TaskSummary[])[]): TaskSummary[] {
  const byId = new Map<string, TaskSummary>();
  for (const list of lists) {
    for (const task of list) {
      const current = byId.get(task.id);
      byId.set(task.id, current ? newestTaskSnapshot(current, task, "snapshot") : task);
    }
  }
  return sortTasks([...byId.values()]);
}

export function normalizeTasksListResult(
  value: unknown,
): { tasks: TaskSummary[]; nextCursor?: string } | null {
  if (!Value.Check(TasksListResultSchema, value)) {
    return null;
  }
  return {
    tasks: sortTasks(
      value.tasks.map(normalizeTaskSummary).filter((task): task is TaskSummary => task !== null),
    ),
    ...(value.nextCursor !== undefined ? { nextCursor: value.nextCursor } : {}),
  };
}

export function normalizeTasksGetResult(value: unknown): TaskSummary | null {
  return Value.Check(TasksGetResultSchema, value) ? normalizeTaskSummary(value.task) : null;
}

export function normalizeTasksCancelResult(
  value: unknown,
): (Omit<TasksCancelResult, "task"> & { task?: TaskSummary }) | null {
  if (!Value.Check(TasksCancelResultSchema, value)) {
    return null;
  }
  const reason = normalizeOptionalString(value.reason);
  const task = normalizeTaskSummary(value.task);
  return {
    found: value.found,
    cancelled: value.cancelled,
    ...(reason ? { reason } : {}),
    ...(task ? { task } : {}),
  };
}

export function normalizeTasksRecoveryResult(value: unknown):
  | (Omit<TasksRecoveryResult, "results"> & {
      results: Array<Omit<TasksRecoveryResult["results"][number], "task"> & { task?: TaskSummary }>;
    })
  | null {
  if (!Value.Check(TasksRecoveryResultSchema, value)) {
    return null;
  }
  return {
    results: value.results.map((result) => {
      const task = normalizeTaskSummary(result.task);
      const { task: _wireTask, ...rest } = result;
      return { ...rest, ...(task ? { task } : {}) };
    }),
  };
}

export function normalizeTaskEventPayload(value: unknown): TaskEventPayload | null {
  const record = asNullableRecord(value);
  if (record?.action === "restored") {
    return { action: "restored" };
  }
  if (record?.action === "deleted") {
    const taskId = normalizeOptionalString(record.taskId);
    return taskId ? { action: "deleted", taskId } : null;
  }
  if (record?.action === "upserted") {
    const task = normalizeTaskSummary(record.task);
    return task ? { action: "upserted", task } : null;
  }
  return null;
}

export function applyTaskEvent(
  tasks: readonly TaskSummary[],
  value: unknown,
): { tasks: TaskSummary[]; refetch: boolean } {
  const event = normalizeTaskEventPayload(value);
  if (!event || event.action === "restored") {
    return { tasks: [...tasks], refetch: true };
  }
  if (event.action === "deleted") {
    return { tasks: tasks.filter((task) => task.id !== event.taskId), refetch: false };
  }
  const current = tasks.find((task) => task.id === event.task.id);
  const next = current ? newestTaskSnapshot(current, event.task, "event") : event.task;
  return {
    tasks: sortTasks([next, ...tasks.filter((task) => task.id !== next.id)]),
    refetch: false,
  };
}

export function coalesceTaskEvent(
  pending: Map<string, CoalescedTaskEvent>,
  event: Exclude<TaskEventPayload, { action: "restored" }>,
): void {
  if (event.action === "deleted") {
    pending.set(event.taskId, { action: "deleted" });
    return;
  }
  const previous = pending.get(event.task.id);
  pending.set(event.task.id, {
    action: "upserted",
    task:
      previous?.action === "upserted"
        ? newestTaskSnapshot(previous.task, event.task, "event")
        : event.task,
    afterDelete:
      previous?.action === "deleted" || (previous?.action === "upserted" && previous.afterDelete),
  });
}

export function replayTaskEvents(
  tasks: readonly TaskSummary[],
  pending: ReadonlyMap<string, CoalescedTaskEvent>,
): TaskSummary[] {
  let result = [...tasks];
  for (const [taskId, event] of pending) {
    if (event.action === "deleted" || event.afterDelete) {
      result = applyTaskEvent(result, { action: "deleted", taskId }).tasks;
    }
    if (event.action === "upserted") {
      result = applyTaskEvent(result, { action: "upserted", task: event.task }).tasks;
    }
  }
  return result;
}

/** Derived task cache. Its client owns scope/transport; core remains lifecycle authority. */
export class TaskProjection {
  private generation = 0;
  private pending = new Map<string, CoalescedTaskEvent>();
  private currentTasks: TaskSummary[] | null = null;
  private snapshotLoading = false;
  private disposed = false;

  get tasks(): TaskSummary[] | null {
    return this.currentTasks;
  }

  get loading(): boolean {
    return this.snapshotLoading;
  }

  beginSnapshot(): number {
    if (this.disposed) {
      throw new Error("Task projection is disposed");
    }
    this.snapshotLoading = true;
    return ++this.generation;
  }

  applySnapshot(token: number, ...lists: readonly (readonly TaskSummary[])[]): boolean {
    if (!this.isCurrent(token)) {
      return false;
    }
    const byId = new Map((this.currentTasks ?? []).map((task) => [task.id, task]));
    const snapshot = mergeTaskLists(...lists).map((task) => {
      const previous = byId.get(task.id);
      return previous ? newestTaskSnapshot(previous, task, "snapshot") : task;
    });
    this.currentTasks = replayTaskEvents(snapshot, this.pending);
    this.pending.clear();
    this.snapshotLoading = false;
    return true;
  }

  failSnapshot(token: number): boolean {
    if (!this.isCurrent(token)) {
      return false;
    }
    if (this.pending.size) {
      this.currentTasks = replayTaskEvents(this.currentTasks ?? [], this.pending);
    }
    this.pending.clear();
    this.snapshotLoading = false;
    return true;
  }

  applyEvent(value: unknown): { changed: boolean; refetch: boolean } {
    if (this.disposed) {
      return { changed: false, refetch: false };
    }
    const event = normalizeTaskEventPayload(value);
    if (!event) {
      return { changed: false, refetch: true };
    }
    if (event.action === "restored") {
      this.invalidate();
      return { changed: true, refetch: true };
    }
    if (this.snapshotLoading || this.currentTasks === null) {
      coalesceTaskEvent(this.pending, event);
    }
    if (this.currentTasks === null) {
      return { changed: false, refetch: !this.snapshotLoading };
    }
    this.currentTasks = applyTaskEvent(this.currentTasks, event).tasks;
    return { changed: true, refetch: false };
  }

  invalidate(): void {
    this.generation += 1;
    this.pending.clear();
    this.currentTasks = null;
    this.snapshotLoading = false;
  }

  dispose(): void {
    this.invalidate();
    this.disposed = true;
  }

  private isCurrent(token: number): boolean {
    return !this.disposed && this.snapshotLoading && token === this.generation;
  }
}
