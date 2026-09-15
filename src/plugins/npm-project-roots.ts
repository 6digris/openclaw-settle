// Resolves npm project roots for plugin package inspection.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tryReadJsonSync } from "../infra/json-files.js";
import { isNotFoundPathError } from "../infra/path-guards.js";
import {
  isPluginNpmProjectDir,
  resolvePluginNpmProjectsDir,
  validatePluginId,
} from "./install-paths.js";

function isMissing(error: unknown): boolean {
  return isNotFoundPathError(error);
}

function sortPaths(paths: string[]): string[] {
  return paths.toSorted((left, right) => left.localeCompare(right));
}

function isManagedProjectRoot(projectDir: string, npmDir: string): boolean {
  const manifest = tryReadJsonSync(path.join(projectDir, "package.json"));
  if (!isRecord(manifest) || !isRecord(manifest.dependencies)) {
    return false;
  }
  // Staging, backup, and quarantine directories are not published projects.
  // Reuse package-owned path authority before recovery or host-link repair sees them.
  return Object.keys(manifest.dependencies).some(
    (packageName) =>
      validatePluginId(packageName) === null &&
      isPluginNpmProjectDir({ packageName, projectDir, npmDir }),
  );
}

/** Lists project-level npm roots managed below the plugin npm root. */
export function listManagedPluginNpmProjectRootsSync(npmRoot: string): string[] {
  const projectsDir = resolvePluginNpmProjectsDir(npmRoot);
  try {
    return sortPaths(
      fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectsDir, entry.name))
        .filter((projectDir) => isManagedProjectRoot(projectDir, npmRoot)),
    );
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

/** Async variant of project-level managed npm root discovery. */
async function listManagedPluginNpmProjectRoots(npmRoot: string): Promise<string[]> {
  const projectsDir = resolvePluginNpmProjectsDir(npmRoot);
  try {
    return sortPaths(
      (await fsp.readdir(projectsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(projectsDir, entry.name))
        .filter((projectDir) => isManagedProjectRoot(projectDir, npmRoot)),
    );
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

/** Returns the root npm install plus all managed project npm roots. */
export function listManagedPluginNpmRootsSync(npmRoot: string): string[] {
  return [npmRoot, ...listManagedPluginNpmProjectRootsSync(npmRoot)];
}

/** Async variant of managed npm root discovery. */
export async function listManagedPluginNpmRoots(npmRoot: string): Promise<string[]> {
  return [npmRoot, ...(await listManagedPluginNpmProjectRoots(npmRoot))];
}
