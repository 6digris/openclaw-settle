import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "../infra/file-lock.js";
import { canonicalPathFromExistingAncestor, isPathInside } from "../infra/fs-safe.js";
import {
  GIT_TIMEOUT_MS,
  enqueueGitRefMutation,
  executeGitCommand as runGit,
  normalizeGitPathForFilesystem,
  requireGitCommand as requireGit,
  requireGitCommandOutput,
} from "../infra/git-exec.js";
import { assertNotUpdateCapturePath } from "../infra/update-capture-paths.js";
import { spawnCommand } from "../process/exec-spawn.js";
import {
  GIT_BACKUP_MANIFEST,
  GIT_BACKUP_SCHEMA,
  GIT_BACKUP_TABLES,
  gitBackupScopePath,
  restoreGitBackupDirectory,
  type GitBackupIdentity,
  type GitBackupRestoreResult,
} from "./git-backup-codec.js";
import {
  formatGitBackupCommandResult,
  sanitizeGitBackupDiagnostic,
} from "./git-backup-diagnostics.js";
import {
  createGitBackupGeneration,
  type GitBackupCreateParams,
  type GitBackupCreateResult,
} from "./git-backup-generation.js";
import { ensurePrivateSnapshotRepositoryRoot } from "./local-repository.js";

function gitBackupRepositoryPrivacyRemediation(repositoryPath: string, cause: unknown): string {
  if (process.platform === "win32") {
    const detail =
      cause instanceof Error && cause.message
        ? ` ${sanitizeGitBackupDiagnostic(cause.message)}`
        : "";
    return (
      `${detail} Remove non-user ACL grants from ${repositoryPath} or choose a private local directory. ` +
      "Do not use a shared or synced folder for SQLite backups."
    );
  }
  return `Fix its ownership and run chmod 700 ${repositoryPath}.`;
}

async function assertGitRepository(repositoryPath: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const topLevel = await requireGit(repositoryPath, ["rev-parse", "--show-toplevel"], { env });
  const [canonicalTopLevel, canonicalRepository] = await Promise.all([
    fs.realpath(normalizeGitPathForFilesystem(topLevel)),
    fs.realpath(repositoryPath),
  ]);
  if (canonicalTopLevel !== canonicalRepository) {
    throw new Error(`Backup repository must be the Git worktree root: ${repositoryPath}`);
  }
}

/** Initialize or adopt an operator-owned Git backup repository. */
export async function initializeGitBackupRepository(params: {
  repositoryPath: string;
  stateDir: string;
  remote?: string;
  gitEnv?: NodeJS.ProcessEnv;
}): Promise<{ repositoryPath: string }> {
  const repositoryPath = path.resolve(params.repositoryPath);
  const stateDir = path.resolve(params.stateDir);
  const [canonicalRepositoryPath, canonicalStateDir] = await Promise.all([
    canonicalPathFromExistingAncestor(repositoryPath),
    canonicalPathFromExistingAncestor(stateDir),
  ]);
  if (
    isPathInside(canonicalStateDir, canonicalRepositoryPath) ||
    isPathInside(canonicalRepositoryPath, canonicalStateDir)
  ) {
    throw new Error(
      `Git backup repository must be outside the OpenClaw state directory: ${stateDir}`,
    );
  }
  try {
    await ensurePrivateSnapshotRepositoryRoot(repositoryPath);
  } catch (error) {
    throw new Error(
      `Git backup repository must be owned by the current user and not writable by other users: ${repositoryPath}. ${gitBackupRepositoryPrivacyRemediation(repositoryPath, error)}`,
      { cause: error },
    );
  }
  const probe = await runGit(repositoryPath, ["rev-parse", "--show-toplevel"], {
    env: params.gitEnv,
  });
  if (probe.code !== 0) {
    await requireGit(repositoryPath, ["init"], { env: params.gitEnv });
  }
  await assertGitRepository(repositoryPath, params.gitEnv);
  const remote = params.remote?.trim();
  if (remote) {
    const existing = await runGit(repositoryPath, ["remote", "get-url", "origin"], {
      env: params.gitEnv,
    });
    if (existing.code === 0 && existing.stdout.trim() !== remote) {
      throw new Error(
        `Git backup repository already has a different origin: ${sanitizeGitBackupDiagnostic(existing.stdout.trim())}`,
      );
    }
    if (existing.code !== 0) {
      await requireGit(repositoryPath, ["remote", "add", "origin", remote], {
        env: params.gitEnv,
      });
    }
  }
  return { repositoryPath };
}

/** Snapshot selected databases, update the deterministic tree, and commit one Git revision. */
export async function createGitBackup(
  params: GitBackupCreateParams,
): Promise<GitBackupCreateResult> {
  for (const database of params.databases) {
    assertNotUpdateCapturePath(database.path, params.stateDir);
  }
  const repositoryPath = path.resolve(params.repositoryPath);
  await initializeGitBackupRepository({
    repositoryPath,
    stateDir: params.stateDir,
    gitEnv: params.gitEnv,
  });
  const commonDirectory = await fs.realpath(
    path.resolve(
      repositoryPath,
      normalizeGitPathForFilesystem(
        await requireGit(repositoryPath, ["rev-parse", "--git-common-dir"], { env: params.gitEnv }),
      ),
    ),
  );
  return await enqueueGitRefMutation(repositoryPath, commonDirectory, async () =>
    withFileLock(
      path.join(commonDirectory, "openclaw-backup-create"),
      {
        retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
        stale: GIT_TIMEOUT_MS,
        staleRecovery: "fail-closed",
      },
      async () => await createGitBackupGeneration(params, repositoryPath, commonDirectory),
    ),
  );
}

