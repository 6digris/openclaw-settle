import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withSettledLocalWorkspace } from "../../gateway/worker-environments/local-workspace-projection.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { resolveRequiredHomeDir } from "../../infra/home-dir.js";
import { isPathInside } from "../../infra/path-guards.js";
import { runExclusiveSessionLifecycleMutation } from "../../sessions/session-lifecycle-admission.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import { withWorktreeAllocationLease } from "./allocation.js";
import { admitWorktreeDirectoryPath } from "./directory-admission.js";
import { lockState } from "./git-lock.js";
import { requireGit, requireGitBuffer, runGit } from "./git.js";
import { readRegistryWorktrees } from "./registry-read.js";
import { relocateWorktreeSessionReferences } from "./relocation-references.js";
import {
  assertWorktreeMoveAvailable,
  readManagedWorktreeInventory,
  readWorktreeMoveReceipts,
} from "./relocation-store.js";
import type {
  WorktreeMoveParams,
  WorktreeMovePlan,
  WorktreeMovePreview,
  WorktreeMoveReceipt,
  WorktreePathIdentity,
} from "./relocation.types.js";

const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function directoryIdentity(value: string): Promise<WorktreePathIdentity> {
  const stat = await fs.lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(value)) !== value) {
    throw new Error("Relocation requires canonical directories without symlink aliases");
  }
  return { path: value, dev: stat.dev, ino: stat.ino };
}

async function assertIdentity(identity: WorktreePathIdentity, value = identity.path) {
  const current = await directoryIdentity(value);
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error("Relocation directory identity changed; preserve both paths for recovery");
  }
}

async function absent(value: string) {
  try {
    await fs.lstat(value);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  throw new Error(`Relocation destination already exists: ${value}`);
}

async function assertPrivateDestination(value: string) {
  if (process.platform === "win32") {
    throw new Error("Windows directory ACL admission is a subsequent phase; checkout retained");
  }
  const stat = await fs.lstat(value);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      "Relocation destination must be owned by the service account and not writable by other users",
    );
  }
  if (process.platform === "darwin") {
    const { apfsFilesystem } = await import("./filesystem-apfs.native.js");
    if (apfsFilesystem.readDirectoryAcl(value) !== "none") {
      throw new Error("Relocation requires a destination without extended ACLs; checkout retained");
    }
  }
}

async function admitDestinationNamespace(root: string, parent: string, create = false) {
  await admitWorktreeDirectoryPath({
    root,
    parent,
    create,
    assertDirectory: async (directory) => {
      await directoryIdentity(directory);
      await assertPrivateDestination(directory);
    },
  });
}

/** Relative links leaving the checkout change meaning after a rename. Never repair dependencies implicitly. */
async function assertRelocatableLinks(source: string, destination: string) {
  const pending = [source];
  let visited = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++visited > 250_000) {
        throw new Error(
          "Dependency link inventory exceeded the relocation limit; retain this checkout for separate maintenance",
        );
      }
      const pathname = path.join(directory, entry.name);
      if (entry.name === ".git" && directory !== source) {
        throw new Error("Nested repositories require whole-graph relocation; checkout retained");
      }
      if (entry.isSymbolicLink()) {
        const link = await fs.readlink(pathname);
        const target = path.resolve(directory, link);
        if (path.isAbsolute(link) && isPathInside(source, target)) {
          throw new Error(
            "An absolute link points inside the old checkout; preserve its dependency layout before moving",
          );
        }
        if (
          !path.isAbsolute(link) &&
          !isPathInside(source, target) &&
          path.resolve(destination, path.relative(source, directory), link) !== target
        ) {
          throw new Error(
            "A relative link outside the checkout would change its target; preserve the dependency layout before moving",
          );
        }
      } else if (entry.isDirectory()) {
        pending.push(pathname);
      }
    }
  }
}

