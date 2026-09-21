import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolvePathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { hasNodeErrorCode, isPathInside } from "../infra/path-guards.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  PluginGenerationArtifactStateSchema,
  rebindPluginGenerationArtifactLinks,
} from "./plugin-generation-artifact-state.js";
import type { PluginGenerationArtifact } from "./plugin-generation-artifact.js";
import {
  verifyPluginSourceInputs,
  withPluginSourceCaptureDirectory,
} from "./plugin-package-metadata-capture.js";

const graphSchema = z.object({
  files: z.array(z.string()),
  packageRoots: z.array(z.string()),
  unresolved: z.array(z.object({ source: z.string(), specifier: z.string() })),
  references: z.array(z.object({ source: z.string(), specifier: z.string(), target: z.string() })),
});
type Graph = z.infer<typeof graphSchema>;
export type PluginGenerationInspection = Graph;
type Entry = { rootDir: string; entryFile: string };
type PreparationEntry = Entry & { standalone: boolean };
const publicationSchema = z.object({
  reason: z.literal("prepared-candidate-plugin-generation"),
  hostRoot: z.string(),
  state: PluginGenerationArtifactStateSchema,
  graphs: z.array(z.tuple([z.string(), graphSchema])),
});
type Publication = z.infer<typeof publicationSchema>;
type PreparedPublication = Publication & { payload: string };
type Preparation = {
  root: string;
  directory: string;
  hostRoot: string;
  entries: readonly PreparationEntry[];
  artifacts: Map<string, PluginGenerationArtifact>;
  graphs: Map<string, Graph>;
  unavailable: Set<string>;
  warn: (message: string) => void;
};
export type PluginGenerationRehearsalContext = Readonly<{
  root: string;
  identity: string;
}>;
const { preparing, reading } = resolveGlobalSingleton(
  Symbol.for("openclaw.pluginGenerationRehearsalContexts"),
  () => ({
    preparing: new AsyncLocalStorage<Preparation>(),
    reading: new AsyncLocalStorage<PluginGenerationRehearsalContext | undefined>(),
  }),
);
function readRehearsalIdentity(root: string): string {
  const stat = fs.statSync(root, { bigint: true });
  if (!stat.isDirectory() || fs.realpathSync(root) !== root) {
    throw new Error("Plugin rehearsal owner is no longer the same private directory");
  }
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

/** Capture only at a verified rehearsal boundary, before nested read-only state overrides. */
export function capturePluginGenerationRehearsalContext(
  env = process.env,
): PluginGenerationRehearsalContext | undefined {
  const retained = reading.getStore();
  if (retained) {
    if (readRehearsalIdentity(retained.root) !== retained.identity) {
      throw new Error("Plugin rehearsal owner changed");
    }
    return retained;
  }
  const selected = resolveUpdateRehearsalRoot(env);
  if (!selected) {
    return undefined;
  }
  const root = fs.realpathSync(selected);
  return { root, identity: readRehearsalIdentity(root) };
}

/** The trusted worker envelope carries its parent's verified artifact namespace, never a path guess. */
export function withPluginGenerationRehearsalContext<T>(
  context: PluginGenerationRehearsalContext | undefined,
  run: () => T,
): T {
  if (context && readRehearsalIdentity(context.root) !== context.identity) {
    throw new Error("Plugin rehearsal owner changed before worker admission");
  }
  return reading.run(context, run);
}
const canonicalPath = (filename: string) =>
  resolvePathViaExistingAncestorSync(path.resolve(filename));
const artifactKey = (root: string, entry?: string) =>
  `${canonicalPath(root)}\0${entry ? canonicalPath(entry) : ""}`;
const graphKey = (root: string, entry: string) => artifactKey(root, path.resolve(entry));
const publicationPath = (root: string, key: string) =>
  path.join(root, ".plugin-generations", createHash("sha256").update(key).digest("hex"));

/** A published base never changes; every executing borrower receives its own physical view. */
function readRehearsalArtifact(
  rootDir: string,
  entryFile?: string,
): PreparedPublication | undefined {
  const root = preparing.getStore()?.root ?? capturePluginGenerationRehearsalContext()?.root;
  if (!root || !isPathInside(root, resolvePathViaExistingAncestorSync(path.resolve(rootDir)))) {
    return undefined;
  }
  for (const key of [artifactKey(rootDir), ...(entryFile ? [graphKey(rootDir, entryFile)] : [])]) {
    const directory = publicationPath(root, key);
    let text: string;
    try {
      text = fs.readFileSync(path.join(directory, "artifact.json"), "utf8");
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        continue;
      }
      throw error;
    }
    const publication = publicationSchema.parse(JSON.parse(text));
    if (publication.state.sourceRoot !== canonicalPath(rootDir)) {
      throw new Error("Prepared plugin generation names a different source root");
    }
    const payload = path.join(directory, "payload");
    if (fs.realpathSync(payload) !== payload || !isPathInside(fs.realpathSync(root), payload)) {
      throw new Error("Prepared plugin generation leaves its update rehearsal");
    }
    return { ...publication, payload };
  }
  return undefined;
}

