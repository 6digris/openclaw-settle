// The lifecycle owner's lexical runtime location crosses worker and process boundaries.
import { AsyncLocalStorage } from "node:async_hooks";
import os from "node:os";
import path from "node:path";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
export type StateDatabaseCoordinatorRuntime = Readonly<{
  directory: string;
  keepAlive: boolean;
}>;
const coordinatorRuntimeDirectories = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseCoordinatorRuntime"),
  () => new AsyncLocalStorage<StateDatabaseCoordinatorRuntime>(),
);
export function resolveStateLifecycleRuntimeDirectory(): string {
  const captured = coordinatorRuntimeDirectories.getStore();
  if (captured !== undefined) {
    return captured.directory;
  }
  return process.platform === "win32"
    ? path.join(os.homedir(), "AppData", "Local", "OpenClaw", "locks")
    : "/tmp";
}

/** Capture the directory owner's retention policy before crossing an async or worker boundary. */
export function captureStateDatabaseCoordinatorRuntime(): StateDatabaseCoordinatorRuntime {
  const captured = coordinatorRuntimeDirectories.getStore();
  return captured
    ? { ...captured }
    : { directory: resolveStateLifecycleRuntimeDirectory(), keepAlive: true };
}

export function withStateDatabaseCoordinatorRuntimeDirectory<T>(
  runtime: string | StateDatabaseCoordinatorRuntime,
  operation: () => T,
): T {
  const captured =
    typeof runtime === "string" ? { directory: runtime, keepAlive: false } : { ...runtime };
  return coordinatorRuntimeDirectories.run(captured, operation);
}
