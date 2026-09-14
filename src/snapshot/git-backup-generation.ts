import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import {
  gitNullConfigPath,
  executeGitCommand as runGit,
  normalizeGitPathForFilesystem,
  requireGitCommand as requireGit,
  requireGitCommandOutput,
} from "../infra/git-exec.js";
import {
  GIT_BACKUP_MANIFEST,
  dumpGitBackupDatabase,
  gitBackupScopePath,
  parseGitBackupManifest,
  type GitBackupIdentity,
  type GitBackupManifest,
} from "./git-backup-codec.js";
import { formatGitBackupCommandResult } from "./git-backup-diagnostics.js";
import { createOpenClawSnapshotCopy } from "./openclaw-snapshot-copy.js";
import type { SnapshotDatabaseRef } from "./snapshot-provider.js";

const GIT_BACKUP_NON_BACKUP_HISTORY_WARNING =
  "repository history contains non-backup commits; use a dedicated backup repository";

export type GitBackupCreateParams = {
  repositoryPath: string;
  stateDir: string;
  databases: Array<SnapshotDatabaseRef & { identity: GitBackupIdentity }>;
  all?: boolean;
  excludeSecrets?: boolean;
  push?: boolean;
  now?: Date;
  gitEnv?: NodeJS.ProcessEnv;
};

export type GitBackupCreateResult = {
  repositoryPath: string;
  commit?: string;
  noChanges: boolean;
  /** Ref publication never refreshes or resets the operator worktree/index. */
  worktreeUpdated: false;
  pushed: boolean;
  pushWarning?: string;
  manifests: GitBackupManifest[];
};

async function isBackupOwnedScope(scopePath: string): Promise<boolean> {
  const identity = await fs
    .lstat(scopePath)
    .catch((error: unknown) => (hasErrnoCode(error, "ENOENT") ? undefined : null));
  if (identity === undefined) {
    return true;
  }
  if (!identity?.isDirectory()) {
    return false;
  }
  try {
    const entries = await fs.readdir(scopePath);
    if (entries.length === 0) {
      return true;
    }
    parseGitBackupManifest(
      await fs.readFile(path.join(scopePath, GIT_BACKUP_MANIFEST), "utf8"),
      scopePath,
    );
    return true;
  } catch {
    return false;
  }
}

async function assertBackupOwnedScope(scopePath: string): Promise<void> {
  if (!(await isBackupOwnedScope(scopePath))) {
    throw new Error(
      `Refusing to replace non-backup-owned path ${scopePath}; the repository must be dedicated to OpenClaw backups.`,
    );
  }
}