export function readPluginGenerationRehearsalArtifact(
  rootDir: string,
  entryFile?: string,
): PreparedPublication | undefined {
  try {
    return readRehearsalArtifact(rootDir, entryFile);
  } catch (error) {
    process.emitWarning(
      `Prepared plugin capture unavailable; using an isolated acquisition: ${String(error)}`,
    );
    return undefined;
  }
}

export function borrowPreparingPluginGenerationArtifact(
  rootDir: string,
  entryFile: string | undefined,
  create: (entryFile: string | undefined) => PluginGenerationArtifact,
): PluginGenerationArtifact | undefined {
  const scope = preparing.getStore();
  const planned = scope?.entries.find(
    (entry) =>
      path.resolve(entry.rootDir) === path.resolve(rootDir) &&
      (!entry.standalone || path.resolve(entry.entryFile) === entryFile),
  );
  if (!scope || !planned) {
    return undefined;
  }
  const selectedEntry = planned.standalone ? planned.entryFile : undefined;
  const key = artifactKey(rootDir, selectedEntry);
  if (scope.unavailable.has(key)) {
    return undefined;
  }
  let artifact = scope.artifacts.get(key);
  if (!artifact) {
    try {
      artifact = withPluginSourceCaptureDirectory(
        scope.directory,
        () => create(selectedEntry),
        scope.directory,
      );
    } catch (error) {
      scope.unavailable.add(key);
      scope.warn(
        `Prepared plugin capture unavailable; preserving selective inspection: ${String(error)}`,
      );
      return undefined;
    }
    scope.artifacts.set(key, artifact);
  }
  return { ...artifact, dispose() {}, async disposeAsync() {} };
}

export function retainPluginGenerationInspection(entry: Entry, graph: Graph): void {
  const scope = preparing.getStore();
  if (
    scope?.entries.some(
      (planned) =>
        graphKey(planned.rootDir, planned.entryFile) === graphKey(entry.rootDir, entry.entryFile),
    )
  ) {
    scope.graphs.set(graphKey(entry.rootDir, entry.entryFile), graph);
  }
}

export function readPluginGenerationInspection(entry: Entry) {
  const publication = readPluginGenerationRehearsalArtifact(entry.rootDir, entry.entryFile);
  const graph = publication?.graphs.find(
    ([key]) => key === graphKey(entry.rootDir, entry.entryFile),
  )?.[1];
  if (!publication || !graph) {
    return undefined;
  }
  return {
    ...graph,
    generation: publication.payload,
    reuseReason: publication.reason,
    assertSourceCurrent(this: void) {
      const { state } = publication;
      if (
        fs.realpathSync(state.requestedRoot) !== state.sourceRoot ||
        (state.requestedEntry && fs.realpathSync(state.requestedEntry) !== state.entryFile)
      ) {
        throw new Error("Plugin source root changed after capture");
      }
      verifyPluginSourceInputs(
        new Map(state.inputs),
        state.inputs.map(([source]) => source),
      );
    },
  };
}

