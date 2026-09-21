import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleResolve } from "import-meta-resolve";
import { isPathInside } from "../infra/path-guards.js";
import {
  findPluginCapturedPackage,
  isPluginPackageFile,
  packageName,
  type createPluginPackageMetadataCapture,
  type createPluginSourceCapture,
  type PluginModuleCapture,
  type PluginPackageCapture,
} from "./plugin-package-metadata-capture.js";
import { capturedPluginModuleUrl } from "./plugin-source-references.js";

export function createPluginSourceLinkCapture(initial: readonly string[] = []) {
  const links = new Set<string>(initial);
  return {
    defer(filename: string, root: string): boolean {
      if (
        !fs.lstatSync(filename).isSymbolicLink() ||
        isPathInside(root, fs.realpathSync(filename))
      ) {
        return false;
      }
      links.add(filename);
      return true;
    },
    contains: (filename: string) => [...links].some((link) => isPathInside(link, filename)),
    snapshot: () => [...links],
  };
}

export function createPluginModuleSpecifierCapture(params: {
  sourceRoot: string;
  capturedRoot: string;
  target: string;
  executable: boolean;
  tsconfigPaths?: boolean | string;
  manifest?: Record<string, unknown>;
  capturedPaths: ReadonlyMap<string, string>;
  captureReference: (
    reference: string,
    kind: "import" | "require",
    conditions: readonly string[],
  ) => string | undefined;
  captureFile: (filename: string) => void;
  captureDependencies: () => void;
  prepareDependency: PluginModuleCapture["prepareDependency"];
  packageForFile: (filename: string) => Pick<PluginPackageCapture, "materialize"> | undefined;
}): PluginModuleCapture["capture"] {
  return (specifier, conditions) => {
    const inputFilename = specifier.startsWith("file:")
      ? fileURLToPath(specifier)
      : path.isAbsolute(specifier)
        ? specifier
        : undefined;
    const known = inputFilename && params.capturedPaths.get(path.resolve(inputFilename));
    if (params.executable && known) {
      return { target: capturedPluginModuleUrl(known, specifier, conditions) };
    }
    const name = packageName(specifier);
    const self = params.manifest?.exports != null && params.manifest.name === name;
    const bare =
      !specifier.startsWith(".") && !path.isAbsolute(specifier) && !specifier.startsWith("file:");
    if (params.tsconfigPaths && bare && !self && !specifier.startsWith("#")) {
      // Jiti selects configured source paths; package maps below use captured metadata.
      const mapped = params.captureReference(
        specifier,
        conditions.includes("require") ? "require" : "import",
        conditions,
      );
      if (mapped && params.capturedPaths.has(path.resolve(mapped))) {
        params.captureDependencies();
        return { target: pathToFileURL(params.capturedPaths.get(path.resolve(mapped))!) };
      }
    }
    const dependencyPrepared = params.prepareDependency(specifier);
    if (typeof dependencyPrepared === "boolean") {
      return dependencyPrepared ? { retryNative: true } : undefined;
    }
    if (dependencyPrepared === "package-map") {
      let selected: URL;
      try {
        selected = moduleResolve(specifier, pathToFileURL(params.target), new Set(conditions));
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          error.code !== "ERR_MODULE_NOT_FOUND"
        ) {
          throw error;
        }
        if (!("url" in error) || typeof error.url !== "string") {
          return undefined;
        }
        // Native selection used immutable metadata; its body can still be uncaptured.
        selected = new URL(error.url);
      }
      if (selected.protocol !== "file:") {
        return undefined;
      }
      const filename = fileURLToPath(selected);
      if (isPluginPackageFile(params.capturedRoot, filename)) {
        const original = path.join(params.sourceRoot, path.relative(params.capturedRoot, filename));
        if (!params.capturedPaths.has(original) && !fs.existsSync(original)) {
          return undefined;
        }
        params.captureFile(original);
      } else {
        params.packageForFile(filename)?.materialize();
      }
      params.captureDependencies();
      return { retryNative: true };
    }
    const source = params.captureReference(
      specifier,
      conditions.includes("require") ? "require" : "import",
      conditions,
    );
    params.captureDependencies();
    const captured = source ? params.capturedPaths.get(path.resolve(source)) : undefined;
    return captured
      ? { target: capturedPluginModuleUrl(captured, specifier, conditions) }
      : undefined;
  };
}