async function removeStaleAgentScopes(repositoryPath: string): Promise<void> {
  const agentsPath = path.join(repositoryPath, "agents");
  let entries: string[];
  try {
    entries = await fs.readdir(agentsPath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  const scopes = entries.map((entry) => path.join(agentsPath, entry));
  await Promise.all(scopes.map(async (scope) => await assertBackupOwnedScope(scope)));
  await Promise.all(scopes.map(async (scope) => await fs.rm(scope, { recursive: true })));
}

async function copyStagedScope(
  stagingRoot: string,
  repositoryPath: string,
  identity: GitBackupIdentity,
): Promise<void> {
  const relative = gitBackupScopePath(identity);
  const source = path.join(stagingRoot, relative);
  const target = path.join(repositoryPath, relative);
  await assertBackupOwnedScope(target);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.cp(source, target, { recursive: true, force: false });
}

async function commitGitBackup(params: {
  repositoryPath: string;
  message: string;
  env?: NodeJS.ProcessEnv;
  configArgs: string[];
}): Promise<string> {
  const email = await runGit(
    params.repositoryPath,
    [...params.configArgs, "config", "--get", "user.email"],
    {
      env: params.env,
    },
  );
  if (email.termination !== "exit" || (email.code !== 0 && email.code !== 1)) {
    throw new Error(formatGitBackupCommandResult("git config user.email", email));
  }
  const identityArgs =
    email.code === 0 && email.stdout.trim()
      ? []
      : ["-c", "user.name=OpenClaw", "-c", "user.email=backup@openclaw.local"];
  await requireGit(
    params.repositoryPath,
    [...params.configArgs, ...identityArgs, "commit", "-m", params.message],
    {
      env: params.env,
    },
  );
  return await requireGit(params.repositoryPath, [...params.configArgs, "rev-parse", "HEAD"], {
    env: params.env,
  });
}

class GitBackupPublicationError extends Error {
  constructor(
    readonly preparedCommit: string,
    readonly ref: string,
    readonly previousCommit: string | undefined,
    readonly publication: "committed" | "not-observed" | "unknown",
    cause: unknown,
    readonly observedCommit?: string,
    readonly reconciliationError?: unknown,
  ) {
    super(
      "Git backup publication " +
        publication +
        " at " +
        ref +
        "; prepared commit " +
        preparedCommit +
        ", previous commit " +
        (previousCommit ?? "unborn") +
        ". Live worktree/index were not refreshed. " +
        "Inspect this ref and recovery commit before retrying; no automatic retry was attempted.",
      { cause },
    );
  }
}

/** Include untracked files and symlinks: Git status alone misses same-status external edits. */
async function fingerprintGitBackupScopes(repositoryPath: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(relative: string): Promise<void> {
    const filename = path.join(repositoryPath, relative);
    const stat = await fs.lstat(filename).catch((error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    });
    hash.update(JSON.stringify([relative, stat?.mode ?? null, stat?.size ?? null]));
    if (!stat) {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(filename)).toSorted()) {
        await visit(path.join(relative, entry));
      }
    } else if (stat.isSymbolicLink()) {
      hash.update(JSON.stringify(await fs.readlink(filename)));
    } else if (stat.isFile()) {
      for await (const chunk of createReadStream(filename)) {
        hash.update(chunk);
      }
    } else {
      throw new Error(`Unsupported entry in Git backup scope: ${filename}`);
    }
  }
  await visit("global");
  await visit("agents");
  return hash.digest("hex");
}

