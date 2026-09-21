import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JitiOptions } from "jiti";
import { z } from "zod";
import { isPathInside, normalizeWindowsPathPreservingCase } from "../infra/path-guards.js";
import type { createPluginSourceCapture } from "./plugin-package-metadata-capture.js";

const location = z.object({ path: z.string(), captured: z.boolean() });
const pairs = <T extends z.ZodType>(value: T) => z.array(z.tuple([z.string(), value]));
const sourceInput = z.object({
  identity: z.string(),
  contentHash: z.string(),
  directory: z.boolean(),
  boundary: z.string(),
});
export type PluginSourceInput = z.infer<typeof sourceInput>;
export const pluginSourceStatIdentity = (stat: fs.BigIntStats): string =>
  `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
export const pluginSourceContentHash = (content: Buffer | string[]) =>
  createHash("sha256")
    .update(Array.isArray(content) ? JSON.stringify(content) : content)
    .digest("hex");
const resolutionSchema = z.object({ root: z.string(), lookupDirectory: z.string() });
const optionsSchema = z.object({
  alias: z.record(z.string(), z.string()).optional(),
  extensions: z.array(z.string()).optional(),
  tsconfigPaths: z.union([z.boolean(), z.string()]).optional(),
  jsx: z
    .union([
      z.boolean(),
      z.object({
        throwIfNamespace: z.boolean().optional(),
        runtime: z.enum(["classic", "automatic"]).optional(),
        importSource: z.string().optional(),
        pragma: z.string().optional(),
        pragmaFrag: z.string().optional(),
        useBuiltIns: z.boolean().optional(),
        useSpread: z.boolean().optional(),
      }),
    ])
    .optional(),
});

/** Only generated acquisition facts cross processes; loaders and registrations never do. */
export const PluginGenerationArtifactStateSchema = z.object({
  version: z.literal(1),
  sourceRoot: z.string(),
  requestedRoot: z.string(),
  requestedEntry: z.string().optional(),
  sourceDigest: z.string(),
  rootDir: z.string(),
  entryFile: z.string().optional(),
  capturedPaths: z.array(z.tuple([location, z.string()])),
  originalSources: pairs(z.string()),
  sourceAliases: pairs(z.string()),
  hardlinkedSources: z.array(z.string()),
  inputs: pairs(sourceInput),
  dependencies: pairs(resolutionSchema.nullable()),
  packages: z.array(
    z.object({
      sourceRoot: z.string(),
      destination: z.string(),
      entry: z.string().optional(),
      executableEntry: z.boolean(),
      state: z.enum(["metadata", "entry", "body"]),
      links: z.array(z.string()),
      sourceLinks: z.array(z.string()),
      references: pairs(z.array(z.string())),
    }),
  ),
  modules: pairs(
    z.object({
      options: optionsSchema,
      // false is an observed absence; null remains an uninspected external reference.
      observed: pairs(z.union([location, z.null(), z.literal(false)])),
    }),
  ),
});

export type PluginGenerationArtifactState = z.infer<typeof PluginGenerationArtifactStateSchema>;
type PluginGenerationPackageState = PluginGenerationArtifactState["packages"][number];
export type PluginGenerationModuleState = PluginGenerationArtifactState["modules"][number][1];
export type PluginGenerationLinkState = Pick<PluginGenerationPackageState, "destination" | "links">;

function pluginGenerationRelativePath(directory: string, filename: string): string {
  const absolute = path.resolve(filename);
  if (!isPathInside(directory, absolute)) {
    throw new Error("Plugin artifact output is outside its capture");
  }
  return path.relative(directory, absolute);
}

function resolvePluginGenerationCapturedPath(directory: string, relative: string): string {
  if (path.isAbsolute(relative)) {
    throw new Error("Plugin artifact path is not relative to its capture");
  }
  const filename = path.resolve(directory, relative);
  if (!isPathInside(directory, filename)) {
    throw new Error("Plugin artifact path leaves its capture");
  }
  return filename;
}

function pluginGenerationStateLocation(directory: string, filename: string) {
  return isPathInside(directory, filename)
    ? { path: pluginGenerationRelativePath(directory, filename), captured: true }
    : { path: filename, captured: false };
}

/** Junction targets are absolute on Windows; move only the artifact owner's recorded links. */
export function rebindPluginGenerationArtifactLinks(params: {
  directory: string;
  sourceDirectory: string;
  targetDirectory?: string;
  packages: readonly PluginGenerationLinkState[];
}): void {
  const targetDirectory = params.targetDirectory ?? params.directory;
  const normalize = (filename: string) =>
    process.platform === "win32" ? normalizeWindowsPathPreservingCase(filename) : filename;
  const samePath = (left: string, right: string) =>
    path.relative(normalize(left), normalize(right)) === "";
  for (const entry of params.packages) {
    const target = resolvePluginGenerationCapturedPath(targetDirectory, entry.destination);
    for (const relative of entry.links) {
      const link = resolvePluginGenerationCapturedPath(params.directory, relative);
      // An alias can already be a captured directory; it is not a generated link to replace.
      if (!fs.lstatSync(link).isSymbolicLink()) {
        continue;
      }
      if (!isPathInside(params.directory, fs.realpathSync(path.dirname(link)))) {
        throw new Error("Plugin dependency link parent leaves its writable capture");
      }
      const current = path.resolve(path.dirname(link), fs.readlinkSync(link));
      if (
        ![params.sourceDirectory, params.directory, targetDirectory].some((directory) =>
          samePath(current, resolvePluginGenerationCapturedPath(directory, entry.destination)),
        )
      ) {
        throw new Error("Plugin dependency link no longer names its captured package");
      }
      fs.unlinkSync(link);
      fs.symlinkSync(
        samePath(params.directory, targetDirectory)
          ? path.relative(path.dirname(link), target)
          : target,
        link,
        "junction",
      );
    }
  }
}

/** Rebase generated paths into a borrower's isolated view, retaining original input identities. */
export function createPluginGenerationArtifactFacts(
  capture: Pick<ReturnType<typeof createPluginSourceCapture>, "directory" | "inputs" | "dispose">,
  prepared?: { state: PluginGenerationArtifactState; payload: string },
) {
  try {
    if (prepared) {
      // Cloning is optional; a regular copy still gives every borrower independent writable bytes.
      fs.cpSync(prepared.payload, capture.directory, {
        recursive: true,
        verbatimSymlinks: true,
        mode: fs.constants.COPYFILE_FICLONE,
      });
      rebindPluginGenerationArtifactLinks({
        directory: capture.directory,
        sourceDirectory: prepared.payload,
        packages: prepared.state.packages,
      });
    }
    return restorePluginGenerationArtifactFacts(capture.directory, prepared?.state, capture.inputs);
  } catch (error) {
    capture.dispose();
    throw error;
  }
}

function restorePluginGenerationArtifactFacts(
  directory: string,
  state: PluginGenerationArtifactState | undefined,
  inputs: Map<string, PluginSourceInput>,
) {
  const captured = (relative: string) => resolvePluginGenerationCapturedPath(directory, relative);
  const relative = (filename: string) => pluginGenerationRelativePath(directory, filename);
  const capturedPaths = new Map<string, string>(
    state?.capturedPaths.map(([source, target]) => [
      source.captured ? captured(source.path) : source.path,
      captured(target),
    ]),
  );
  const originalSources = new Map<string, string>(
    state?.originalSources.map(([file, source]) => [captured(file), source]),
  );
  const restoredMetadata = [...originalSources].filter(
    ([target]) => path.basename(target) === "package.json" && fs.statSync(target).isFile(),
  );
  const hardlinkedSources = new Set<string>(state?.hardlinkedSources.map(captured));
  const sourceAliases: Record<string, string> = Object.fromEntries(
    state?.sourceAliases.map(([source, target]) => [source, captured(target)]) ?? [],
  );
  const packageSnapshots = new Map<string, () => PluginGenerationPackageState>();
  const moduleSnapshots = new Map<string, () => PluginGenerationModuleState>();
  for (const [source, input] of state?.inputs ?? []) {
    inputs.set(source, input);
  }
  return {
    captured,
    relative,
    capturedPaths,
    originalSources,
    restoredMetadata,
    hardlinkedSources,
    sourceAliases,
    packageSnapshots,
    moduleSnapshots,
    snapshot(
      params: Pick<
        PluginGenerationArtifactState,
        | "sourceRoot"
        | "requestedRoot"
        | "requestedEntry"
        | "sourceDigest"
        | "entryFile"
        | "dependencies"
      > & { rootDir: string },
    ): PluginGenerationArtifactState {
      return {
        ...params,
        version: 1,
        rootDir: relative(params.rootDir),
        capturedPaths: [...capturedPaths].map(([source, target]) => [
          pluginGenerationStateLocation(directory, source),
          relative(target),
        ]),
        originalSources: [...originalSources].map(([file, source]) => [relative(file), source]),
        sourceAliases: Object.entries(sourceAliases).map(([source, target]) => [
          source,
          relative(target),
        ]),
        hardlinkedSources: [...hardlinkedSources].map(relative),
        inputs: [...inputs],
        packages: [...packageSnapshots.values()].map((snapshot) => snapshot()),
        modules: [...moduleSnapshots].map(([source, snapshot]) => [source, snapshot()]),
      };
    },
  };
}

export function restorePluginGenerationObservations(
  directory: string,
  state?: PluginGenerationModuleState,
) {
  return new Map<string, string | null | undefined>(
    state?.observed.map(([reference, resolution]) => [
      reference,
      resolution === false
        ? undefined
        : resolution === null
          ? null
          : resolution.captured
            ? resolvePluginGenerationCapturedPath(directory, resolution.path)
            : resolution.path,
    ]),
  );
}

export function snapshotPluginGenerationModule(
  directory: string,
  options: JitiOptions,
  observed: ReadonlyMap<string, string | null | undefined>,
): PluginGenerationModuleState {
  return {
    options: {
      alias: options.alias,
      extensions: options.extensions,
      tsconfigPaths: options.tsconfigPaths,
      jsx: options.jsx,
    },
    observed: [...observed].map(([reference, resolution]) => [
      reference,
      resolution === undefined
        ? false
        : resolution === null
          ? null
          : pluginGenerationStateLocation(directory, resolution),
    ]),
  };
}
