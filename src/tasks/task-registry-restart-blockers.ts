// Select and project restart blockers without treating retained repair history as live work.
import type { TaskRecord } from "./task-registry.types.js";
import type { ActiveTaskRestartBlocker } from "./task-restart-blocker.js";
import { triageTaskExecutionPhase } from "./triage-task.js";

export function isTaskRestartBlocker(task: TaskRecord): task is TaskRecord & {
  status: ActiveTaskRestartBlocker["status"];
} {
  // A task that is merely queued has not started user work yet; durable queued
  // work can survive a gateway restart and should not indefinitely block one.
  // Likewise, stale records that still say "running" but already have endedAt
  // are registry inconsistencies, not live restart blockers.
  return task.status === "running" && !task.endedAt;
}

export function collectTaskRestartBlockers(
  tasks: Iterable<TaskRecord>,
): ActiveTaskRestartBlocker[] {
  const blockers: ActiveTaskRestartBlocker[] = [];
  for (const task of tasks) {
    if (!isTaskRestartBlocker(task)) {
      continue;
    }
    // Retained repair history is not evidence of live work. Unknown or ended
    // backing stays unconfirmed without delaying a restart or rewriting the row.
    if (
      task.runtime === "cli" &&
      task.taskKind === "triage_repair" &&
      !triageTaskExecutionPhase(task)
    ) {
      continue;
    }
    const blocker: ActiveTaskRestartBlocker = {
      taskId: task.taskId,
      status: task.status,
      runtime: task.runtime,
    };
    if (task.taskKind) {
      blocker.taskKind = task.taskKind;
    }
    if (task.runId) {
      blocker.runId = task.runId;
    }
    if (task.label) {
      blocker.label = task.label;
    }
    if (task.task) {
      blocker.title = task.task;
    }
    blockers.push(blocker);
  }
  return blockers;
}
