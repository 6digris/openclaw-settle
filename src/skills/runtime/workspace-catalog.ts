import path from "node:path";
import { z } from "zod";
import {
  getAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { evaluateRequirementsFromMetadataWithRemote } from "../../shared/requirements.js";
import { resolveBundledSkillsDir } from "../loading/bundled-dir.js";
import {
  resolveSkillInvocationPolicy,
  resolveSkillManifestMetadata,
} from "../loading/frontmatter.js";
import {
  resolvePluginSkillRoots,
  resolvePluginSkillRootsFromMetadata,
} from "../loading/plugin-skills.js";
import { resolveSkillDiscoveryLimits } from "../loading/skill-root-discovery.js";
import type { SkillEntry } from "../types.js";
import { bumpSkillsSnapshotVersion } from "./refresh-state.js";
import { fingerprintSkillSnapshotConfig } from "./snapshot-config-fingerprint.js";

// Metadata only. Transports may impose a smaller documented bound; never truncate a catalog.
const MAX_CATALOG_BYTES = 32 * 1024 * 1024;
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\0") && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)),
  );
const entrySchema = z.object({
  skill: z.object({
    name: z.string().min(1),
    description: z.string().min(1),
    displayName: z.string().optional(),
    filePath: absolutePath,
    baseDir: absolutePath,
    source: z.string().min(1),
    sourceInfo: z.object({
      path: absolutePath,
      source: z.string().min(1),
      scope: z.enum(["user", "project", "temporary"]),
      origin: z.enum(["package", "top-level"]),
      baseDir: absolutePath.optional(),
    }),
  }),
  frontmatter: z.record(z.string(), z.string()),
  metadata: z.object({ skillKey: z.string().optional() }).optional(),
});
const catalogSchema = z.object({
  revision: z.string().min(1).max(256),
  entries: z.array(entrySchema),
  runtime: z.object({ platform: z.string().min(1).max(32), bins: z.array(z.string().min(1)) }),
});
type Catalog = { revision: string; policyFingerprint: string; entries: SkillEntry[] };
type Runtime = {
  workspaceDir: string;
  access: AgentWorkspaceAccess;
  platform: string;
  bins: Set<string>;
  revision: string;
};
const catalogs = new WeakMap<AgentWorkspaceAccess, Catalog>();
const entryRuntimes = new WeakMap<SkillEntry, Runtime>();
const pending = new WeakMap<AgentWorkspaceAccess, Promise<void>>();