export async function createGitBackupGeneration(
  params: GitBackupCreateParams,
  repositoryPath: string,
  commonDirectory: string,
): Promise<GitBackupCreateResult> {
  const now = params.now ?? new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error("Git backup timestamp is invalid.");
  }
  const git = async (args: string[]) =>
    await requireGit(repositoryPath, args, { env: params.gitEnv });
  const inheritedEnv = { ...process.env, ...params.gitEnv };
  if (
    inheritedEnv.GIT_CONFIG ||
    inheritedEnv.GIT_ALTERNATE_OBJECT_DIRECTORIES ||
    inheritedEnv.GIT_NAMESPACE ||
    inheritedEnv.GIT_SHALLOW_FILE ||
    inheritedEnv.GIT_REPLACE_REF_BASE
  ) {
    throw new Error(
      "Git backup refuses redirected config, alternate, namespace, shallow, or replacement environments.",
    );
  }
  const gitDirectory = await fs.realpath(
    path.resolve(
      repositoryPath,
      normalizeGitPathForFilesystem(await git(["rev-parse", "--git-dir"])),
    ),
  );
  if (
    gitDirectory !== commonDirectory ||
    (await git(["rev-parse", "--is-shallow-repository"])) !== "false"
  ) {
    throw new Error("Git backup private preparation requires a non-shallow standalone worktree.");
  }
  if (await git(["for-each-ref", "--format=%(refname)", "refs/replace/"])) {
    throw new Error("Git backup refuses replacement refs when verifying prepared ancestry.");
  }
  const config = requireGitCommandOutput(
    "git config --list",
    await runGit(repositoryPath, ["config", "--null", "--list", "--includes"], {
      env: params.gitEnv,
    }),
  );
  const entries = config
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf("\n");
      if (separator < 0) {
        throw new Error("Git backup cannot preserve valueless Git config in private preparation.");
      }
      return { key: entry.slice(0, separator), value: entry.slice(separator + 1) };
    });
  if (
    entries.some(
      ({ key }) =>
        key.toLowerCase().startsWith("includeif.") ||
        key.toLowerCase().startsWith("filter.") ||
        (key.toLowerCase().startsWith("extensions.") &&
          key.toLowerCase() !== "extensions.objectformat"),
    )
  ) {
    throw new Error(
      "Git backup cannot preserve conditional includes, filters, or this repository extension in private preparation; no backup published.",
    );
  }
  const pathKeys = new Set([
    "core.attributesfile",
    "core.excludesfile",
    "gpg.ssh.allowedsignersfile",
    "gpg.ssh.revocationfile",
  ]);
  const sshSigning =
    entries.findLast(({ key }) => key.toLowerCase() === "gpg.format")?.value === "ssh";
  if (
    entries.some(({ key, value }) => {
      const normalized = key.toLowerCase();
      return (
        (pathKeys.has(normalized) && !path.isAbsolute(value)) ||
        (sshSigning &&
          normalized === "user.signingkey" &&
          !value.startsWith("key::") &&
          !path.isAbsolute(value)) ||
        (normalized === "core.fsmonitor" && value !== "false") ||
        normalized === "gpg.ssh.defaultkeycommand" ||
        ((normalized === "gpg.program" || /^gpg\.[^.]+\.program$/u.test(normalized)) &&
          (value.includes("/") || value.includes("\\")) &&
          !path.isAbsolute(value))
      );
    })
  ) {
    throw new Error(
      "Git backup cannot preserve relative config paths or working-directory-dependent helpers in private preparation.",
    );
  }
  const symbolicHead = await runGit(repositoryPath, ["symbolic-ref", "--quiet", "HEAD"], {
    env: params.gitEnv,
  });
  if (symbolicHead.termination !== "exit" || (symbolicHead.code !== 0 && symbolicHead.code !== 1)) {
    throw new Error(formatGitBackupCommandResult("git symbolic-ref HEAD", symbolicHead));
  }
  const headRef = symbolicHead.code === 0 ? symbolicHead.stdout.trim() : undefined;
  if (!headRef?.startsWith("refs/heads/")) {
    throw new Error("Git backup private publication requires a named branch, not detached HEAD.");
  }
  const headExists = headRef
    ? await runGit(repositoryPath, ["show-ref", "--verify", "--quiet", headRef], {
        env: params.gitEnv,
      })
    : undefined;
  if (
    headExists &&
    (headExists.termination !== "exit" || (headExists.code !== 0 && headExists.code !== 1))
  ) {
    throw new Error(formatGitBackupCommandResult("git show-ref HEAD", headExists));
  }
  const previousCommit =
    headExists?.code === 1
      ? undefined
      : await git(["rev-parse", "--verify", headRef + "^{commit}"]);
  const beforeTree = await fingerprintGitBackupScopes(repositoryPath);
  const beforeIndex = await git(["ls-files", "--stage", "-z", "--", "global", "agents"]);
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-backup-"));
  await fs.chmod(stagingRoot, 0o700);
  const generationPath = path.join(stagingRoot, "generation");
  const dumpPath = path.join(stagingRoot, "dump");
  const manifests: GitBackupManifest[] = [];
  let commit: string | undefined;
  let changed = false;
  try {
    await fs.mkdir(generationPath, { mode: 0o700 });
    // Auto maintenance must never prune the shared objects from this private ref namespace.
    const env: NodeJS.ProcessEnv = {
      ...inheritedEnv,
      GIT_DIR: path.join(generationPath, ".git"),
      GIT_COMMON_DIR: path.join(generationPath, ".git"),
      GIT_WORK_TREE: generationPath,
      GIT_INDEX_FILE: path.join(generationPath, ".git", "index"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_COUNT: undefined,
      GIT_CONFIG_PARAMETERS: undefined,
      GIT_OBJECT_DIRECTORY: path.resolve(
        repositoryPath,
        normalizeGitPathForFilesystem(await git(["rev-parse", "--git-path", "objects"])),
      ),
    };
    const configuredHooks = await runGit(
      repositoryPath,
      ["config", "--path", "--get", "core.hooksPath"],
      { env: params.gitEnv },
    );
    if (
      configuredHooks.termination !== "exit" ||
      (configuredHooks.code !== 0 && configuredHooks.code !== 1)
    ) {
      throw new Error(formatGitBackupCommandResult("git config core.hooksPath", configuredHooks));
    }
    const hooksPath = path.resolve(
      repositoryPath,
      normalizeGitPathForFilesystem(
        configuredHooks.code === 0
          ? configuredHooks.stdout.trim()
          : await git(["rev-parse", "--git-path", "hooks"]),
      ),
    );
    // Last command-line values override even caller-supplied command-scope configuration.
    const configArgs = [
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "-c",
      "gc.autoPackLimit=0",
      "-c",
      "maintenance.autoDetach=false",
      "-c",
      "gc.autoDetach=false",
      "-c",
      "core.bare=false",
      "-c",
      "core.worktree=" + generationPath,
      "-c",
      "core.hooksPath=" + hooksPath,
    ];
    const privateGit = async (args: string[]) =>
      await requireGit(generationPath, [...configArgs, ...args], { env });
    await privateGit([
      "init",
      "--template=",
      "--object-format=" + (await git(["rev-parse", "--show-object-format"])),
    ]);
    const privateConfig = path.join(generationPath, ".git", "config");
    // Freeze effective values in original order. Includes are resolved in the admitted context.
    for (const { key, value } of entries) {
      if (
        key.toLowerCase() === "include.path" ||
        ["core.bare", "core.worktree", "core.hookspath"].includes(key.toLowerCase())
      ) {
        continue;
      }
      await privateGit(["config", "--file", privateConfig, "--add", key, value]);
    }
    const sign = await runGit(
      generationPath,
      [...configArgs, "config", "--bool", "--get", "commit.gpgsign"],
      { env },
    );
    if (sign.termination !== "exit" || (sign.code !== 0 && sign.code !== 1)) {
      throw new Error(formatGitBackupCommandResult("git config commit.gpgSign", sign));
    }
    const signingRequired = sign.code === 0 && sign.stdout.trim() === "true";
    if (previousCommit) {
      await fs.writeFile(
        path.join(generationPath, ".git", "HEAD"),
        `${previousCommit}
`,
      );
      await privateGit(["read-tree", previousCommit]);
      await privateGit(["checkout-index", "-a"]);
    } else {
      await privateGit(["read-tree", "--empty"]);
    }
    const previousTree = await privateGit(["write-tree"]);
    // The previous commit, not the intentionally unrefreshed live checkout, is authoritative.
    // Validate live scopes without importing, deleting, or replacing their bytes.
    for (const scope of ["global", "agents"]) {
      const source = path.join(repositoryPath, scope);
      const stat = await fs.lstat(source).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (stat) {
        if (!stat.isDirectory()) {
          throw new Error("Backup scope must be a directory: " + source);
        }
        if (scope === "global") {
          await assertBackupOwnedScope(source);
        } else {
          for (const entry of await fs.readdir(source)) {
            await assertBackupOwnedScope(path.join(source, entry));
          }
        }
      }
      await fs.mkdir(path.join(generationPath, scope), { recursive: true, mode: 0o700 });
    }
    for (const database of params.databases) {
      const outputPath = path.join(dumpPath, gitBackupScopePath(database.identity));
      await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      const copyPath = path.join(
        stagingRoot,
        `${database.identity.role}-${manifests.length}.sqlite`,
      );
      await createOpenClawSnapshotCopy({ database, targetPath: copyPath });
      manifests.push(
        await dumpGitBackupDatabase({
          snapshotPath: copyPath,
          outputPath,
          identity: database.identity,
          excludeSecrets: params.excludeSecrets,
        }),
      );
      await fs.rm(copyPath, { force: true });
    }
    if (params.all) {
      await removeStaleAgentScopes(generationPath);
    }
    for (const database of params.databases) {
      await copyStagedScope(dumpPath, generationPath, database.identity);
    }
    await privateGit(["add", "-A", "--", "global", "agents"]);
    const preparedTree = await privateGit(["write-tree"]);
    changed = preparedTree !== previousTree;
    if (changed) {
      const preparedFiles = await fingerprintGitBackupScopes(generationPath);
      const preparedCommit = await commitGitBackup({
        repositoryPath: generationPath,
        message: `openclaw backup ${now.toISOString()}`,
        configArgs,
        env,
      });
      const headers =
        (await privateGit(["cat-file", "commit", preparedCommit])).split("\n\n", 1)[0] ?? "";
      const parents = headers.split("\n").filter((line) => line.startsWith("parent "));
      if (parents.join("\n") !== (previousCommit ? "parent " + previousCommit : "")) {
        throw new Error("Git backup prepared ancestry changed during hooks; no backup published.");
      }
      if (signingRequired) {
        if (!/^gpgsig(?:-sha256)? /mu.test(headers)) {
          throw new Error("Git backup requires a signed prepared commit; no backup published.");
        }
        await privateGit(["verify-commit", preparedCommit]);
      }
      if (
        (await privateGit(["rev-parse", `${preparedCommit}^{tree}`])) !== preparedTree ||
        (await fingerprintGitBackupScopes(generationPath)) !== preparedFiles
      ) {
        throw new Error("Git backup generation changed during commit hooks; no backup published.");
      }
      if (
        (await fingerprintGitBackupScopes(repositoryPath)) !== beforeTree ||
        (await git(["ls-files", "--stage", "-z", "--", "global", "agents"])) !== beforeIndex
      ) {
        throw new Error(
          "Git backup worktree or index changed during preparation; no backup published.",
        );
      }
      const currentHead = await runGit(repositoryPath, ["symbolic-ref", "--quiet", "HEAD"], {
        env: params.gitEnv,
      });
      if (
        currentHead.termination !== "exit" ||
        currentHead.code !== symbolicHead.code ||
        currentHead.stdout !== symbolicHead.stdout
      ) {
        throw new Error("Git backup checkout changed during preparation; no backup published.");
      }
      // Publish only the admitted named ref. Keep recovery identity across command failure.
      try {
        await git([
          "update-ref",
          "--no-deref",
          headRef,
          preparedCommit,
          previousCommit ?? "0".repeat(preparedCommit.length),
        ]);
      } catch (cause) {
        let observedCommit: string | undefined;
        let reconciliationError: unknown;
        let publication: "committed" | "not-observed" | "unknown" = "unknown";
        try {
          const observed = await runGit(
            repositoryPath,
            ["show-ref", "--verify", "--hash", headRef],
            { env: params.gitEnv },
          );
          if (observed.termination === "exit" && observed.code === 0) {
            observedCommit = requireGitCommandOutput("git show-ref", observed).trim();
            publication =
              observedCommit === preparedCommit
                ? "committed"
                : observedCommit === previousCommit
                  ? "not-observed"
                  : "unknown";
          } else {
            // A failed read (including a missing unborn ref) is not proof that no write occurred.
            requireGitCommandOutput("git show-ref", observed);
          }
        } catch (error) {
          reconciliationError = error;
        }
        throw new GitBackupPublicationError(
          preparedCommit,
          headRef,
          previousCommit,
          publication,
          cause,
          observedCommit,
          reconciliationError,
        );
      }
      commit = preparedCommit;
      // This lease excludes backup creators, not editors/git add. No destructive live refresh:
      // even an immediately preceding fingerprint does not establish exclusive writer ownership.
    }
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  let pushed = false;
  let pushWarning: string | undefined;
  if (params.push) {
    // Staging is path-scoped, but push ships HEAD's full ancestry. A dedicated
    // repository is the supported remote shape.
    const nonBackupCommitCount = await requireGit(
      repositoryPath,
      ["rev-list", "HEAD", "--invert-grep", "--grep=^openclaw backup ", "--count"],
      { env: params.gitEnv },
    );
    if (nonBackupCommitCount !== "0") {
      pushWarning = GIT_BACKUP_NON_BACKUP_HISTORY_WARNING;
    } else {
      const pushedResult = await runGit(repositoryPath, ["push", "-u", "origin", "HEAD"], {
        env: params.gitEnv,
      });
      if (pushedResult.code === 0) {
        pushed = true;
      } else {
        pushWarning = formatGitBackupCommandResult("git push", pushedResult);
      }
    }
  }
  return {
    repositoryPath,
    ...(commit ? { commit } : {}),
    noChanges: !changed,
    worktreeUpdated: false,
    pushed,
    ...(pushWarning ? { pushWarning } : {}),
    manifests,
  };
}