/** Every borrower reconstructs these admission closures around its own captured filesystem view. */
export function createPluginGenerationModuleCapture(params: {
  directory: string;
  packages: ReadonlyMap<string, PluginPackageCapture>;
  capturedPaths: Map<string, string>;
  originalSources: ReadonlyMap<string, string>;
  moduleCaptures: ReadonlyMap<string, PluginModuleCapture>;
  metadataCapture: ReturnType<typeof createPluginPackageMetadataCapture>;
  assertModuleAvailable: (filename: string) => void;
  captureAdmitted: ReturnType<typeof createPluginSourceCapture>["capture"];
  captureExecutableFile: (filename: string) => string | undefined;
  executable: boolean;
}) {
  const {
    directory,
    packages,
    capturedPaths,
    originalSources,
    moduleCaptures,
    metadataCapture,
    assertModuleAvailable,
    captureAdmitted,
    captureExecutableFile,
  } = params;
  const packageForFile = (filename: string) =>
    findPluginCapturedPackage(packages, filename, directory)?.owner;
  return {
    moduleRoot: (filename: string) =>
      originalSources.has(filename) ? packageForFile(filename)?.capturedRoot : undefined,
    assertModuleAvailable,
    prepareModule: (filename: string) => {
      const owner = packageForFile(filename);
      const source = originalSources.get(filename);
      const needsEntry =
        params.executable &&
        source &&
        /\.[cm]?[jt]sx?$/.test(source) &&
        !moduleCaptures.has(filename);
      if (!owner || ((owner.state === "entry" || owner.state === "body") && !needsEntry)) {
        return [];
      }
      return captureAdmitted(() => {
        // Loading another selected module must not capture a standalone workspace.
        owner.materialize(owner.state === "entry" ? source : undefined);
        if (needsEntry && owner.state !== "entry") {
          owner.materialize(source);
        }
      }).additions;
    },
    prepareDependency: (importer: string, specifier: string) =>
      captureAdmitted(() => moduleCaptures.get(importer)?.prepareDependency(specifier)).additions,
    prepareNativeScopes: (importer?: string) => {
      const scope = importer ? moduleCaptures.get(importer)?.nativeScope : undefined;
      return scope?.prepareDependencies || metadataCapture.pending
        ? captureAdmitted(() => metadataCapture.prepare(scope))
        : undefined;
    },
    prepareNativeModule: (importer: string, specifier: string) =>
      captureAdmitted(() => {
        const packageMap =
          moduleCaptures.get(importer)?.prepareDependency(specifier) === "package-map";
        metadataCapture.prepare();
        return packageMap;
      }).value,
    captureModule: (importer: string, specifier: string, conditions: readonly string[]) => {
      const result = captureAdmitted(() =>
        moduleCaptures.get(importer)?.capture(specifier, conditions),
      );
      return result.value ? { ...result.value, additions: result.additions } : undefined;
    },
    captureResolvedModule: (filename: string) => {
      const known = capturedPaths.get(path.resolve(filename));
      if (known) {
        assertModuleAvailable(known);
        return known;
      }
      return captureAdmitted(() => {
        const captured = findPluginCapturedPackage(packages, filename, directory);
        // import.meta.url can name a deferred peer through a private dependency link.
        const original = captured
          ? path.join(captured.owner.sourceRoot, path.relative(captured.root, filename))
          : filename;
        const source = captureExecutableFile(original);
        const target = source ? capturedPaths.get(source) : undefined;
        if (target) {
          capturedPaths.set(path.resolve(filename), target);
        }
        return target;
      }).value;
    },
  };
}
