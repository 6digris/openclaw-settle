import fs from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleResolve } from "import-meta-resolve";
import { walkDirectorySync } from "../infra/fs-safe.js";
import { hasNodeErrorCode, isPathInside } from "../infra/path-guards.js";
import { createJiti } from "./jiti-factory.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import {
  readPluginGenerationInspection,
  retainPluginGenerationInspection,
  type PluginGenerationInspection,
} from "./plugin-generation-rehearsal.js";
import { visitPluginSourceReferences } from "./plugin-source-references.js";

/** Acquire the same literal module inputs as execution, without evaluating plugin code. */
export function inspectPluginSourceDependencies(
  entries: readonly { rootDir: string; entryFile: string }[],
) {
  const files = new Set<string>();
  const packageRoots = new Set<string>();
  const unresolved: Array<{ source: string; specifier: string }> = [];
  const references: Array<{ source: string; specifier: string; target: string }> = [];
  const checks = new Map<string, () => void>();
  const byEntry = new Map<string, PluginGenerationInspection>();
  const bySource = new Map<string, PluginGenerationInspection>();
  const reusedSources: Array<{ entryFile: string; reason: string }> = [];
  for (const entry of entries) {
    const source = fs.realpathSync(entry.entryFile);
    const prior = bySource.get(source);
    if (prior) {
      byEntry.set(entry.entryFile, prior);
      retainPluginGenerationInspection(entry, prior);
      continue;
    }
    const prepared = readPluginGenerationInspection(entry);
    if (prepared) {
      prepared.files.forEach((file) => files.add(file));
      prepared.packageRoots.forEach((root) => packageRoots.add(root));
      unresolved.push(...prepared.unresolved);
      references.push(...prepared.references);
      checks.set(prepared.generation, prepared.assertSourceCurrent);
      byEntry.set(entry.entryFile, prepared);
      bySource.set(source, prepared);
      reusedSources.push({ entryFile: entry.entryFile, reason: prepared.reuseReason });
      continue;
    }
    const root = fs.realpathSync(entry.rootDir);
    const referenceStart = references.length;
    const unresolvedStart = unresolved.length;
    const entryFiles: string[] = [];
    const entryRoots: string[] = [];
    // This scope grants source acquisition only. No module evaluation or registration runs here.
    const artifact = capturePluginGenerationArtifact(root, source, (run) => run());
    try {
      const pending = [artifact.resolve(source)];
      const visited = new Set<string>();
      for (const captured of pending) {
        if (visited.has(captured)) {
          continue;
        }
        visited.add(captured);
        const original = artifact.sourceForCaptured(captured);
        if (!original || !/\.[cm]?[jt]sx?$/.test(original)) {
          continue;
        }
        artifact.prepareModule(captured);
        const resolver = createJiti(original, {
          fsCache: false,
          moduleCache: false,
          tryNative: false,
        });
        visitPluginSourceReferences(
          original,
          fs.readFileSync(captured, "utf8"),
          resolver,
          (specifier, kind) => {
            if (kind === "asset" || isBuiltin(specifier)) {
              return;
            }
            const local =
              specifier.startsWith(".") ||
              path.isAbsolute(specifier) ||
              specifier.startsWith("file:");
            try {
              const conditions = ["node", kind];
              const result = artifact.captureModule(captured, specifier, conditions);
              const target =
                result && "target" in result
                  ? result.target
                  : result && "retryNative" in result
                    ? kind === "require"
                      ? pathToFileURL(createRequire(captured).resolve(specifier))
                      : moduleResolve(specifier, pathToFileURL(captured), new Set(conditions))
                    : undefined;
              if (target?.protocol === "file:") {
                const selected = artifact.captureResolvedModule(fileURLToPath(target));
                const originalTarget = selected && artifact.sourceForCaptured(selected);
                if (selected && originalTarget) {
                  references.push({ source: original, specifier, target: originalTarget });
                  pending.push(selected);
                }
              } else if (local && !result) {
                unresolved.push({ source: original, specifier });
              }
            } catch (error) {
              if (
                [
                  "ENOENT",
                  "MODULE_NOT_FOUND",
                  "ERR_MODULE_NOT_FOUND",
                  "ERR_PACKAGE_PATH_NOT_EXPORTED",
                  "ERR_PACKAGE_IMPORT_NOT_DEFINED",
                  "ERR_UNSUPPORTED_DIR_IMPORT",
                ].some((code) => hasNodeErrorCode(error, code))
              ) {
                // Optional imports can deliberately fall back; execution owns their outcome.
                unresolved.push({ source: original, specifier });
                return;
              }
              throw error;
            }
          },
        );
      }
      const scan = walkDirectorySync(artifact.boundaryRoot, { symlinks: "skip" });
      const [failure] = scan.failedDirs;
      if (failure) {
        throw failure.error;
      }
      for (const captured of scan.entries) {
        const original = artifact.sourceForCaptured(captured.path);
        if (!original) {
          continue;
        }
        if (captured.kind === "file") {
          files.add(original);
          entryFiles.push(original);
        } else if (captured.kind === "directory") {
          packageRoots.add(original);
          entryRoots.push(original);
        }
      }
      checks.set(artifact.boundaryRoot, artifact.assertSourceCurrent);
      const graph: PluginGenerationInspection = {
        files: entryFiles,
        packageRoots: entryRoots.filter(
          (packageRoot) =>
            !entryRoots.some((other) => other !== packageRoot && isPathInside(other, packageRoot)),
        ),
        unresolved: unresolved.slice(unresolvedStart),
        references: references.slice(referenceStart),
      };
      retainPluginGenerationInspection(entry, graph);
      byEntry.set(entry.entryFile, graph);
      bySource.set(source, graph);
    } finally {
      artifact.dispose();
    }
  }
  // Selected surfaces of one immutable acquisition share one final verification, without yielding.
  for (const check of checks.values()) {
    check();
  }
  return {
    byEntry,
    reusedSources,
    files: [...files],
    packageRoots: [...packageRoots].filter(
      (root) => ![...packageRoots].some((other) => other !== root && isPathInside(other, root)),
    ),
    unresolved,
    references,
    assertSourceCurrent: () => {
      for (const check of checks.values()) {
        check();
      }
    },
  };
}

/** Inspect the same source graph the module owner will capture, without evaluating it. */
export function inspectPluginGenerationSources(
  entries: readonly { pluginId: string; rootDir: string; entryFile?: string }[],
) {
  const bySource = new Map<string, string>();
  const digests = new Map<string, string>();
  const checks: Array<() => void> = [];
  for (const entry of entries) {
    if (digests.has(entry.pluginId)) {
      continue;
    }
    const key = `${entry.rootDir}\0${entry.entryFile ?? ""}`;
    let digest = bySource.get(key);
    if (digest === undefined) {
      const artifact = capturePluginGenerationArtifact(entry.rootDir, entry.entryFile);
      try {
        digest = artifact.sourceDigest;
        bySource.set(key, digest);
        checks.push(artifact.assertSourceCurrent);
      } finally {
        artifact.dispose();
      }
    }
    digests.set(entry.pluginId, digest);
  }
  return {
    sourceDigests: Object.fromEntries(digests),
    assertSourceCurrent: () => {
      for (const check of checks) {
        check();
      }
    },
  };
}
