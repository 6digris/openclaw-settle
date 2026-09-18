/** Owns one sandbox subprocess tree through close, reaping, and backend finalization. */
import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { killProcessTree, spawnProcess } from "openclaw/plugin-sdk/process-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";

const SANDBOX_CHILD_TERM_GRACE_MS = 1_000;
// Bounds admission, remote cleanup, and reaping before reporting cleanup uncertainty.
const SANDBOX_CHILD_REAP_TIMEOUT_MS = 4_500;
const SANDBOX_EXEC_MARKER = "CODEX_SANDBOX_EXEC_ID";

type SandboxChildOutcome = { exitCode: number; signal: NodeJS.Signals | null };

export type SandboxChildCleanup = {
  settled: Promise<SandboxChildOutcome>;
  terminate: () => Promise<SandboxChildOutcome>;
};

export type SandboxChildOwner = SandboxChildCleanup & {
  process: ChildProcessWithoutNullStreams;
};

export async function spawnSandboxChild(params: {
  argv: string[];
  env: NodeJS.ProcessEnv;
  finalizeExec?: NonNullable<SandboxContext["backend"]>["finalizeExec"];
  finalizeToken?: unknown;
  finalizeStatus: (outcome: SandboxChildOutcome) => "completed" | "failed";
  onFinalizeError: (error: unknown) => void;
  owners: Set<SandboxChildCleanup>;
  terminateRemote?: () => Promise<void>;
}): Promise<SandboxChildOwner> {
  const [command, ...args] = params.argv;
  const finalize = async (status: "completed" | "failed", exitCode: number | null) =>
    await params.finalizeExec?.({
      status,
      exitCode,
      timedOut: false,
      token: params.finalizeToken,
    });
  if (!command) {
    await finalize("failed", null).catch(params.onFinalizeError);
    throw new Error("OpenClaw sandbox exec spec did not provide a command.");
  }
  let child: ChildProcess;
  try {
    child = spawnProcess(command, args, {
      detached: process.platform !== "win32",
      env: params.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    await finalize("failed", null).catch(params.onFinalizeError);
    throw error;
  }

  let outcome: SandboxChildOutcome | undefined;
  const closed = new Promise<SandboxChildOutcome>((resolve) => {
    child.once("close", (code, signal) => resolve((outcome = { exitCode: code ?? 1, signal })));
  });
  const spawned = once(child, "spawn");
  void spawned.catch(() => undefined);
  let started = false;
  let finalizePromise: Promise<void> | undefined;
  let terminationCleanup: Promise<void> | undefined;
  let terminationError: Error | undefined;
  const settled = closed.then(async (result) => {
    await terminationCleanup;
    child.stdin?.destroy();
    await (finalizePromise ??= finalize(
      started ? params.finalizeStatus(result) : "failed",
      started ? result.exitCode : null,
    ));
    return result;
  });
  void settled.catch(params.onFinalizeError);

  let terminationPromise: Promise<SandboxChildOutcome> | undefined;
  const owner: SandboxChildCleanup = {
    settled,
    terminate: () =>
      (terminationPromise ??= (async () => {
        child.stdin?.destroy();
        // Keep late admission owned after the caller's reap deadline: its eventual
        // PID still needs remote cleanup and group signals, never a raw pending kill.
        terminationCleanup = (async () => {
          await spawned.catch(() => undefined);
          child.stdin?.destroy();
          await params.terminateRemote?.().catch((error: unknown) => {
            terminationError = error instanceof Error ? error : new Error(String(error));
          });
          if (!outcome) {
            if (child.pid) {
              killProcessTree(child.pid, {
                detached: process.platform !== "win32",
                graceMs: SANDBOX_CHILD_TERM_GRACE_MS,
              });
            } else {
              child.kill("SIGTERM");
            }
          }
        })();
        const reaped = await Promise.race([
          terminationCleanup.then(() => closed).then(() => true),
          delay(SANDBOX_CHILD_REAP_TIMEOUT_MS).then(() => false),
        ]);
        if (!reaped) {
          throw new Error(
            `Sandbox child process tree ${child.pid ?? "unknown"} survived SIGKILL; tear down the sandbox environment and inspect the surviving process tree before retrying.`,
          );
        }
        const result = await settled;
        if (terminationError) {
          throw terminationError;
        }
        return result;
      })()),
  };
  params.owners.add(owner);
  void settled.then(
    () => params.owners.delete(owner),
    () => params.owners.delete(owner),
  );
  try {
    // Broker pipe handles arrive with spawn; shutdown owns the child while waiting.
    await spawned;
  } catch (error) {
    await settled.catch(() => undefined);
    throw error;
  }
  if (!hasPipedStdio(child)) {
    await owner.terminate();
    throw new Error("OpenClaw sandbox child did not provide piped stdio.");
  }
  if (terminationPromise) {
    await terminationPromise;
    throw new Error("OpenClaw sandbox process start cancelled.");
  }
  started = true;
  return { ...owner, process: child };
}

function hasPipedStdio(child: ChildProcess): child is ChildProcessWithoutNullStreams {
  return child.stdin !== null && child.stdout !== null && child.stderr !== null;
}

export function prepareSandboxChildExec(
  backend: NonNullable<SandboxContext["backend"]>,
  env: Record<string, string>,
): { env: Record<string, string>; terminate: () => Promise<void> } {
  const marker = randomUUID();
  return {
    env: { ...env, [SANDBOX_EXEC_MARKER]: marker },
    terminate: async () => {
      const result = await backend.runShellCommand({
        script: SANDBOX_REMOTE_TERMINATE_SCRIPT,
        args: [`${SANDBOX_EXEC_MARKER}=${marker}`],
        allowFailure: true,
        signal: AbortSignal.timeout(SANDBOX_CHILD_REAP_TIMEOUT_MS),
      });
      if (result.code !== 0) {
        const detail =
          result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
        throw new Error(
          detail ||
            `Sandbox process tree cleanup failed with code ${result.code}; tear down the sandbox environment and inspect surviving processes before retrying.`,
        );
      }
    },
  };
}

const SANDBOX_REMOTE_TERMINATE_SCRIPT = String.raw`
find_owned_pids() {
  for env_file in /proc/[0-9]*/environ; do
    if [ -r "$env_file" ] && tr '\0' '\n' < "$env_file" 2>/dev/null | grep -Fqx "$1"; then
      basename "$(dirname "$env_file")"
    fi
  done
}
owned="$(find_owned_pids "$1")"
[ -z "$owned" ] || kill -TERM $owned 2>/dev/null || true
sleep 1
owned="$(find_owned_pids "$1")"
[ -z "$owned" ] || kill -KILL $owned 2>/dev/null || true
sleep 1
owned="$(find_owned_pids "$1")"
[ -z "$owned" ] || { echo "Sandbox process IDs survived SIGKILL: $owned" >&2; exit 1; }
`.trim();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
