import { waitForLocalTuiUpdate } from "../infra/local-tui-processes.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";

/** Waits until this installation is no longer being replaced by an updater. */
export async function prepareTuiStartup(params: {
  local?: boolean;
  backend?: unknown;
}): Promise<boolean> {
  const targetRoot = resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    moduleUrl: import.meta.url,
  });
  if (!targetRoot) {
    throw new Error("Unable to identify this OpenClaw installation before TUI startup.");
  }
  await waitForLocalTuiUpdate(targetRoot);
  return params.local === true || params.backend !== undefined;
}
