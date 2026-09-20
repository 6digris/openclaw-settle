// Only the original parent may project its joined and validated operator result.
import { realpathSync } from "node:fs";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import type { InstallationTarget } from "../infra/installation-target-context.js";
import { observeTriageBacking } from "../infra/triage-backing.js";
import type { continueTriageInFreshProcess } from "../infra/triage-continuation.js";
import type { UpdateRepairResult } from "../infra/update-repair-protocol.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { listTaskRecords, reloadTaskRuntimeStateFromStore } from "../tasks/runtime-internal.js";
import { publishTaskRecordUpdate } from "../tasks/task-registry-mutation.js";
import { getTaskRegistryStore } from "../tasks/task-registry.store.js";
import { readTriageTaskDetail } from "../tasks/triage-task.js";
import type { StartupTriageResult } from "./triage-startup.js";

type JoinedTriage = Extract<
  Awaited<ReturnType<typeof continueTriageInFreshProcess>>,
  { status: "completed" }
>;

export async function settleTriageRepairTask(
  params: {
    taskId?: string;
    outcome: JoinedTriage;
    root: string;
    target: InstallationTarget;
    updateRunId?: string;
    signal: AbortSignal;
    isCurrent?: () => boolean;
  } & (
    | { repair: UpdateRepairResult; startup?: never }
    | { startup: StartupTriageResult; repair?: never }
  ),
): Promise<void> {
  if (!params.taskId || params.signal.aborted || params.isCurrent?.() === false) {
    return;
  }
  try {
    const succeeded = params.startup
      ? params.startup.after.ok
      : params.repair.status === "repaired" && params.repair.finalValidation.ok;
    if (
      params.startup &&
      (params.startup.installationRoot !== params.root ||
        params.startup.generationOwner !== params.outcome.generationOwner)
    ) {
      return;
    }
    // The registry is process-profile scoped. Never fall back to another profile
    // or temporarily retarget its global store to finalize an operator task.
    const stateDir = resolveStateDir();
    if (
      realpathSync(stateDir) !== realpathSync(params.target.stateDir) ||
      resolveConfigPath() !== params.target.configPath ||
      params.outcome.installationRoot !== params.root ||
      (params.repair?.status === "repaired" && !params.repair.finalValidation.ok)
    ) {
      return;
    }
    await reloadTaskRuntimeStateFromStore();
    if (
      params.signal.aborted ||
      params.isCurrent?.() === false ||
      realpathSync(resolveStateDir()) !== realpathSync(stateDir) ||
      resolveConfigPath() !== params.target.configPath
    ) {
      return;
    }
    const tasks = listTaskRecords((task) => task.runId === params.outcome.generationOwner);
    const task = tasks.find((candidate) => candidate.taskId === params.taskId);
    const detail = task && readTriageTaskDetail(task);
    if (
      !task ||
      !detail ||
      task.taskId !== params.taskId ||
      task.status !== "running" ||
      task.endedAt !== undefined ||
      task.scopeKind !== "system" ||
      task.ownerKey !== "" ||
      task.requesterSessionKey !== "" ||
      task.childSessionKey !== undefined ||
      detail.originalUpdateRunId !== params.updateRunId ||
      asOptionalRecord(detail.backing)?.installationRoot !== params.root ||
      observeTriageBacking(detail.backing).kind !== "absent"
    ) {
      return;
    }
    // Absence is only a consistency check after the original parent's joined
    // result. It never establishes completion by itself or supplies authority.
    if (params.signal.aborted || params.isCurrent?.() === false) {
      return;
    }
    const summary = succeeded
      ? params.startup
        ? "Startup repair checks passed. Gateway activation remains unconfirmed."
        : "Repair checks passed. Gateway activation remains unconfirmed."
      : `Repair incomplete: ${redactSupportString(params.startup ? params.startup.after.summary : (params.repair.reason ?? params.repair.finalValidation.summary), { env: process.env, stateDir }, { maxLength: 1024 })}`;
    const store = getTaskRegistryStore();
    const settled = store.settleTriageTask?.({
      expected: task,
      status: succeeded ? "succeeded" : "failed",
      endedAt: Date.now(),
      terminalSummary: summary,
      assertCurrent: () => {
        params.signal.throwIfAborted();
        if (
          params.isCurrent?.() === false ||
          getTaskRegistryStore() !== store ||
          realpathSync(resolveStateDir()) !== realpathSync(stateDir) ||
          resolveConfigPath() !== params.target.configPath
        ) {
          throw new Error("The original triage task owner is no longer current.");
        }
      },
    });
    if (settled) {
      // Reuse canonical terminal publication and linked-flow updates after the exact-row commit.
      publishTaskRecordUpdate(task, settled, true);
    }
  } catch {
    // Result projection is optional. A failed task write is not repair failure
    // and cannot manufacture successful task completion or retry permission.
  }
}
