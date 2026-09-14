import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { splitShellArgs } from "../utils/shell-argv.js";
import { formatErrorMessage, hasErrnoCode } from "./errors.js";
import { resolveExecutablePath } from "./executable-path.js";
import { resolveRequiredOsHomeDir } from "./home-dir.js";
import {
  createPackageIntegrityReader,
  type PackageDirectoryIdentity,
  type PackageRootIntegrityFingerprint,
} from "./package-update-integrity.js";
import { readCurrentGitUpdateRecovery } from "./update-runner-git-recovery.js";

/** The retained installation owner supplies this operator-owned checkout. */
async function captureGitRecovery(
  target: string,
  timeoutMs?: number,
): Promise<(() => Promise<void>) | undefined> {
  const recovery = await readCurrentGitUpdateRecovery(target, timeoutMs);
  if (!recovery.serviceRestartSafe || !recovery.buildId) {
    return undefined;
  }
  const root = await fs.realpath(target);
  const identity = await fs.stat(root, { bigint: true });
  if (identity.ino === 0n || (process.platform === "win32" && identity.dev === 0n)) {
    return undefined;
  }
  return async () => {
    const currentIdentity = await fs.stat(root, { bigint: true });
    const current = await readCurrentGitUpdateRecovery(root, timeoutMs);
    if (
      (await fs.realpath(target)) !== root ||
      currentIdentity.dev !== identity.dev ||
      currentIdentity.ino !== identity.ino ||
      !current.serviceRestartSafe ||
      current.buildId !== recovery.buildId ||
      current.version !== recovery.version
    ) {
      throw new Error("Previous Git runtime changed; automatic rollback was refused.");
    }
  };
}

export type InstallerGitRecovery = {
  root: string;
  launcher: string;
  verifyRuntime: () => Promise<void>;
  assertCurrent: () => Promise<void>;
};

async function isInstallerGitWrapper(launcher: string, root: string): Promise<boolean> {
  const stat = await fs.lstat(launcher).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
      return undefined;
    }
    throw error;
  });
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 4096 || !(stat.mode & 0o111)) {
    return false;
  }
  const lines = (await fs.readFile(launcher, "utf8")).trimEnd().split(/\r?\n/u);
  // install.sh emits literal printf %q paths and exactly "$@" argument forwarding.
  const word = String.raw`(?:[^\x00-\x20\x7f\\'"\x60$;&|<>(){}\[\]*?!]|\\[^\r\n]|'[^'\r\n]*')+`;
  const execLine = lines[2] ?? "";
  const args = lines.length === 3 ? splitShellArgs(execLine) : null;
  if (
    lines[0] !== "#!/usr/bin/env bash" ||
    lines[1] !== "set -euo pipefail" ||
    !new RegExp(`^exec ${word} ${word} "\\$@"$`, "u").test(execLine) ||
    args?.length !== 4 ||
    args[0] !== "exec" ||
    !args[1] ||
    !path.isAbsolute(args[1]) ||
    args[2] !== path.join(root, "dist", "entry.js") ||
    args[3] !== "$@"
  ) {
    return false;
  }
  const node = resolveExecutablePath(args[1], { useCache: false });
  return Boolean(node && (await fs.realpath(node)) === (await fs.realpath(process.execPath)));
}