async function inspectMove(
  env: NodeJS.ProcessEnv,
  config: OpenClawConfig,
  id: string,
  destinationRoot: string,
): Promise<WorktreeMovePlan> {
  const records = await readRegistryWorktrees(env);
  const record = records.find((value) => value.id === id && value.removedAt === undefined);
  if (!record) {
    throw new Error("Live managed worktree not found");
  }
  if (
    !/^[a-f0-9]{16}$/u.test(record.repoFingerprint) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(record.name)
  ) {
    throw new Error("Managed workspace namespace is invalid");
  }
  await assertWorktreeMoveAvailable(env, id);
  if (!path.isAbsolute(destinationRoot)) {
    throw new Error("Destination root must be absolute");
  }
  const root = await directoryIdentity(path.normalize(destinationRoot));
  await assertPrivateDestination(root.path);
  const source = await directoryIdentity(record.path);
  if (root.dev !== source.dev) {
    throw new Error("Cross-filesystem relocation is a subsequent phase; checkout retained");
  }
  if (isPathInside(source.path, root.path)) {
    throw new Error("Destination root cannot be inside the source checkout");
  }
  const destination = path.join(root.path, record.repoFingerprint, record.name);
  await admitDestinationNamespace(root.path, path.dirname(destination));
  await absent(destination);
  if ((await lockState(record)).kind !== "none") {
    throw new Error("Git worktree is locked; finish its owning lifecycle before relocation");
  }
  const gitDirectory = await directoryIdentity(
    (await requireGit(record.path, ["rev-parse", "--absolute-git-dir"])).trim(),
  );
  const common = (await requireGit(record.path, ["rev-parse", "--git-common-dir"])).trim();
  const commonDirectory = await directoryIdentity(path.resolve(record.path, common));
  if (gitDirectory.path === commonDirectory.path) {
    throw new Error(
      "Canonical repository owners require whole-graph relocation in a subsequent phase",
    );
  }
  if (
    records.some(
      (candidate) => candidate.id !== id && isPathInside(record.path, candidate.repoRoot),
    )
  ) {
    throw new Error(
      "Checkout owns another repository registration; whole-graph relocation is required",
    );
  }
  const submodules = await requireGit(record.path, ["ls-files", "--stage"]);
  if (/^160000 /mu.test(submodules)) {
    throw new Error("Submodule relocation is a subsequent phase; checkout retained");
  }
  if (
    (await fs.readFile(path.join(gitDirectory.path, "gitdir"), "utf8")).trim() !==
    path.join(record.path, ".git")
  ) {
    throw new Error("Git administrative backlink does not match this checkout");
  }
  await assertRelocatableLinks(source.path, destination);
  const context = captureOpenClawStateWorkerContext({ env });
  const projection = await executeOpenClawStateWorker(context, {
    type: "worktrees.projection",
    input: { id },
  });
  if (projection?.unsettled) {
    throw new Error(
      "Projection has unresolved reconciliation; settle its current operation before moving",
    );
  }
  const projectionSource = projection && (await directoryIdentity(projection.path));
  const projectionDestination = path.join(root.path, ".projections", id, "workspace");
  if (projectionSource) {
    if (isPathInside(projectionSource.path, root.path)) {
      throw new Error("Destination root cannot be inside the source projection");
    }
    if (projectionSource.dev !== root.dev) {
      throw new Error("Projection relocation crosses filesystems; checkout retained");
    }
    await admitDestinationNamespace(root.path, path.dirname(projectionDestination));
    await absent(projectionDestination);
    await assertRelocatableLinks(projectionSource.path, projectionDestination);
  }
  const sessions = await executeOpenClawStateWorker(context, {
    type: "worktrees.references",
    input: {
      config,
      record,
      projectionPath: projectionSource?.path,
      homeDir: resolveRequiredHomeDir(env),
    },
  });
  const plan = {
    record,
    destination,
    destinationRoot: root,
    source,
    gitDirectory,
    commonDirectory,
    sessions,
    head: (await requireGit(record.path, ["rev-parse", "HEAD"])).trim(),
    statusDigest: digest(
      await requireGitBuffer(
        record.path,
        ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        { env: { ...env, GIT_OPTIONAL_LOCKS: "0" } },
      ),
    ),
    ...(projectionSource && projection
      ? {
          projection: {
            source: projectionSource,
            destination: projectionDestination,
            sessionId: projection.sessionId,
          },
        }
      : {}),
  };
  return { ...plan, observation: digest(JSON.stringify(plan)) };
}

export async function previewWorktreeMove(
  env: NodeJS.ProcessEnv,
  config: OpenClawConfig,
  id: string,
  destinationRoot: string,
): Promise<WorktreeMovePreview> {
  try {
    const plan = await inspectMove(env, config, id, destinationRoot);
    return {
      worktreeId: id,
      destination: plan.destination,
      observation: plan.observation,
      blockers: [],
      maintenanceRequired: true,
    };
  } catch (error) {
    return {
      worktreeId: id,
      blockers: [error instanceof Error ? error.message : "Workspace inspection failed"],
      maintenanceRequired: true,
    };
  }
}

