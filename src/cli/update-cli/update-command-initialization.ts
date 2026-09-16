import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { resolveConfigPath } from "../../config/paths.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import { SQLITE_SIDECAR_SUFFIXES } from "../../infra/sqlite-files.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import { compareSemverStrings } from "../../infra/update-check.js";
import { canResolveRegistryVersionForPackageTarget } from "../../infra/update-global.js";
import { assertUpdateRecoveryAdmission } from "../../infra/update-run-recovery-admission.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { createUpdateProgress, type UpdateDisplayProgress } from "./progress.js";
import {
  requestUpdateDowngradeConfirmation,
  resolveGitInstallDir,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import {
  withUpdateCommandExecutor,
  type UpdateCommandExecutor,
} from "./update-command-executor.js";
import type { StagedPackageInstallUpdate } from "./update-command-package.js";
import { runPackageUpdateDoctor } from "./update-command-package.js";
import { UnreportedUpdateAdmissionOutcome } from "./update-command-result.js";
import type { prepareUpdateCommand } from "./update-command-run.js";
import { preflightUpdateCommandSchemas, previewUpdateCommand } from "./update-command-schema.js";
import {
  withOwnedManagedUpdateEnv,
  resolveUpdateTargetEnv,
  withUpdateInProgressEnv,
} from "./update-command-service-env.js";
import { resolvePackageRuntimePreflight } from "./update-command-service-plan.js";
import type { UpdateCommandRecoveryState } from "./update-command-service.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";
import {
  reportUnreportedUpdateAdmissionOutcome,
  withUpdateCommandTerminalResult,
} from "./update-command-terminal.js";
import { prepareUpdateCommandFailureTriage } from "./update-command-triage.js";

export type InitializedUpdate = {
  env: NodeJS.ProcessEnv;
  runId: string;
  executor: UpdateCommandExecutor;
  freebsdRootFence?: UpdateRecoveryFence;
  registerRun: (run: NonNullable<UpdateCommandOptions["run"]>) => Promise<void>;
  target: NonNullable<Awaited<ReturnType<typeof resolveUpdateCommandTarget>>>;
  databasePath: string;
  configPath: string;
  stagedPackage?: StagedPackageInstallUpdate;
  downgradeConfirmed?: boolean;
};

async function confirmFreshUpdateDowngrade(params: {
  target: InitializedUpdate["target"];
  opts: UpdateCommandOptions;
  controlPlaneUpdateSentinelMeta: ConstructorParameters<
    typeof UnreportedUpdateAdmissionOutcome
  >[0]["controlPlaneUpdateSentinelMeta"];
}): Promise<void> {
  const { target, opts } = params;
  if (!target.downgradeRisk || opts.yes) {
    return;
  }
  const decision = await requestUpdateDowngradeConfirmation({
    json: Boolean(opts.json),
    currentVersion: target.currentVersion,
    targetVersion: target.targetVersion,
    tag: target.tag,
  });
  if (decision === "confirmed") {
    return;
  }
  throw new UnreportedUpdateAdmissionOutcome(
    {
      root: target.root,
      installKind: target.updateInstallKind,
      opts,
      controlPlaneUpdateSentinelMeta: params.controlPlaneUpdateSentinelMeta,
      reason: decision === "cancelled" ? "cancelled" : "downgrade-confirmation-required",
      message:
        decision === "cancelled"
          ? "Update cancelled."
          : "Downgrade confirmation required.\nDowngrading can break configuration. Re-run in a TTY to confirm.",
    },
    { exitCode: decision === "cancelled" ? 0 : 1 },
  );
}

/** Keep the original outcome when its owned-state cleanup also fails. */
export async function withUpdateInitializationCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => void | Promise<void>,
): Promise<T> {
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      if (cleanupError === error) {
        throw error;
      }
      throw new AggregateError([error, cleanupError], "Update initialization and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
  await cleanup();
  return result;
}

/** Missing state is not permission to recreate an interrupted database family. */
export async function updateStateNeedsInitialization(env: NodeJS.ProcessEnv): Promise<boolean> {
  await assertUpdateRecoveryAdmission({ env });
  const databasePath = resolveOpenClawStateSqlitePath(env);
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath,
    env,
    recoverOrphanedSidecars: false,
  });
  try {
    await fs.lstat(databasePath);
    return false;
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try {
      await fs.lstat(`${databasePath}${suffix}`);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    throw new UpdatePreMutationError(
      "target-state-initialization",
      "The state database is missing but SQLite sidecars remain. Preserve the database family and restore its main file before updating.",
    );
  }
  return true;
}