async function resolveGitCommit(repositoryPath: string, ref?: string): Promise<string> {
  return await requireGit(repositoryPath, [
    "rev-parse",
    "--verify",
    `${ref?.trim() || "HEAD"}^{commit}`,
  ]);
}

/** Materialize one database scope from a Git ref into a private temporary directory. */
async function materializeGitBackupRef(params: {
  repositoryPath: string;
  identity: GitBackupIdentity;
  ref?: string;
}): Promise<{ commit: string; path: string; cleanup: () => Promise<void> }> {
  const repositoryPath = path.resolve(params.repositoryPath);
  await assertGitRepository(repositoryPath);
  const commit = await resolveGitCommit(repositoryPath, params.ref);
  const scope = gitBackupScopePath(params.identity).split(path.sep).join("/");
  const files = (
    await requireGit(repositoryPath, ["ls-tree", "-r", "--name-only", commit, "--", scope])
  )
    .split("\n")
    .filter(Boolean);
  const required = new Set([`${scope}/${GIT_BACKUP_MANIFEST}`, `${scope}/${GIT_BACKUP_SCHEMA}`]);
  if ([...required].some((entry) => !files.includes(entry))) {
    throw new Error(`Git backup ref ${commit} does not contain ${scope}.`);
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-restore-"));
  await fs.chmod(root, 0o700);
  const outputPath = path.join(root, scope);
  try {
    for (const file of files) {
      if (
        file !== `${scope}/${GIT_BACKUP_MANIFEST}` &&
        file !== `${scope}/${GIT_BACKUP_SCHEMA}` &&
        !file.startsWith(`${scope}/${GIT_BACKUP_TABLES}/`)
      ) {
        throw new Error(`Git backup ref contains an unexpected file: ${file}`);
      }
      const relative = file.slice(scope.length + 1);
      const destination = path.join(outputPath, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, "", { flag: "wx", mode: 0o600 });
      // Git owns decoding the blob; pipe its bytes into private staging rather
      // than collecting another complete table in the parent process.
      await spawnCommand(["git", "-C", repositoryPath, "show", `${commit}:${file}`], {
        stdin: "ignore",
        stdout: { file: destination },
        buffer: { stdout: false },
        maxBuffer: { stderr: 1024 * 1024 },
        timeout: GIT_TIMEOUT_MS,
      });
    }
    return {
      commit,
      path: outputPath,
      cleanup: async () => await fs.rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Restore one database from a Git ref to a caller-selected fresh path. */
export async function restoreGitBackupRef(params: {
  repositoryPath: string;
  identity: GitBackupIdentity;
  ref?: string;
  targetPath: string;
}): Promise<GitBackupRestoreResult & { commit: string }> {
  const materialized = await materializeGitBackupRef(params);
  try {
    return {
      ...(await restoreGitBackupDirectory({
        sourcePath: materialized.path,
        targetPath: params.targetPath,
        expectedIdentity: params.identity,
      })),
      commit: materialized.commit,
    };
  } finally {
    await materialized.cleanup();
  }
}

/** Verify a Git snapshot by restoring it privately and comparing every table digest. */
export async function verifyGitBackupRef(params: {
  repositoryPath: string;
  identity: GitBackupIdentity;
  ref?: string;
}): Promise<GitBackupRestoreResult & { commit: string }> {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-verify-"));
  await fs.chmod(scratch, 0o700);
  try {
    return await restoreGitBackupRef({
      ...params,
      targetPath: path.join(scratch, "database.sqlite"),
    });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Return bounded Git backup log entries for CLI rendering. */
export async function readGitBackupLog(params: {
  repositoryPath: string;
  limit: number;
}): Promise<Array<{ commit: string; date: string; message: string }>> {
  await assertGitRepository(params.repositoryPath);
  const symbolicHead = await runGit(params.repositoryPath, ["symbolic-ref", "--quiet", "HEAD"]);
  if (symbolicHead.code === 0) {
    const headRef = symbolicHead.stdout.trim();
    const headExists = await runGit(params.repositoryPath, [
      "show-ref",
      "--verify",
      "--quiet",
      headRef,
    ]);
    if (headExists.code === 1 && headRef.startsWith("refs/heads/")) {
      return [];
    }
    if (headExists.code !== 0) {
      throw new Error(formatGitBackupCommandResult("git show-ref HEAD", headExists));
    }
  } else if (symbolicHead.code !== 1) {
    throw new Error(formatGitBackupCommandResult("git symbolic-ref HEAD", symbolicHead));
  }
  const result = await runGit(params.repositoryPath, [
    "log",
    `--max-count=${params.limit}`,
    "--pretty=format:%H%x09%cI%x09%s",
  ]);
  return requireGitCommandOutput(
    "git log",
    result,
    (command, failure) => new Error(formatGitBackupCommandResult(command, failure)),
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit = "", date = "", ...message] = line.split("\t");
      return { commit, date, message: message.join("\t") };
    });
}
