import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";

export function resolveMutableUpdateMode(params: MutableUpdateExecutionParams) {
  return params.updateInstallKind === "git"
    ? "git"
    : (params.packageInstallTarget?.manager ?? "unknown");
}