export function acquireLegacyUpdateInitializationFence(params: {
  env: NodeJS.ProcessEnv;
  targetVersion: string;
  targetSchemas: OpenClawSchemaVersions;
}) {
  const databasePath = resolveOpenClawStateSqlitePath(params.env);
  const comparison = compareSemverStrings(params.targetVersion, "2026.7.1");
  // Released schema-1 writers through 2026.7.1 predate the external schema
  // coordinator. Hold its existing Gateway fence so a modern process cannot
  // create/migrate this profile while that legacy child initializes it.
  return params.targetSchemas.state === 1 && comparison !== null && comparison <= 0
    ? acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 0 })
    : undefined;
}

/** The selected release owns bootstrap; the parent may only inspect its result. */
export async function initializeUpdateStateFromTarget(
  params: Parameters<typeof runPackageUpdateDoctor>[0] & {
    env: NodeJS.ProcessEnv;
    assertCurrent: () => void;
    checkSchemas: () => Promise<void>;
  },
): Promise<void> {
  await params.checkSchemas();
  params.assertCurrent();
  // npm lifecycle hooks may already have created the database. The selected
  // Doctor must still validate and migrate authored config before activation.
  await updateStateNeedsInitialization(params.env);
  params.assertCurrent();
  const result = await runPackageUpdateDoctor({ ...params, managedServiceEnv: params.env });
  params.assertCurrent();
  await params.checkSchemas();
  if (!result || (result.exitCode !== 0 && !result.advisory)) {
    throw new UpdatePreMutationError(
      "target-state-initialization",
      result?.stderrTail ?? "The selected release could not initialize its state database.",
    );
  }
  if (await updateStateNeedsInitialization(params.env)) {
    throw new UpdatePreMutationError(
      "target-state-initialization",
      "The selected release did not initialize a compatible state database.",
    );
  }
}

