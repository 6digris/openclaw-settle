import type { UpdateRunResult } from "../../infra/update-runner.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import type { PreManagedServiceStop } from "./update-command-service-context-types.js";
import {
  createWindowsTaskAutoStartGuard,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
} from "./update-command-service-maintenance.js";
export async function resumeFinalizedUpdateWindowsAutoStart(
  params: Pick<FinishUpdateParams, "root" | "updateStepTimeoutMs">,
  stopped: PreManagedServiceStop | undefined,
  result: UpdateRunResult,
): Promise<void> {
  await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(
    stopped,
    true,
    stopped
      ? createWindowsTaskAutoStartGuard({
          root: result.root ?? params.root,
          before: stopped,
          timeoutMs: params.updateStepTimeoutMs,
        })
      : undefined,
  );
}
