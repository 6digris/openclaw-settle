import { createHash } from "node:crypto";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { JitiOptions } from "jiti";
import { isPathInside } from "../infra/path-guards.js";
import { createJiti } from "./jiti-factory.js";
import {
  createPluginGenerationArtifactFacts,
  restorePluginGenerationObservations,
  snapshotPluginGenerationModule,
  pluginSourceStatIdentity,
  pluginSourceContentHash,
  type PluginGenerationArtifactState,
} from "./plugin-generation-artifact-state.js";
import {
  createPluginGenerationModuleCapture,
  createPluginModuleSpecifierCapture,
  createPluginSourceLinkCapture,
} from "./plugin-generation-module-capture.js";
import {
  borrowPreparingPluginGenerationArtifact,
  readPluginGenerationRehearsalArtifact,
} from "./plugin-generation-rehearsal.js";
import { createPluginGenerationSourceLookup } from "./plugin-generation-source-lookup.js";
import {
  capturePluginPackageMetadata,
  capturePluginDependencies,
  capturePluginModuleSource,
  createPluginDependencyLookup,
  createPluginDependencyResolver,
  createPluginNativeDependencyScopes,
  packageName,
  importTargetNames,
  verifyPluginSourceInputs,
  readPluginSourceBytes,
  createPluginPackageMetadataCapture,
  createPluginSourceCapture,
  type PluginDependencyResolution,
  type PluginPackageCapture,
  type PluginModuleCapture,
  isPluginPackageFile as inPackage,
  findPluginCapturedPackage,
} from "./plugin-package-metadata-capture.js";
import { visitPluginSourceReferences } from "./plugin-source-references.js";

/** Capture selective entries and whole dependencies without replacing earlier file bytes. */
export function capturePluginGenerationArtifact(
  rootDir: string,
  entryFile?: string,
  execute?: <T>(run: () => T) => T,
  moduleSource?: (filename: string) => string,
): PluginGenerationArtifact {
  const preparing = borrowPreparingPluginGenerationArtifact(rootDir, entryFile, (selectedEntry) =>
    createPluginGenerationArtifact(rootDir, selectedEntry, execute, moduleSource),
  );
  if (preparing) {
    return preparing;
  }
  const prepared = readPluginGenerationRehearsalArtifact(rootDir, entryFile);
  if (prepared) {
    try {
      return createPluginGenerationArtifact(rootDir, entryFile, execute, moduleSource, prepared);
    } catch (error) {
      process.emitWarning(
        `Prepared plugin view unavailable; using an isolated acquisition: ${String(error)}`,
      );
    }
  }
  return createPluginGenerationArtifact(rootDir, entryFile, execute, moduleSource);
}

export type PluginGenerationArtifact = ReturnType<typeof createPluginGenerationArtifact>;