/** Fresh-profile ownership must enclose the admitted run and all of its cleanup. */
export async function initializeAndRunUpdate(params: {
  opts: UpdateCommandOptions;
  prepared: NonNullable<Awaited<ReturnType<typeof prepareUpdateCommand>>>;
  recoveryState: UpdateCommandRecoveryState;
  invocationCwd: string | undefined;
  env: NodeJS.ProcessEnv;
  updateStepTimeoutMs: number;
  runAdmitted: (initialization: InitializedUpdate) => Promise<void>;
}): Promise<void> {
  const { opts, prepared, recoveryState, invocationCwd, env, updateStepTimeoutMs } = params;
  const runId = env.OPENCLAW_UPDATE_RUN_ID?.trim() || randomUUID();
  let handleFailure: Awaited<ReturnType<typeof prepareUpdateCommandFailureTriage>> | undefined;
  try {
    await withUpdateCommandTerminalResult(
      (registerRun) =>
        withUpdateInProgressEnv(invocationCwd, () =>
          withUpdateCommandExecutor(runId, async (executor) => {
            const target = await withOwnedManagedUpdateEnv(env, () =>
              resolveUpdateCommandTarget(
                opts,
                recoveryState,
                invocationCwd,
                prepared,
                executor,
                updateStepTimeoutMs,
              ),
            );
            if (!target) {
              return;
            }
            const freebsdRootFence = prepared.freebsdRootAdmission
              ? await executor.enter(target.root, { preflight: true })
              : undefined;
            const assertInitializationCurrent = () => {
              prepared.freebsdRootAdmission?.assertCurrent();
              freebsdRootFence?.assertCurrent();
            };
            const revalidateInitialization = async (candidateRoot?: string) => {
              if (!prepared.freebsdRootAdmission || !freebsdRootFence) {
                return;
              }
              await prepared.freebsdRootAdmission.revalidate(
                {
                  roots: [
                    prepared.discoveredRoot,
                    target.root,
                    ...(target.packageInstallTarget?.packageRoot
                      ? [target.packageInstallTarget.packageRoot]
                      : []),
                    ...(target.switchToGit ? [resolveGitInstallDir()] : []),
                    ...(candidateRoot ? [candidateRoot] : []),
                  ],
                  env,
                  timeoutMs: prepared.timeoutMs,
                },
                freebsdRootFence.assertCurrent,
              );
            };
            if (freebsdRootFence) {
              await revalidateInitialization();
            }
            const initialization: InitializedUpdate = {
              env,
              runId,
              executor,
              ...(freebsdRootFence ? { freebsdRootFence } : {}),
              registerRun: async (run) => {
                registerRun(run);
                handleFailure = await prepareUpdateCommandFailureTriage(
                  { ...opts, invocationCwd, run },
                  recoveryState.triageTarget,
                );
              },
              target,
              databasePath: resolvePathViaExistingAncestorSync(resolveOpenClawStateSqlitePath(env)),
              configPath: resolvePathViaExistingAncestorSync(resolveConfigPath(env)),
            };
            const runInitialized = () => params.runAdmitted(initialization);
            if (opts.dryRun) {
              return await previewUpdateCommand({
                target,
                prepared,
                opts,
                runId,
                invocationCwd,
                updateStepTimeoutMs,
              });
            }
            const artifact =
              target.updateInstallKind === "package" &&
              !canResolveRegistryVersionForPackageTarget(target.packageInstallSpec ?? target.tag);
            const stageParams = (progress: UpdateDisplayProgress) => ({
              reapplyLocalOverrides: opts.reapplyLocalOverrides,
              root: target.root,
              installKind: prepared.installKind,
              tag: target.tag,
              installSpec: target.packageInstallSpec ?? undefined,
              timeoutMs: updateStepTimeoutMs,
              startedAt: prepared.startedAt,
              progress,
              managedServiceEnv: env,
              invocationCwd,
              honorPackageRoot:
                target.managedServiceRootRedirect !== null ||
                target.managedServiceNodeRunner !== undefined,
              nodeRunner: target.packageUpdateNodeRunner,
              installEnv: resolveUpdateTargetEnv({
                baseEnv: target.packageInstallEnv,
                serviceEnv: env,
                invocationCwd,
              }),
              installTarget: target.packageInstallTarget,
              ...(freebsdRootFence ? { assertCurrent: assertInitializationCurrent } : {}),
            });
            const runSelectedTarget = async () => {
              if (target.updateInstallKind !== "package") {
                return await runInitialized();
              }
              const schemas = target.packageTargetSchemaVersions;
              if (!target.targetVersion || !schemas) {
                return await target.refuseUpdate(
                  "target-metadata-preflight",
                  "The selected package could not be resolved to a published release with known database support. Retry with an exact published --tag before initializing this profile.",
                );
              }
              if (schemas.state >= OPENCLAW_STATE_SCHEMA_VERSION && !artifact) {
                return await runInitialized();
              }
              const timeoutMs = updateStepTimeoutMs;
              const selectedStoredChannel = target.storedChannel;
              const checkSchemas = async () => {
                const { readUpdateChannelConfig } = await import("./update-command-config.js");
                const config = await withOwnedManagedUpdateEnv(env, () =>
                  readUpdateChannelConfig(Boolean(opts.channel)),
                );
                if (!opts.channel && config.storedChannel !== selectedStoredChannel) {
                  await target.refuseUpdate(
                    "update-channel-changed",
                    "Stored update channel changed after target selection. Rerun the update, or specify --channel explicitly.",
                  );
                }
                Object.assign(target, config);
                await preflightUpdateCommandSchemas({
                  ...target,
                  shouldRestart: prepared.shouldRestart,
                  updateStepTimeoutMs: timeoutMs,
                  invocationCwd,
                  packageTargetVersion: target.targetVersion ?? undefined,
                  opts,
                });
              };
              await checkSchemas();
              await confirmFreshUpdateDowngrade({
                target,
                opts,
                controlPlaneUpdateSentinelMeta: prepared.controlPlaneUpdateSentinelMeta,
              });
              initialization.downgradeConfirmed = true;
              const runtime = await resolvePackageRuntimePreflight({
                root: target.root,
                shouldRestart: prepared.shouldRestart,
                target: target.packageRuntimeTarget,
                timeoutMs,
                nodeRunner: target.managedServiceNodeRunner,
              });
              if (!runtime.ok) {
                const { error, failureFacts } = runtime;
                return await target.refuseUpdate("node-runtime-preflight", error, failureFacts);
              }
              target.packageUpdateNodeRunner = runtime.value.nodeRunner;
              if (schemas.state >= OPENCLAW_STATE_SCHEMA_VERSION) {
                return await runInitialized();
              }
              const fence = await executor.enter(target.root, { preflight: true });
              fence.assertCurrent();
              if (freebsdRootFence) {
                await revalidateInitialization();
              }
              const { stagePackageInstallUpdate } = await import("./update-command-package.js");
              const legacyFence = acquireLegacyUpdateInitializationFence({
                env,
                targetVersion: target.targetVersion,
                targetSchemas: schemas,
              });
              await withUpdateInitializationCleanup(
                async () => {
                  await withUpdateInitializationCleanup(
                    async () => {
                      const presentation = createUpdateProgress(!opts.json);
                      try {
                        await checkSchemas();
                        fence.assertCurrent();
                        if (!target.packageAlreadyCurrent && !initialization.stagedPackage) {
                          initialization.stagedPackage = await stagePackageInstallUpdate(
                            stageParams(presentation.progress),
                          );
                        }
                        fence.assertCurrent();
                        if (freebsdRootFence) {
                          await revalidateInitialization(initialization.stagedPackage?.root);
                        }
                        await initializeUpdateStateFromTarget({
                          root: initialization.stagedPackage?.root ?? target.root,
                          env,
                          timeoutMs,
                          nodeRunner: target.packageUpdateNodeRunner,
                          invocationCwd,
                          progress: presentation.progress,
                          assertCurrent: freebsdRootFence
                            ? assertInitializationCurrent
                            : fence.assertCurrent,
                          checkSchemas,
                        });
                      } finally {
                        presentation.dispose();
                      }
                    },
                    () => legacyFence?.release(),
                  );
                  await runInitialized();
                },
                () => (artifact ? undefined : initialization.stagedPackage?.close()),
              );
            };
            if (!artifact) {
              return await runSelectedTarget();
            }
            const { runFreshUpdateArtifact } = await import("./update-command-artifact.js");
            return await runFreshUpdateArtifact(
              { initialization, stageParams, json: Boolean(opts.json) },
              runSelectedTarget,
            );
          }),
        ),
      opts,
    );
  } catch (error) {
    if (!handleFailure) {
      return await reportUnreportedUpdateAdmissionOutcome(error);
    }
    // The admitted run's prepared handler outlives both staged cleanup and the
    // executor, so no failure is reported while either mutation owner remains live.
    await handleFailure(error);
  }
}
