import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";

/** Resolve the installed or source worker without adapters depending on core file layout. */
export function resolveWorkspaceWorkerArgv(kind: "memory" | "skills"): string[] {
  const entry =
    kind === "memory"
      ? runtimeProcessEntrypoints.workspaceMemory
      : runtimeProcessEntrypoints.workspaceSkills;
  return resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(entry));
}
