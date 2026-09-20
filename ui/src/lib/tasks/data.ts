import {
  isActiveTask,
  taskTimestampMs,
  type TaskStatus,
  type TaskSummary,
} from "@openclaw/gateway-client/browser";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { t } from "../../i18n/index.ts";
import { formatDurationCompact } from "../format-duration.ts";

const STATUS_LABEL_KEYS = {
  queued: "tasksPage.status.queued",
  running: "tasksPage.status.running",
  completed: "tasksPage.status.completed",
  failed: "tasksPage.status.failed",
  cancelled: "tasksPage.status.cancelled",
  timed_out: "tasksPage.status.timedOut",
} as const satisfies Record<TaskStatus, string>;

export function taskStatusLabel(status: TaskStatus): string {
  return t(STATUS_LABEL_KEYS[status]);
}

export function taskRuntimeLabel(task: TaskSummary): string {
  switch (task.runtime) {
    case "subagent":
      return t("tasksPage.runtime.subagent");
    case "cron":
      return t("tasksPage.runtime.cron");
    case "acp":
      return t("tasksPage.runtime.acp");
    case "cli":
      return t("tasksPage.runtime.cli");
    default:
      return t("tasksPage.runtime.unknown");
  }
}

export function taskTitle(task: TaskSummary): string {
  return (
    task.title ?? task.kind ?? (task.runtime ? taskRuntimeLabel(task) : t("tasksPage.untitled"))
  );
}

export function taskDisplayTitle(task: TaskSummary, detail?: TaskSummary): string {
  if (task.title != null || task.kind != null) {
    return taskTitle(task);
  }
  const prompt = (detail?.prompt ?? task.prompt)?.split(/\r?\n/).find((line) => line.trim());
  const title = prompt?.trim() || task.progressSummary?.trim();
  return title
    ? title.length > 120
      ? `${truncateUtf16Safe(title, 119)}…`
      : title
    : taskTitle(task);
}

export function taskFinishedDuration(task: TaskSummary): string | undefined {
  const startedMs = taskTimestampMs(task.startedAt ?? task.createdAt);
  const endedMs = taskTimestampMs(task.endedAt);
  return !isActiveTask(task) && endedMs > startedMs && startedMs > 0
    ? formatDurationCompact(endedMs - startedMs)
    : undefined;
}

export function taskDetail(task: TaskSummary): string | null {
  if (task.status === "queued" || task.status === "running") {
    if (task.progress) {
      const item = task.progress.items.findLast(
        (entry) =>
          entry.kind !== "analysis" &&
          !entry.hideFromChannelProgress &&
          !entry.suppressChannelProgress,
      );
      return item?.progressText ?? item?.summary ?? item?.title ?? null;
    }
    return task.progressSummary ?? null;
  }
  if (task.status === "failed" || task.status === "timed_out") {
    return task.error ?? task.terminalSummary ?? task.progressSummary ?? null;
  }
  return task.terminalSummary ?? task.error ?? task.progressSummary ?? null;
}

export function partitionTasks(tasks: readonly TaskSummary[]): {
  active: TaskSummary[];
  recent: TaskSummary[];
} {
  const byId = (left: TaskSummary, right: TaskSummary) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  return {
    // Creation is immutable, so progress and queued-to-running transitions cannot move active rows.
    active: tasks
      .filter((task) => task.status === "queued" || task.status === "running")
      .toSorted(
        (left, right) =>
          taskTimestampMs(left.createdAt) - taskTimestampMs(right.createdAt) || byId(left, right),
      ),
    recent: tasks
      .filter((task) => task.status !== "queued" && task.status !== "running")
      .toSorted(
        (left, right) =>
          taskTimestampMs(right.endedAt ?? right.updatedAt ?? right.createdAt) -
            taskTimestampMs(left.endedAt ?? left.updatedAt ?? left.createdAt) || byId(left, right),
      )
      .slice(0, 50),
  };
}
