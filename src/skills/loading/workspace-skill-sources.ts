import path from "node:path";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { isDefaultStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import type { WorkspaceSkillStatusFacts } from "../discovery/status.types.js";
import type { SkillEntry } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import {
  resolvePluginSkillRoots,
  resolvePluginSkillRootsFromMetadata,
  type PluginSkillRoot,
} from "./plugin-skills.js";
import { resolvePluginSkillsDir, resolveSkillsUserHomeDir } from "./skill-paths.js";
import type { ResolvedSkillDiscoveryLimits } from "./skill-root-discovery.js";
import { resolveWorkspaceSkillDirectories } from "./workspace-skill-roots.js";

/** Native discovery facts from the workspace host; Gateway retains filtering and policy. */
export type WorkspaceSkillSources = {
  entries: SkillEntry[];
  executionEntries: SkillEntry[];
  runtime: { platform: string; bins: string[] };
  status?: WorkspaceSkillStatusFacts;
};

export type WorkspaceSkillSourceRequest = {
  sourcePlan: WorkspaceSkillSourcePlan;
  /** Direct bundled lookup, before workspace precedence is applied. */
  bundledSkillName?: string;
  executionWorkspaceDir?: string;
  limits: ResolvedSkillDiscoveryLimits;
  /** Requirements from Gateway-owned Library selections also run on the workspace host. */
  additionalBins: string[];
  status?: { skillCardKey?: string };
};

export type WorkspaceSkillSource = {
  dir: string;
  source: string;
  tier: "extra" | "bundled" | "workshop" | "managed" | "personal" | "workspace";
  rejectHardlinks?: boolean;
};

export type WorkspaceSkillSourcePlan = {
  workspaceDir: string;
  /** Admitted paths; adapters map them along with the source roots. */
  allowSymlinkTargets?: string[];
  roots: WorkspaceSkillSource[];
  pluginSkillsDir: string;
  pluginSkillRoots: PluginSkillRoot[];
  managedSkillsDir: string;
  bundledSkillsDir?: string;
  stateDir: string;
  userHomeDir?: string;
};

/** Workshop publishes in agent state on Gateway, independently of workspace placement. */
export function splitSkillSourcePlan(plan: WorkspaceSkillSourcePlan) {
  return {
    gatewayRoots: plan.roots.filter((root) => root.tier === "workshop"),
    workspacePlan: { ...plan, roots: plan.roots.filter((root) => root.tier !== "workshop") },
  };
}

export function resolveCustodianSkillAgentId(
  config?: OpenClawConfig,
  agentId?: string,
  workspaceOnly = false,
) {
  const owner = config ? tryResolveAmbientOwnerAgentId(config) : undefined;
  return !workspaceOnly && agentId && owner && normalizeAgentId(agentId) === owner
    ? owner
    : undefined;
}

/** Source selection and precedence are shared by local discovery and provisioned remote discovery. */
export function resolveWorkspaceSkillSourcePlan(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    agentId?: string;
    workspaceOnly?: boolean;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    pluginSkillsDir?: string;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
  },
): WorkspaceSkillSourcePlan {
  const workspaceOnly = opts?.workspaceOnly === true;
  const userHomeDir = resolveSkillsUserHomeDir();
  const pluginSkillsDir = opts?.pluginSkillsDir ?? resolvePluginSkillsDir();
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const bundledSkillsDir = workspaceOnly
    ? undefined
    : (opts?.bundledSkillsDir ?? resolveBundledSkillsDir());
  const pluginParams = { workspaceDir, config: opts?.config, pluginSkillsDir };
  const pluginSkillRoots = workspaceOnly
    ? []
    : opts?.pluginMetadataSnapshot
      ? resolvePluginSkillRootsFromMetadata({
          ...pluginParams,
          metadataSnapshot: opts.pluginMetadataSnapshot,
        })
      : resolvePluginSkillRoots(pluginParams);
  const roots: WorkspaceSkillSource[] = [];
  if (!workspaceOnly) {
    roots.push(
      ...normalizeTrimmedStringList(opts?.config?.skills?.load?.extraDirs ?? []).map((dir) => ({
        dir: resolveUserPath(dir),
        source: "openclaw-extra",
        tier: "extra" as const,
      })),
    );
    roots.push(
      ...pluginSkillRoots.map((root) => ({
        ...root,
        source: "openclaw-extra",
        tier: "extra" as const,
      })),
    );
    if (bundledSkillsDir) {
      roots.push({ dir: bundledSkillsDir, source: "openclaw-bundled", tier: "bundled" });
      if (resolveCustodianSkillAgentId(opts?.config, opts?.agentId)) {
        roots.push({
          dir: path.join(path.dirname(bundledSkillsDir), "custodian-skills"),
          source: "openclaw-custodian",
          tier: "bundled",
        });
      }
    }
    if (opts?.config && opts.agentId) {
      roots.push({
        dir: resolveWorkshopSkillsDir(opts.config, opts.agentId),
        source: "openclaw-workshop",
        tier: "workshop",
      });
    }
    roots.push({ dir: managedSkillsDir, source: "openclaw-managed", tier: "managed" });
    if (isDefaultStateDir()) {
      roots.push({
        dir: path.resolve(userHomeDir ?? ".", ".agents", "skills"),
        source: "agents-skills-personal",
        tier: "personal",
      });
    }
  }
  roots.push(
    ...resolveWorkspaceSkillDirectories(workspaceDir, workspaceOnly).map(({ dir, source }) => ({
      dir,
      source,
      tier: "workspace" as const,
    })),
  );
  return {
    roots,
    allowSymlinkTargets: normalizeTrimmedStringList(
      opts?.config?.skills?.load?.allowSymlinkTargets ?? [],
    ).map((dir) => resolveUserPath(dir)),
    pluginSkillsDir,
    pluginSkillRoots,
    managedSkillsDir,
    bundledSkillsDir,
    stateDir: CONFIG_DIR,
    userHomeDir,
    workspaceDir,
  };
}
