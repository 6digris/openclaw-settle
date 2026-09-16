import { formatErrorMessage } from "../../infra/errors.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import {
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "../../infra/update-run-recovery.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { FinishUpdateParams } from "./update-command-finish-types.js";
import { UpdateCommandPendingRecoveryFailure } from "./update-command-result.js";

export class UpdateCommandRecoveryPendingError extends Error {
  override name = "UpdateCommandRecoveryPendingError";
}

/** Refuse retained recovery before any package-only effects or diagnostic writes. */
export function assertUpdateCommandRecovery(opts: UpdateCommandOptions): void {
  opts.run?.executorFence?.assertCurrent();
  if (opts.recovery) {
    throw new UpdateCommandRecoveryPendingError(
      "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
    );
  }
  if (opts.run) {
    const current = loadUpdateRecovery(opts.run.runId, { env: opts.run.env });
    if (current) {
      throw new UpdateRecoveryRequiredError(current);
    }
  }
}

/** Inspect each selected state path once before recovery can perform native effects. */
export async function assertUpdateProfileRecoveryAdmission(
  environments: readonly (NodeJS.ProcessEnv | undefined)[],
  assertCurrent?: () => void,
): Promise<void> {
  const admittedPaths = new Set<string>();
  for (const env of environments) {
    const targetPath = resolveOpenClawStateSqlitePath(env);
    if (!admittedPaths.has(targetPath)) {
      await assertUpdateRecoveryAdmission({ env, path: targetPath });
      assertCurrent?.();
      admittedPaths.add(targetPath);
    }
  }
}

/** Package-only finalization cannot adopt a retained full-state claim. */
export async function assertUpdateCommandPackageFinalization(
  params: Pick<FinishUpdateParams, "opts" | "result" | "profiles">,
): Promise<void> {
  const run = params.opts.run;
  const assertCurrent = createUpdateCommandFinalizationFence(params);
  try {
    assertCurrent();
    if (params.opts.recovery) {
      throw new Error(
        "Full-state checkpoint recovery is deferred; retained state was left unchanged.",
      );
    }
    await assertUpdateProfileRecoveryAdmission(
      [
        ...params.profiles.map((profile) => profile.ownedManagedUpdateEnv ?? run?.env),
        ...(run ? [run.env] : []),
      ],
      assertCurrent,
    );
  } catch (cause) {
    if (cause instanceof UpdateCommandPendingRecoveryFailure) {
      throw cause;
    }
    throw new UpdateCommandPendingRecoveryFailure(params.result, formatErrorMessage(cause), {
      cause,
    });
  }
}

/** Hold the originally admitted executor through package finalization awaits. */
export function createUpdateCommandFinalizationFence(
  params: Pick<FinishUpdateParams, "opts" | "result">,
): () => void {
  const originalRun = params.opts.run;
  const executor = originalRun?.executorFence;
  return () => {
    try {
      if (params.opts.run !== originalRun || originalRun?.executorFence !== executor) {
        throw new Error("Package finalization lost its original executor.");
      }
      executor?.assertCurrent();
    } catch (cause) {
      throw new UpdateCommandPendingRecoveryFailure(params.result, formatErrorMessage(cause), {
        cause,
      });
    }
  };
}