function createPluginGenerationArtifact(
  rootDir: string,
  entryFile?: string,
  execute?: <T>(run: () => T) => T,
  moduleSource?: (filename: string) => string,
  prepared?: ReturnType<typeof readPluginGenerationRehearsalArtifact>,
) {
  const sourceCapture = createPluginSourceCapture(execute);
  const directory = sourceCapture.directory;
  const state = prepared?.state;
  const packages = new Map<string, PluginPackageCapture>();
  const facts = createPluginGenerationArtifactFacts(sourceCapture, prepared);
  const {
    captured: capturedPath,
    relative,
    capturedPaths,
    originalSources,
    restoredMetadata,
    hardlinkedSources,
    sourceAliases,
    packageSnapshots,
    moduleSnapshots,
  } = facts;
  const metadataCapture = createPluginPackageMetadataCapture({
    sourceForCaptured: (filename) => originalSources.get(filename),
    packageForFile: (filename) => packageForFile(filename),
  });
  const digest = createHash("sha256");
  const {
    inputs,
    pendingInputs,
    additions,
    capture: captureAdmitted,
    assertModuleAvailable,
  } = sourceCapture;
  const moduleCaptures = new Map<string, PluginModuleCapture>();
  const resolveDependency = createPluginDependencyResolver(state?.dependencies);
  const restoredPackages = new Map(state?.packages.map((entry) => [entry.sourceRoot, entry]));
  const restoredModules = new Map(state?.modules);
  // Callers canonicalize roots; already-captured packages survive removal of their original files.
  const copyPackage = (
    root: string,
    entry?: string,
    metadataOnly = false,
    executableEntry = false,
  ): string => {
    const boundary = root;
    const restored = restoredPackages.get(root);
    // Recovery packages are themselves captures; omit output only when it is nested in this source.
    const outputRoot =
      sourceCapture.outputRoot && isPathInside(boundary, sourceCapture.outputRoot)
        ? sourceCapture.outputRoot
        : undefined;
    const existing = packages.get(root);
    if (existing) {
      if (!metadataOnly) {
        existing.materialize(executableEntry ? entry : undefined);
      }
      return existing.destination;
    }
    const packageId = `package-${packages.size}`;
    const moduleRoot = path.join(directory, packageId, "node_modules");
    const parentName = path.basename(path.dirname(boundary));
    const sourceModuleRoot = parentName.startsWith("@")
      ? path.dirname(path.dirname(boundary))
      : path.dirname(boundary);
    const destination = restored
      ? capturedPath(restored.destination)
      : path.join(
          moduleRoot,
          parentName.startsWith("@") ? parentName : "",
          path.basename(boundary),
        );
    const capturedBoundary = destination;
    sourceAliases[root] = destination;
    digest.update(packageId).update("\0");
    const owner: PluginPackageCapture = {
      destination,
      capturedRoot: capturedBoundary,
      sourceRoot: boundary,
      links: new Set<string>(restored?.links.map(capturedPath)),
      state: restored?.state ?? "metadata",
      captureTarget(filename) {
        const source = path.join(boundary, path.relative(capturedBoundary, filename));
        if (
          !capturedPaths.has(source) &&
          fs.statSync(source, { throwIfNoEntry: false })?.isFile() &&
          isPathInside(boundary, fs.realpathSync(source))
        ) {
          // Unselected branches must not initialize Jiti or validate their tsconfig.
          copy(source, filename);
          scopes.captureMetadata(path.dirname(source));
        }
      },
      materialize(selectedEntry) {
        if (typeof owner.state === "object") {
          throw owner.state.error;
        }
        if (owner.state === "body" && !selectedEntry) {
          return;
        }
        owner.state = selectedEntry && owner.state !== "body" ? "entry" : "body";
        try {
          if (selectedEntry) {
            captureFile(path.resolve(selectedEntry));
          } else {
            copy(root, destination);
          }
          captureDependencies();
        } catch (error) {
          owner.state = { error };
          throw error;
        }
      },
    };
    packages.set(root, owner);
    const ancestors = new Set<string>();
    const sourceLinks = createPluginSourceLinkCapture(restored?.sourceLinks);
    const recordMetadata = (source: string, target: string) => {
      metadataCapture.record(target, (manifest) => {
        for (const alias of importTargetNames(manifest.imports)) {
          if (alias === "openclaw" || alias === "@openclaw/plugin-sdk") {
            continue;
          }
          const dependency = resolveDependency(alias, source);
          if (dependency) {
            linkDependency(alias, dependency, true);
          }
        }
      });
    };
    const copy = (source: string, target: string) => {
      // Metadata can precede its package body; promotion never replaces those captured bytes.
      if (capturedPaths.get(path.resolve(source)) === target) {
        return;
      }
      const real = fs.realpathSync(source);
      if (!isPathInside(boundary, real)) {
        throw new Error(
          `Plugin source link leaves its package: ${path.relative(root, source)}. Declare shared code as a package dependency.`,
        );
      }
      if (outputRoot && isPathInside(outputRoot, real)) {
        return;
      }
      const stat = fs.statSync(real, { bigint: true });
      const captured = capturedPaths.get(real);
      const recordContent = (content: Buffer | string[]) => {
        if (!captured) {
          // Filesystem ticks can hide edits. Retain the bytes or member names actually copied,
          // not just stat fields; cached aliases must keep their first capture's facts.
          inputs.set(real, {
            identity: pluginSourceStatIdentity(stat),
            contentHash: pluginSourceContentHash(content),
            directory: stat.isDirectory(),
            boundary,
          });
          pendingInputs.add(real);
        }
      };
      capturedPaths.set(path.resolve(source), target);
      originalSources.set(target, path.resolve(source));
      // SDK companion loaders receive copied paths; those exact aliases retain this owner.
      capturedPaths.set(target, target);
      if (!capturedPaths.has(real)) {
        capturedPaths.set(real, target);
      }
      // Receipts cover copied empty directories as well as file contents.
      digest
        .update(stat.isDirectory() ? "directory\0" : "file\0")
        .update(path.relative(destination, target))
        .update("\0");
      if (stat.isDirectory()) {
        if (ancestors.has(real)) {
          throw new Error(`Plugin source contains a directory cycle: ${source}`);
        }
        ancestors.add(real);
        fs.mkdirSync(target, { recursive: true, mode: 0o700 });
        const names = fs.readdirSync(real).toSorted();
        recordContent(names);
        for (const name of names) {
          if (
            name !== "node_modules" &&
            name !== ".git" &&
            !(execute && sourceLinks.defer(path.join(source, name), boundary))
          ) {
            copy(path.join(source, name), path.join(target, name));
          }
        }
        ancestors.delete(real);
      } else if (stat.isFile()) {
        if (stat.nlink > 1n) {
          hardlinkedSources.add(target);
        }
        let bytes: Buffer;
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
        if (captured) {
          // A second filename for a prefetched entry retains its first bytes and source identity.
          bytes = fs.readFileSync(captured);
          fs.copyFileSync(captured, target);
        } else {
          bytes = readPluginSourceBytes(real, boundary);
          fs.writeFileSync(target, bytes, { mode: 0o600 | Number(stat.mode & 0o100n) });
        }
        recordContent(bytes);
        digest.update(String(bytes.length)).update("\0").update(bytes);
        additions.add(target);
        if (path.basename(target) === "package.json") {
          recordMetadata(source, target);
        }
      } else {
        throw new Error(`Plugin build input is not a regular file: ${source}`);
      }
    };
    const linkDependency = (
      name: string,
      dependency: PluginDependencyResolution,
      captureMetadataOnly = false,
    ) => {
      const captured = copyPackage(dependency.root, undefined, captureMetadataOnly);
      // Preserve real nested installs; synthetic per-file node_modules confuse native addon roots.
      // Installed peers also need sibling paths for native assets read directly from disk.
      const lookupDirectory = inPackage(boundary, dependency.lookupDirectory)
        ? path.join(capturedBoundary, path.relative(boundary, dependency.lookupDirectory))
        : path.join(dependency.lookupDirectory, "node_modules") === sourceModuleRoot
          ? path.dirname(moduleRoot)
          : capturedBoundary;
      const link = path.join(lookupDirectory, "node_modules", name);
      packages.get(dependency.root)!.links.add(link);
      if (!fs.existsSync(link)) {
        fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
        fs.symlinkSync(path.relative(path.dirname(link), captured), link, "junction");
        additions.add(link);
      }
    };
    const scopes = metadataCapture.createScope({
      root,
      destination,
      boundary,
      copy,
      hasSource: (source) => capturedPaths.has(source),
    });
    const references = new Map<string, Set<string>>(
      restored?.references.map(([source, names]) => [source, new Set(names)]),
    );
    packageSnapshots.set(root, () => {
      if (typeof owner.state === "object") {
        throw owner.state.error;
      }
      return {
        sourceRoot: root,
        destination: relative(destination),
        entry,
        executableEntry,
        state: owner.state,
        links: [...owner.links].map(relative),
        sourceLinks: sourceLinks.snapshot(),
        references: [...references].map(([source, names]) => [source, [...names]]),
      };
    });
    const getNativeScope = createPluginNativeDependencyScopes(
      resolveDependency,
      (name, dependency) => linkDependency(name, dependency, true),
    );
    const scannedDirectories = new Set<string>();
    const captureFile = (source: string, options?: JitiOptions): void => {
      const existingSource = capturedPaths.get(path.resolve(source));
      if (
        existingSource &&
        (!/\.[cm]?[jt]sx?$/.test(source) || moduleCaptures.has(existingSource))
      ) {
        return;
      }
      const target = existingSource ?? path.join(destination, path.relative(root, source));
      if (!existingSource) {
        const real = fs.realpathSync(source);
        if (!isPathInside(boundary, real)) {
          throw new Error("Standalone plugin input leaves its source directory");
        }
        if (outputRoot && isPathInside(outputRoot, real)) {
          return;
        }
        if (fs.statSync(source).isDirectory()) {
          if (scannedDirectories.has(real)) {
            throw new Error("Standalone plugin input contains a directory cycle");
          }
          scannedDirectories.add(real);
          for (const name of fs.readdirSync(source).toSorted()) {
            if (name !== "node_modules" && name !== ".git") {
              captureFile(path.join(source, name), options);
            }
          }
          scannedDirectories.delete(real);
          return;
        }
        copy(source, target);
      }
      if (!/\.[cm]?[jt]sx?$/.test(source)) {
        return;
      }
      const scope = scopes.resolve(path.dirname(source));
      const prepareDependency = createPluginDependencyLookup(
        source,
        scope?.manifest,
        resolveDependency,
        linkDependency,
      );
      const previousModule = restoredModules.get(source);
      const resolver = createJiti(source, {
        ...(previousModule?.options ?? options),
        fsCache: false,
        moduleCache: false,
        tryNative: false,
      });
      const captureReference = (
        reference: string,
        kind: "asset" | "import" | "require",
        conditions?: readonly string[],
      ): string | null | undefined => {
        const module = kind !== "asset";
        const importUrl =
          kind === "import" && reference.startsWith(".")
            ? new URL(reference, pathToFileURL(source))
            : undefined;
        const value = importUrl
          ? `./${path.relative(path.dirname(source), fileURLToPath(importUrl))}`
          : module && reference.startsWith("file:")
            ? fileURLToPath(reference)
            : reference;
        const resolve = (specifier: string) => {
          const resolved = resolver.esmResolve(specifier, {
            try: true,
            conditions: conditions
              ? [...conditions]
              : kind === "require"
                ? ["node", "require"]
                : ["node", "import"],
          });
          if (!resolved?.startsWith("file:")) {
            return resolved;
          }
          // Native resolution may return this generation's compiler output, not a new input.
          const url = new URL(resolved);
          const filename = fileURLToPath(url);
          const captured = moduleSource?.(filename) ?? filename;
          url.pathname = pathToFileURL(originalSources.get(captured) ?? captured).pathname;
          return url.href;
        };
        const addDependency = (name: string, importer = source) => {
          const imports = references.get(importer) ?? new Set<string>();
          imports.add(name);
          references.set(importer, imports);
        };
        if (module && !value.startsWith(".") && !path.isAbsolute(value)) {
          if (isBuiltin(value)) {
            return undefined;
          }
          const name = packageName(value);
          const resolved = resolve(value);
          const input = resolved?.startsWith("file:") ? fileURLToPath(resolved) : resolved;
          if (
            resolver.options.tsconfigPaths &&
            name !== "openclaw" &&
            name !== "@openclaw/plugin-sdk" &&
            resolved?.startsWith("file:") &&
            input
          ) {
            if (
              inPackage(boundary, input) &&
              (capturedPaths.has(path.resolve(input)) ||
                inPackage(boundary, fs.realpathSync(input)))
            ) {
              captureFile(input, resolver.options);
              return input;
            }
            if (!isPathInside(resolveDependency(name, source)?.root ?? boundary, input)) {
              return conditions && execute ? captureExecutableFile(input) : null;
            }
          }
          const self = scope?.manifest.exports != null && scope.manifest.name === name;
          if (!value.startsWith("#") && !self) {
            if (conditions && !resolved) {
              return undefined;
            }
            addDependency(name);
            return resolved?.startsWith("file:") ? input : undefined;
          }
          if (!input || isBuiltin(input)) {
            return undefined;
          }
          let external = false;
          if (!self && scope) {
            // Jiti selects the condition/target. String leaves identify lookup aliases only;
            // preserve every matching alias when several names share one physical package.
            for (const alias of scope.aliases) {
              const dependency = resolveDependency(alias, scope.source);
              if (dependency && isPathInside(dependency.root, input)) {
                addDependency(alias, scope.source);
                external = true;
              }
            }
          }
          if (!external) {
            captureFile(input, resolver.options);
          }
          return input;
        }
        const requested = path.resolve(path.dirname(source), value);
        const lexicalBoundary = entry && !executableEntry ? path.resolve(rootDir) : root;
        const local =
          module && path.isAbsolute(value) && isPathInside(lexicalBoundary, requested)
            ? path.join(boundary, path.relative(lexicalBoundary, requested))
            : requested;
        if (module && !isPathInside(boundary, local)) {
          if (!conditions || !execute) {
            return null;
          }
          const selected = resolve(local);
          if (!selected?.startsWith("file:")) {
            return undefined;
          }
          return captureExecutableFile(fileURLToPath(selected));
        }
        if (
          !value ||
          (!module && path.isAbsolute(value)) ||
          !isPathInside(boundary, local) ||
          local === boundary
        ) {
          return undefined;
        }
        // Dependency files retain their package owner, rather than becoming public source inputs.
        if (
          module &&
          path.isAbsolute(value) &&
          path.relative(boundary, local).split(path.sep).includes("node_modules")
        ) {
          return undefined;
        }
        // Captured local peers survive edits; deferred links enter only on executable demand.
        const fromCopy = owner.state === "body" && !sourceLinks.contains(local);
        const moduleRequest = fromCopy ? path.join(destination, path.relative(root, local)) : local;
        const resolved = module ? resolve(moduleRequest) : undefined;
        if (module && !resolved) {
          return undefined;
        }
        const input = resolved?.startsWith("file:") ? fileURLToPath(resolved) : (resolved ?? local);
        const capturedInput = capturedPaths.has(path.resolve(input));
        if (capturedInput || fs.existsSync(input)) {
          if (
            module &&
            execute &&
            !capturedInput &&
            !isPathInside(boundary, fs.realpathSync(input))
          ) {
            return conditions ? captureExecutableFile(input) : null;
          }
          captureFile(input, resolver.options);
          if (module && path.isAbsolute(value)) {
            capturedPaths.set(requested, capturedPaths.get(path.resolve(input))!);
          }
          return input;
        }
        return undefined;
      };
      const observed = restorePluginGenerationObservations(directory, previousModule);
      moduleSnapshots.set(source, () =>
        snapshotPluginGenerationModule(directory, resolver.options, observed),
      );
      const captureObservedReference = (
        reference: string,
        kind: "asset" | "import" | "require",
        conditions?: readonly string[],
      ) => {
        const key = `${kind}\0${reference}`;
        // Uninspected external references are distinct from observed absent local inputs.
        if (!observed.has(key) || (conditions && execute && observed.get(key) === null)) {
          observed.set(key, captureReference(reference, kind, conditions));
        }
        return observed.get(key) ?? undefined;
      };
      const captureModule = createPluginModuleSpecifierCapture({
        sourceRoot: boundary,
        capturedRoot: capturedBoundary,
        target,
        executable: execute !== undefined,
        tsconfigPaths: resolver.options.tsconfigPaths,
        manifest: scope?.manifest,
        capturedPaths,
        captureReference: captureObservedReference,
        captureFile: (filename) => captureFile(filename, resolver.options),
        captureDependencies,
        prepareDependency,
        packageForFile,
      });
      const nativeScope = getNativeScope(source, scope?.manifest);
      moduleCaptures.set(target, { prepareDependency, nativeScope, capture: captureModule });
      if (entry && !executableEntry) {
        visitPluginSourceReferences(
          source,
          fs.readFileSync(target, "utf8"),
          resolver,
          captureObservedReference,
        );
      }
    };
    const captureDependencies = () => {
      const manifestPath = path.join(root, "package.json");
      if (!entry && !capturedPaths.has(manifestPath)) {
        return;
      }
      const manifest = capturePluginDependencies({
        root,
        manifestFile: entry ? undefined : path.join(destination, "package.json"),
        references,
        resolve: resolveDependency,
        capture: linkDependency,
      });
      if (!entry) {
        metadataCapture.setManifest(path.join(destination, "package.json"), manifest);
      }
    };
    if (restored) {
      for (const [target, source] of restoredMetadata) {
        if (inPackage(destination, target)) {
          recordMetadata(source, target);
        }
      }
    } else if (metadataOnly) {
      const manifest = capturePluginPackageMetadata(root, destination, copy);
      metadataCapture.setManifest(path.join(destination, "package.json"), manifest ?? null);
    } else {
      owner.materialize(entry);
    }
    return destination;
  };
  const captureExecutableFile = (filename: string): string | undefined =>
    execute?.(() =>
      capturePluginModuleSource(filename, (root, source) => copyPackage(root, source, false, true)),
    );
  const packageForFile = (filename: string) =>
    findPluginCapturedPackage(packages, filename, directory)?.owner;

  try {
    const sourceRoot = state?.sourceRoot ?? fs.realpathSync(rootDir);
    const entry = entryFile
      ? state
        ? originalSources.get(capturedPaths.get(path.resolve(entryFile)) ?? "")
        : fs.realpathSync(entryFile)
      : state?.entryFile;
    for (const restored of state?.packages ?? []) {
      copyPackage(restored.sourceRoot, restored.entry, true, restored.executableEntry);
    }
    const root = state ? capturedPath(state.rootDir) : copyPackage(sourceRoot, entry);
    sourceAliases[path.resolve(rootDir)] = root;
    if (entry && entryFile) {
      const alias = path.join(
        sourceRoot,
        path.relative(path.resolve(rootDir), path.resolve(entryFile)),
      );
      capturedPaths.set(alias, capturedPaths.get(entry)!);
    }
    const assertSourceCurrent = () => {
      if (
        fs.realpathSync(rootDir) !== sourceRoot ||
        (entryFile && fs.realpathSync(entryFile) !== entry)
      ) {
        throw new Error("Plugin source root changed after capture");
      }
      verifyPluginSourceInputs(inputs, inputs.keys());
    };
    if (!state) {
      assertSourceCurrent();
    }
    pendingInputs.clear();
    additions.clear();
    const captures = [
      moduleCaptures,
      hardlinkedSources,
      metadataCapture,
      packages,
      packageSnapshots,
      moduleSnapshots,
    ];
    const clearCaptures = () => captures.forEach((capture) => capture.clear());
    const sourceDigest = state?.sourceDigest ?? digest.copy().digest("hex");
    return {
      sourceRoot,
      rootDir: root,
      sourceAliases,
      linkHost: sourceCapture.linkHost,
      sourceForCaptured: (file: string) => originalSources.get(path.resolve(file)),
      boundaryRoot: directory,
      // The receipt attests the initial snapshot; first-demand inputs extend only its identity ledger.
      sourceDigest,
      sourceAcquisition: prepared?.reason ?? "isolated-plugin-generation",
      snapshot(): PluginGenerationArtifactState {
        if (sourceCapture.hasFailures()) {
          throw new Error("An incomplete plugin capture cannot be published");
        }
        return facts.snapshot({
          sourceRoot,
          requestedRoot: path.resolve(rootDir),
          requestedEntry: entryFile,
          sourceDigest,
          rootDir: root,
          entryFile: entry,
          dependencies: resolveDependency.snapshot().map(([key, value]) => [key, value]),
        });
      },
      ...createPluginGenerationSourceLookup({
        rootDir,
        sourceRoot,
        capturedRoot: root,
        boundaryRoot: directory,
        capturedPaths,
        hardlinkedSources,
        assertModuleAvailable,
        captureInternalLinks: () =>
          [...packages.values()].map((owner) => ({
            destination: relative(owner.destination),
            links: [...owner.links].map(relative),
          })),
      }),
      assertSourceCurrent,
      ...createPluginGenerationModuleCapture({
        directory,
        packages,
        capturedPaths,
        originalSources,
        moduleCaptures,
        metadataCapture,
        assertModuleAvailable,
        captureAdmitted,
        captureExecutableFile,
        executable: execute !== undefined,
      }),
      dispose: () => {
        sourceCapture.dispose();
        clearCaptures();
      },
      disposeAsync: () => sourceCapture.disposeAsync().then(clearCaptures),
    };
  } catch (error) {
    sourceCapture.dispose();
    throw error;
  }
}
