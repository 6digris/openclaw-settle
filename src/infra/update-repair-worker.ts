import { spawn } from "node:child_process";
import path from "node:path";
import type { UpdateCommandChildGrant } from "../cli/update-cli/update-command-executor.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { createCommandTerminationController } from "../process/exec-termination.js";
import { installationTargetEnv } from "./installation-target-context.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import {
  UPDATE_REPAIR_IPC_MAX_BYTES,
  updateRepairParentMessageSchema,
  updateRepairWorkerMessageSchema,
  type UpdateRepairParentMessage,
  type UpdateRepairParams,
  type UpdateRepairTurnResult,
  type UpdateRepairTurnRunner,
} from "./update-repair-protocol.js";

/** Loaded before replacement; inference imports belong entirely to the update child. */
export async function runUpdateRepairWorker(
  params: UpdateRepairParams & { runId: string },
  turn: Parameters<UpdateRepairTurnRunner>[0],
  executor: UpdateCommandChildGrant,
  bindChild: (pid: number) => void,
): Promise<UpdateRepairTurnResult> {
  const clean = (value: unknown) =>
    redactSupportString(
      value instanceof Error ? value.message : String(value),
      { env: process.env, stateDir: params.target.stateDir },
      { maxLength: 1024 },
    );
  const stopped = (status: "unavailable" | "aborted", reason: string): UpdateRepairTurnResult => ({
    status,
    reason,
  });
  const deadline = Date.now() + turn.wallClockMs;
  const signal = turn.signal;
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (params.isCurrent?.() === false) {
      throw new Error("Repair no longer owns the update attempt.");
    }
  };
  try {
    assertCurrent();
  } catch (error) {
    return stopped("aborted", clean(error));
  }
  const { installRoot } = params.target;
  const env = {
    ...(params.admissionEnv ?? {
      ...process.env,
      ...installationTargetEnv({
        stateDir: params.target.stateDir,
        configPath: params.target.configPath,
        defaultWorkspaceDir: params.target.workspaceDir,
      }),
    }),
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
  let child;
  try {
    child = spawn(
      params.nodeRunner ?? process.execPath,
      [path.join(installRoot, "dist", runtimeProcessEntrypoints.updateRepair.distWorkerPath)],
      {
        cwd: installRoot,
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
  } catch (error) {
    return stopped("unavailable", clean(error));
  }
  let childExited = false;
  let commandSettled = false;
  let result: UpdateRepairTurnResult | undefined;
  let failure: string | undefined;
  let stopping = false;
  let started = false;
  let routeSelected = false;
  const cancelController = new AbortController();
  const termination = createCommandTerminationController({
    child,
    cancelController,
    env,
    processTree: { mode: "graceful" },
    killGraceMs: 1_000,
    isChildExited: () => childExited,
    isCommandSettled: () => commandSettled,
  });
  cancelController.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  const stop = (error: unknown) => {
    if (stopping) {
      return;
    }
    stopping = true;
    failure ??= clean(error);
    if (!termination.terminate()) {
      cancelController.abort();
    }
  };
  const send = (message: UpdateRepairParentMessage) => {
    if (!child.connected) {
      stop(new Error("Update repair worker closed its control channel."));
      return;
    }
    if (Buffer.byteLength(JSON.stringify(message)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
      stop(new Error("Update repair message exceeded its bounded diagnostic budget."));
      return;
    }
    child.send(message, (error) => {
      if (error) {
        stop(error);
      }
    });
  };
  const onAbort = () => {
    if (child.connected) {
      send({ type: "cancel", reason: clean(signal.reason) });
    }
    stop(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  child.on("message", (raw: unknown) => {
    if (stopping) {
      return;
    }
    try {
      assertCurrent();
      if (Buffer.byteLength(JSON.stringify(raw)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
        throw new Error("Update repair response exceeded its bounded diagnostic budget.");
      }
      const message = updateRepairWorkerMessageSchema.parse(raw);
      if (message.type === "ready") {
        if (started) {
          throw new Error("Update repair worker repeated startup.");
        }
        if (!message.repairTurns || message.executorDelegation !== "pid-start-v1") {
          throw new Error(
            "This update runtime cannot accept delegated repair. Run openclaw triage to diagnose the installation.",
          );
        }
        started = true;
        send(
          updateRepairParentMessageSchema.parse({
            type: "turn",
            runId: params.runId,
            requester: params.requester,
            target: params.target,
            executor,
            prompt: turn.prompt,
            timeoutMs: turn.timeoutMs,
            wallClockMs: Math.max(1, deadline - Date.now()),
            maxToolCalls: turn.maxToolCalls,
          }),
        );
      } else if (message.type === "event" && message.event.type === "route-selected") {
        if (!started || routeSelected || result) {
          throw new Error("Update repair worker reported an unexpected inference route.");
        }
        routeSelected = true;
        turn.onRoute({ model: message.event.model, provider: message.event.provider });
      } else if (message.type === "turn-result" && started && !result) {
        result = message.result;
      } else {
        throw new Error("Update repair worker sent an unexpected message.");
      }
    } catch (error) {
      stop(error);
    }
  });
  child.once("disconnect", () => {
    if (!result) {
      stop(new Error("Update repair worker closed its control channel."));
    }
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      failure ??= clean(error);
    });
    child.once("exit", () => {
      childExited = true;
    });
    child.once("close", (code) => {
      commandSettled = true;
      resolve(code);
    });
  });
  try {
    if (!child.pid) {
      throw new Error("Update repair worker has no process identity.");
    }
    bindChild(child.pid);
  } catch (error) {
    stop(error);
  }
  try {
    const code = await closed;
    await termination.settle();
    assertCurrent();
    return result && code === 0 && !failure
      ? result
      : stopped(
          "unavailable",
          failure ??
            "Update repair stopped without a result. Run openclaw triage to diagnose the installation.",
        );
  } catch (error) {
    return stopped("aborted", clean(error));
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