/** Completing a published driver's missing inputs starts a new, still-unpublished acquisition. */
export function invalidatePreparingPluginGenerations(): void {
  const scope = preparing.getStore();
  if (scope) {
    for (const artifact of scope.artifacts.values()) {
      try {
        artifact.dispose();
      } catch (error) {
        scope.warn(`Prepared plugin capture cleanup failed: ${String(error)}`);
      }
    }
    scope.artifacts.clear();
    scope.graphs.clear();
    scope.unavailable.clear();
  }
}

export async function withPluginGenerationRehearsalPreparation<T>(
  params: {
    env: NodeJS.ProcessEnv;
    hostRoot: string;
    entries: readonly PreparationEntry[];
    onWarning?: (message: string) => void;
  },
  run: () => Promise<T>,
): Promise<T> {
  const root = resolveUpdateRehearsalRoot(params.env);
  if (!root || params.env.OPENCLAW_UPDATE_IN_PROGRESS !== "1" || params.entries.length === 0) {
    return run();
  }
  const warn = params.onWarning ?? ((message: string) => process.emitWarning(message));
  let scope: Preparation;
  try {
    const parent = path.join(fs.realpathSync(root), ".plugin-generations");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(parent) !== parent) {
      throw new Error("Plugin generation preparation leaves its update rehearsal");
    }
    scope = {
      root: fs.realpathSync(root),
      directory: fs.mkdtempSync(path.join(parent, ".preparing-")),
      hostRoot: fs.realpathSync(params.hostRoot),
      entries: params.entries,
      artifacts: new Map(),
      graphs: new Map(),
      unavailable: new Set(),
      warn,
    };
  } catch (error) {
    warn(`Plugin capture preparation unavailable; using isolated acquisitions: ${String(error)}`);
    return run();
  }
  try {
    return await preparing.run(scope, async () => {
      const result = await run();
      for (const [key, artifact] of scope.artifacts) {
        try {
          artifact.assertSourceCurrent();
          artifact.linkHost(scope.hostRoot);
          const publication: Publication = {
            reason: "prepared-candidate-plugin-generation",
            hostRoot: scope.hostRoot,
            state: artifact.snapshot(),
            graphs: [...scope.graphs].filter(([entry]) =>
              entry.startsWith(`${path.resolve(artifact.sourceRoot)}\0`),
            ),
          };
          const staged = fs.mkdtempSync(path.join(scope.directory, "publish-"));
          fs.renameSync(artifact.boundaryRoot, path.join(staged, "payload"));
          rebindPluginGenerationArtifactLinks({
            directory: path.join(staged, "payload"),
            sourceDirectory: artifact.boundaryRoot,
            targetDirectory: path.join(publicationPath(scope.root, key), "payload"),
            packages: publication.state.packages,
          });
          fs.writeFileSync(path.join(staged, "artifact.json"), JSON.stringify(publication), {
            mode: 0o600,
          });
          try {
            fs.renameSync(staged, publicationPath(scope.root, key));
          } catch (error) {
            if (!hasNodeErrorCode(error, "EEXIST") && !hasNodeErrorCode(error, "ENOTEMPTY")) {
              throw error;
            }
            // An earlier complete producer remains authoritative; never replace its admitted bytes.
            const existing = publicationSchema.parse(
              JSON.parse(
                fs.readFileSync(
                  path.join(publicationPath(scope.root, key), "artifact.json"),
                  "utf8",
                ),
              ),
            );
            if (
              existing.hostRoot !== publication.hostRoot ||
              existing.state.sourceDigest !== publication.state.sourceDigest
            ) {
              throw new Error("Plugin generation changed during update preparation", {
                cause: error,
              });
            }
          }
        } catch (error) {
          warn(
            `Prepared plugin capture could not be retained; later checks will acquire an isolated copy: ${String(error)}`,
          );
        }
      }
      return result;
    });
  } finally {
    for (const artifact of scope.artifacts.values()) {
      try {
        artifact.dispose();
      } catch (error) {
        warn(`Prepared plugin capture cleanup failed: ${String(error)}`);
      }
    }
    try {
      fs.rmSync(scope.directory, { recursive: true, force: true });
    } catch (error) {
      warn(`Plugin capture preparation cleanup failed: ${String(error)}`);
    }
  }
}