/** install.sh publishes this canonical exposure; copied/custom wrappers are not its owner. */
export async function captureInstallerGitRecovery(
  root: string,
  timeoutMs: number,
): Promise<InstallerGitRecovery | undefined> {
  const launcher = path.join(resolveRequiredOsHomeDir(), ".local", "bin", "openclaw");
  if (process.platform === "win32" || !(await isInstallerGitWrapper(launcher, root))) {
    return undefined;
  }
  const fingerprint = await createPackageIntegrityReader(timeoutMs).launcher(launcher);
  const launcherReal = await fs.realpath(launcher);
  const verifyRuntime = await captureGitRecovery(root, timeoutMs);
  if (!verifyRuntime) {
    throw new Error("The installer's previous Git runtime could not be verified.");
  }
  const assertCurrent = async () => {
    const reader = createPackageIntegrityReader(timeoutMs);
    if (await reader.exists(path.resolve(path.dirname(launcher), "../lib/node_modules/openclaw"))) {
      throw new Error("The installer destination already contains another npm installation.");
    }
    if (
      (await reader.launcher(launcher)) !== fingerprint ||
      !(await isInstallerGitWrapper(launcher, root))
    ) {
      throw new Error("The installer launcher changed while preparing the update.");
    }
    for (const directory of new Set(
      (process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    )) {
      const other = path.resolve(directory, "openclaw");
      if (other === launcher) {
        continue;
      }
      const entry = await fs.realpath(other).catch(() => undefined);
      if (entry === launcherReal) {
        continue;
      }
      if (
        entry === path.join(root, "openclaw.mjs") ||
        entry === path.join(root, "dist", "entry.js") ||
        (await isInstallerGitWrapper(other, root))
      ) {
        throw new Error(
          "Multiple launchers expose this Git checkout; keep one installer exposure before updating.",
        );
      }
    }
    await verifyRuntime();
  };
  await assertCurrent();
  return { root, launcher, verifyRuntime, assertCurrent };
}

export async function createNpmPackageRootLinkLifecycle(params: {
  liveRoot: string;
  backupRoot: string;
  fingerprint: Extract<PackageRootIntegrityFingerprint, { kind: "link" }>;
  timeoutMs?: number;
}) {
  const verifyRuntime = await captureGitRecovery(
    path.resolve(path.dirname(params.liveRoot), params.fingerprint.target),
    params.timeoutMs,
  );
  const assertUnchanged = async (root: string) => {
    const actual = await createPackageIntegrityReader(params.timeoutMs).rootEntry(
      root,
      params.liveRoot,
      "link",
    );
    if (!isDeepStrictEqual(actual, params.fingerprint)) {
      throw new Error("Npm package link changed before activation or retirement");
    }
  };
  return {
    verifyRuntime,
    async assertLiveUnchanged() {
      await assertUnchanged(params.liveRoot);
      await verifyRuntime?.();
    },
    async acquire(): Promise<{ acquired: true } | { acquired: false; error: string }> {
      await fs.rename(params.liveRoot, params.backupRoot);
      try {
        // Only the moved entry can establish ownership of the retained link.
        await assertUnchanged(params.backupRoot);
        return { acquired: true };
      } catch (error) {
        // A mismatch already disproves ownership. Do not compensate into a
        // live path where another package publisher may now be writing.
        return {
          acquired: false,
          error: `Npm package link backup refused: ${formatErrorMessage(error)}; moved entry retained at ${params.backupRoot}; inspect it before manual recovery`,
        };
      }
    },
    async retire(assertCurrent = () => {}): Promise<string | null> {
      try {
        assertCurrent();
        await assertUnchanged(params.backupRoot);
        // This observation does not exclude concurrent writers. Non-recursive
        // removal protects a substituted directory and the external checkout.
        assertCurrent();
        await fs.unlink(params.backupRoot);
        return null;
      } catch (error) {
        assertCurrent();
        return `Could not retire retained npm package link at ${params.backupRoot}: ${formatErrorMessage(error)}`;
      }
    },
  };
}

/** Verify the same retained/restored npm root and launcher baseline without inference. */
export async function verifyNpmRootRecovery(
  params: {
    root: string;
    fromBackup: boolean;
    hadPackage: boolean;
    previousRoot: PackageRootIntegrityFingerprint | undefined;
    previousIdentity?: PackageDirectoryIdentity;
    targetSwapRoot: string;
    shims: readonly { destination: string; backup: string | null; fingerprint?: string }[];
  },
  timeoutMs?: number,
  verifyGitRuntime?: () => Promise<void>,
): Promise<boolean> {
  const { root, fromBackup, hadPackage, previousRoot, targetSwapRoot, shims } = params;
  const reader = createPackageIntegrityReader(timeoutMs);
  return await reader.observe(fromBackup ? "retained" : "restored", async () => {
    if (
      hadPackage
        ? previousRoot
          ? !isDeepStrictEqual(
              await reader.rootEntry(root, targetSwapRoot, previousRoot.kind),
              previousRoot,
            )
          : !params.previousIdentity ||
            !isDeepStrictEqual(await reader.directoryIdentity(root), params.previousIdentity)
        : !fromBackup && (await reader.exists(root))
    ) {
      throw new Error(
        `Package rollback verification failed: retained package ${previousRoot?.kind === "link" ? "link" : "tree"} changed`,
      );
    }
    for (const shim of shims) {
      const target = fromBackup ? shim.backup : shim.destination;
      if (
        shim.backup
          ? !target || (await reader.launcher(target)) !== shim.fingerprint
          : !fromBackup && (await reader.exists(shim.destination))
      ) {
        throw new Error(
          `Package rollback verification failed: launcher ${shim.destination} changed`,
        );
      }
    }
    await verifyGitRuntime?.();
    // Package absence alone is not recovery; an installer launcher can own the verified Git runtime.
    return (
      verifyGitRuntime !== undefined ||
      (hadPackage &&
        (previousRoot?.kind === "directory" ||
          (!previousRoot && params.previousIdentity !== undefined)))
    );
  });
}
