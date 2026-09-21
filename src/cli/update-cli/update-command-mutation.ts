import { resolveConfigPath } from "../../config/paths.js";
import { disableCurrentOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import {
  assertBoundUpdateSelectors,
  beginBoundUpdateMutation,
} from "../../infra/update-bridge-binding.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../../infra/update-managed-service-handoff-cleanup.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import type { UpdateCommandOptions } from "./shared.js";
import type { UpdateCommandExecutor } from "./update-command-executor.js";
import { withOwnedManagedUpdateEnv } from "./update-command-service-env.js";

/** Prepare mutable runtime state only under the admitted installation owner. */
export async function prepareMutableUpdateRuntime(
  env: NodeJS.ProcessEnv | undefined,
  fence: UpdateRecoveryFence,
) {
  return await withOwnedManagedUpdateEnv(env, async () => {
    fence.assertCurrent();
    await cleanupStaleManagedServiceUpdateHandoffs().catch(() => undefined);
    fence.assertCurrent();
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
    });
    fence.assertCurrent();
    await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);
    fence.assertCurrent();
    const records = await loadInstalledPluginIndexInstallRecords();
    fence.assertCurrent();
    return records;
  });
}

export async function beginBridgeMutation(
  opts: UpdateCommandOptions,
  executor: UpdateCommandExecutor,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (opts.bridge === undefined) {
    return;
  }
  assertBoundUpdateSelectors(opts.bridge, {
    configPath: resolveConfigPath(env),
    statePath: resolveOpenClawStateSqlitePath(env),
  });
  const fence = await executor.enter(root, { preflight: true });
  fence.assertCurrent();
  await beginBoundUpdateMutation(opts.bridge, fence, root, () => ({
    configPath: resolveConfigPath(env),
    statePath: resolveOpenClawStateSqlitePath(env),
  }));
}

/** Refusal-only check: package-manager effects must follow the explicitly bound target. */
export function assertBridgePackageTarget(
  opts: UpdateCommandOptions,
  target: {
    root: string;
    updateInstallKind: string;
    packageInstallTarget?: { packageRoot: string | null };
  },
): void {
  if (
    opts.bridge !== undefined &&
    (target.updateInstallKind !== "package" ||
      target.packageInstallTarget?.packageRoot !== target.root)
  ) {
    throw new Error("Update bridge refuses a changed installation kind or package-manager target.");
  }
}