/** Prepare network IO once at the async snapshot boundary; synchronous consumers never scan a mirror. */
export async function prepareWorkspaceSkillCatalog(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  signal?: AbortSignal;
}): Promise<boolean> {
  const access = getAgentWorkspaceAccess(params.workspaceDir);
  if (!access) {
    return false;
  }
  // Serialize same-workspace scans so an older response cannot replace a newer catalog.
  // Each caller retains its own signal; canceling one turn never cancels another turn's scan.
  const previous = pending.get(access);
  const completion = createDeferredCore();
  pending.set(access, completion.promise);
  const assertCurrent = () => {
    params.signal?.throwIfAborted();
    if (getAgentWorkspaceAccess(params.workspaceDir) !== access) {
      throw new Error("Workspace skill catalog changed during preparation");
    }
  };
  try {
    await previous;
    assertCurrent();
    if (!access.loadSkills) {
      throw new Error("Remote workspace skill discovery is unavailable");
    }
    const limits = resolveSkillDiscoveryLimits(params.config);
    const pluginParams = { workspaceDir: params.workspaceDir, config: params.config };
    const pluginSkillRoots = params.pluginMetadataSnapshot
      ? resolvePluginSkillRootsFromMetadata({
          ...pluginParams,
          metadataSnapshot: params.pluginMetadataSnapshot,
        })
      : resolvePluginSkillRoots(pluginParams);
    const bundledSkillsDir = resolveBundledSkillsDir();
    const raw = await access.loadSkills({
      limits,
      pluginSkillRoots,
      ...(bundledSkillsDir ? { bundledSkillsDir } : {}),
      signal: params.signal,
    });
    assertCurrent();
    if (Buffer.byteLength(JSON.stringify(raw), "utf8") > MAX_CATALOG_BYTES) {
      throw new Error("Remote workspace skill catalog exceeds its byte limit");
    }
    const parsed = catalogSchema.parse(raw);
    const runtime: Runtime = {
      workspaceDir: params.workspaceDir,
      access,
      platform: parsed.runtime.platform,
      bins: new Set(parsed.runtime.bins),
      revision: parsed.revision,
    };
    const names = new Set<string>();
    const entries: SkillEntry[] = parsed.entries.map((entry) => {
      const flavor = path.posix.isAbsolute(entry.skill.filePath) ? path.posix : path.win32;
      if (
        flavor.dirname(entry.skill.filePath) !== entry.skill.baseDir ||
        flavor.basename(entry.skill.filePath) !== "SKILL.md" ||
        names.has(entry.skill.name)
      ) {
        throw new Error(
          "Remote workspace skill catalog has invalid or duplicate skill paths/names",
        );
      }
      // JSON escaping can expand a source byte sixfold; source scans enforce the actual file bound.
      if (Buffer.byteLength(JSON.stringify(entry), "utf8") > limits.maxSkillFileBytes * 6 + 32768) {
        throw new Error("Remote workspace skill metadata exceeds its source file limit");
      }
      names.add(entry.skill.name);
      const invocation = resolveSkillInvocationPolicy(entry.frontmatter);
      const metadata = resolveSkillManifestMetadata(entry.frontmatter);
      const result: SkillEntry = {
        skill: { ...entry.skill, disableModelInvocation: invocation.disableModelInvocation },
        frontmatter: entry.frontmatter,
        metadata: entry.metadata?.skillKey
          ? { ...metadata, skillKey: entry.metadata.skillKey }
          : metadata,
        invocation,
        // Remote skill text cannot introduce a direct Gateway tool-dispatch command.
        disableCommandDispatch: true,
        exposure: {
          includeInRuntimeRegistry: true,
          includeInAvailableSkillsPrompt: !invocation.disableModelInvocation,
          userInvocable: invocation.userInvocable,
        },
      };
      entryRuntimes.set(result, runtime);
      return result;
    });
    const prior = catalogs.get(access);
    const policyFingerprint = fingerprintSkillSnapshotConfig(params.config ?? {});
    catalogs.set(access, { revision: parsed.revision, policyFingerprint, entries });
    if (
      !prior ||
      prior.revision !== parsed.revision ||
      prior.policyFingerprint !== policyFingerprint
    ) {
      bumpSkillsSnapshotVersion({ workspaceDir: params.workspaceDir, reason: "remote-workspace" });
    }
    return true;
  } catch (error) {
    catalogs.delete(access);
    bumpSkillsSnapshotVersion({ workspaceDir: params.workspaceDir, reason: "remote-workspace" });
    throw error;
  } finally {
    completion.resolve();
    if (pending.get(access) === completion.promise) {
      pending.delete(access);
    }
  }
}

/** Undefined means locally owned. A remote workspace without a prepared catalog is an error. */
export function getWorkspaceSkillCatalog(
  workspaceDir: string,
  config?: OpenClawConfig,
): SkillEntry[] | undefined {
  const access = getAgentWorkspaceAccess(workspaceDir);
  if (!access) {
    return undefined;
  }
  const catalog = catalogs.get(access);
  if (!catalog) {
    throw new Error(
      "Remote workspace skill catalog is unavailable; prepare a fresh snapshot first",
    );
  }
  if (config && catalog.policyFingerprint !== fingerprintSkillSnapshotConfig(config)) {
    throw new Error("Remote workspace skill policy changed; prepare a fresh catalog first");
  }
  return catalog.entries;
}

export function evaluateWorkspaceSkillRuntime(
  entry: SkillEntry,
  checks: {
    isEnvSatisfied: (name: string) => boolean;
    isConfigSatisfied: (name: string) => boolean;
  },
): boolean | undefined {
  const runtime = entryRuntimes.get(entry);
  if (!runtime) {
    return undefined;
  }
  if (
    getAgentWorkspaceAccess(runtime.workspaceDir) !== runtime.access ||
    catalogs.get(runtime.access)?.revision !== runtime.revision
  ) {
    throw new Error("Remote workspace skill catalog is no longer active");
  }
  return evaluateRequirementsFromMetadataWithRemote({
    metadata: entry.metadata,
    always: entry.metadata?.always === true,
    hasLocalBin: (bin) => runtime.bins.has(bin),
    localPlatform: runtime.platform,
    ...checks,
  }).eligible;
}