/** Verification never repairs Git links or replays an interrupted filesystem effect. */
export async function verifyWorktreeMove(env: NodeJS.ProcessEnv, operationId: string) {
  const receipt = (await readWorktreeMoveReceipts(env)).find(
    (row) => row.operationId === operationId,
  );
  if (!receipt) {
    throw new Error(
      "Relocation operation not found; do not mint a replacement for an unknown outcome",
    );
  }
  const problems: string[] = [];
  try {
    await assertIdentity(receipt.plan.source, receipt.plan.destination);
    await absent(receipt.plan.source.path);
    await assertIdentity(receipt.plan.gitDirectory);
    await assertIdentity(receipt.plan.commonDirectory);
    if (
      (await requireGit(receipt.plan.destination, ["rev-parse", "--absolute-git-dir"])).trim() !==
        receipt.plan.gitDirectory.path ||
      (await fs.readFile(path.join(receipt.plan.gitDirectory.path, "gitdir"), "utf8")).trim() !==
        path.join(receipt.plan.destination, ".git")
    ) {
      throw new Error("Git registration is not bound to the moved checkout");
    }
    if (receipt.plan.projection) {
      await assertIdentity(receipt.plan.projection.source, receipt.plan.projection.destination);
      await absent(receipt.plan.projection.source.path);
    }
    const inventory = await readManagedWorktreeInventory(env);
    const expectedPath =
      receipt.phase === "verified" ? receipt.plan.destination : receipt.plan.source.path;
    const registered = inventory.worktrees.find((row) => row.id === receipt.worktreeId);
    if (
      !registered ||
      registered.path !== expectedPath ||
      registered.repoRoot !== receipt.plan.record.repoRoot ||
      registered.removedAt !== undefined
    ) {
      throw new Error("Worktree registry no longer matches the relocation receipt");
    }
    const projection = inventory.projections.find((row) => row.worktreeId === receipt.worktreeId);
    if (receipt.plan.projection) {
      const expectedProjection =
        receipt.phase === "verified"
          ? receipt.plan.projection.destination
          : receipt.plan.projection.source.path;
      if (
        !projection ||
        projection.path !== expectedProjection ||
        projection.sessionId !== receipt.plan.projection.sessionId ||
        projection.unsettled
      ) {
        throw new Error(
          "Projection custody is unsettled or no longer matches the relocation receipt",
        );
      }
    } else if (projection) {
      throw new Error("Projection appeared during relocation");
    }
    if (receipt.phase === "verified") {
      problems.push(
        ...(await executeOpenClawStateWorker(captureOpenClawStateWorkerContext({ env }), {
          type: "worktrees.verifyReferences",
          input: receipt.plan,
        })),
      );
    }
  } catch (error) {
    problems.push(error instanceof Error ? error.message : "Relocation verification failed");
  }
  return { receipt, verified: receipt.phase === "verified" && problems.length === 0, problems };
}

export async function moveWorktree(
  env: NodeJS.ProcessEnv,
  config: OpenClawConfig,
  params: WorktreeMoveParams,
  caller: { signal?: AbortSignal; commitGuard?: () => void } = {},
): Promise<WorktreeMoveReceipt> {
  caller.signal?.throwIfAborted();
  caller.commitGuard?.();
  // SDK/JavaScript callers must provide literal consent, not a truthy value.
  const controlledMaintenance: unknown = params.controlledMaintenance;
  if (controlledMaintenance !== true) {
    throw new Error(
      "Stop outside writers and explicitly admit controlled maintenance before moving",
    );
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(params.operationId)) {
    throw new Error("Relocation requires a stable UUID operation ID");
  }
  const prior = (await readWorktreeMoveReceipts(env)).find(
    (row) => row.operationId === params.operationId,
  );
  if (prior) {
    if (
      prior.worktreeId !== params.id ||
      prior.plan.observation !== params.expectedObservation ||
      prior.plan.destinationRoot.path !== path.normalize(params.destinationRoot)
    ) {
      throw new Error("Operation ID belongs to different relocation intent");
    }
    if (prior.phase === "verified") {
      return prior;
    }
    return await withWorktreeAllocationLease({ env, ...caller }, async (guard) => {
      guard.commitGuard?.();
      const context = captureOpenClawStateWorkerContext({ env });
      const executor = randomUUID();
      let receipt = await executeOpenClawStateWorker(context, {
        type: "worktrees.relocation.recover",
        input: { operationId: params.operationId, executor, now: Date.now() },
      });
      if (receipt.phase === "verified") {
        return receipt;
      }
      const advance = async (
        phase: WorktreeMoveReceipt["phase"],
        reason?: string,
        projectionRevision?: number,
      ) => {
        receipt = await executeOpenClawStateWorker(context, {
          type: "worktrees.relocation.advance",
          input: {
            operationId: params.operationId,
            executor,
            revision: receipt.revision,
            phase,
            now: Date.now(),
            reason,
            projectionRevision,
          },
        });
      };
      try {
        // Complete metadata only after Git itself already left both links correct.
        // A rename/link-update crash cannot be repaired under single-tree custody.
        const proof = await verifyWorktreeMove(env, params.operationId);
        if (proof.problems.length) {
          throw new Error(proof.problems.join("; "));
        }
        await runExclusiveSessionLifecycleMutation({
          targets: prior.plan.sessions.map((reference) => ({
            scope: reference.storePath,
            identities: [reference.sessionKey, reference.sessionId],
          })),
          run: async () => {
            guard.rollbackGuard();
            await relocateWorktreeSessionReferences(prior.plan, env, guard.rollbackGuard);
            const projection = await executeOpenClawStateWorker(context, {
              type: "worktrees.projection",
              input: { id: params.id },
            });
            await advance("moved");
            await advance("verified", undefined, projection?.revision);
          },
        });
      } catch (error) {
        await advance(
          "recovery_required",
          (error instanceof Error ? error.message : "Relocation recovery failed").slice(0, 500),
        );
      }
      return receipt;
    });
  }
  return await withWorktreeAllocationLease({ env, ...caller }, async (guard) => {
    const plan = await inspectMove(env, config, params.id, params.destinationRoot);
    if (plan.observation !== params.expectedObservation) {
      throw new Error("Workspace changed since preview; inspect a fresh preview");
    }
    const context = captureOpenClawStateWorkerContext({ env });
    const executor = randomUUID();
    guard.commitGuard?.();
    const admission = await executeOpenClawStateWorker(context, {
      type: "worktrees.relocation.admit",
      input: { operationId: params.operationId, executor, plan, now: Date.now() },
    });
    if (!admission.admitted) {
      return admission.receipt;
    }
    let receipt = admission.receipt;
    const advance = async (
      phase: WorktreeMoveReceipt["phase"],
      reason?: string,
      projectionRevision?: number,
    ) => {
      receipt = await executeOpenClawStateWorker(context, {
        type: "worktrees.relocation.advance",
        input: {
          operationId: params.operationId,
          executor,
          revision: receipt.revision,
          phase,
          now: Date.now(),
          reason,
          projectionRevision,
        },
      });
    };
    try {
      await runExclusiveSessionLifecycleMutation({
        targets: plan.sessions.map((reference) => ({
          scope: reference.storePath,
          identities: [reference.sessionKey, reference.sessionId],
        })),
        run: async () => {
          await withSettledLocalWorkspace(
            {
              worktree: plan.record,
              env,
              retireRuntime: true,
              relocationOperationId: params.operationId,
              assertCurrent: guard.rollbackGuard,
            },
            async () => {
              guard.rollbackGuard();
              const references = await executeOpenClawStateWorker(context, {
                type: "worktrees.references",
                input: {
                  config,
                  record: plan.record,
                  projectionPath: plan.projection?.source.path,
                  homeDir: resolveRequiredHomeDir(env),
                },
              });
              if (!isDeepStrictEqual(references, plan.sessions)) {
                throw new Error(
                  "Session references changed after preview; retain the operation for recovery",
                );
              }
              await assertIdentity(plan.source);
              await assertIdentity(plan.destinationRoot);
              await assertIdentity(plan.gitDirectory);
              await assertIdentity(plan.commonDirectory);
              if (
                (await requireGit(plan.source.path, ["rev-parse", "HEAD"])).trim() !== plan.head
              ) {
                throw new Error("Worktree HEAD changed since preview");
              }
              await admitDestinationNamespace(
                plan.destinationRoot.path,
                path.dirname(plan.destination),
                true,
              );
              await absent(plan.destination);
              if (plan.projection) {
                await assertIdentity(plan.projection.source);
                await admitDestinationNamespace(
                  plan.destinationRoot.path,
                  path.dirname(plan.projection.destination),
                  true,
                );
                await absent(plan.projection.destination);
              }
              guard.commitGuard?.();
              await advance("moving");
              // Once admitted, settle the exact Git child even if caller cancellation arrives.
              const moved = await runGit(plan.record.repoRoot, [
                "worktree",
                "move",
                "--",
                plan.source.path,
                plan.destination,
              ]);
              if (moved.code !== 0) {
                throw new Error(
                  "Git worktree move failed; inspect the retained operation before recovery",
                );
              }
              if (plan.projection) {
                await assertIdentity(plan.projection.source);
                await absent(plan.projection.destination);
                await fs.rename(plan.projection.source.path, plan.projection.destination);
              }
              await advance("moved");
            },
          );
          const proof = await verifyWorktreeMove(env, params.operationId);
          if (proof.problems.length) {
            throw new Error(proof.problems.join("; "));
          }
          await relocateWorktreeSessionReferences(plan, env, guard.rollbackGuard);
          const projection = await executeOpenClawStateWorker(context, {
            type: "worktrees.projection",
            input: { id: params.id },
          });
          guard.rollbackGuard();
          await advance("verified", undefined, projection?.revision);
        },
      });
      return receipt;
    } catch (error) {
      await advance(
        "recovery_required",
        (error instanceof Error ? error.message : "Relocation failed").slice(0, 500),
      );
      return receipt;
    }
  });
}
