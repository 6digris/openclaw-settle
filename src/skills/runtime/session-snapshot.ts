// Session snapshot helpers capture and restore runtime skill state for sessions.
import { stableStringify } from "@openclaw/normalization-core";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { matchesSkillFilter } from "../discovery/filter.js";
import {
  loadMergedWorkspaceSkills,
  normalizeWorkspaceSkillRoots,
} from "../loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import type { SkillEligibilityContext, SkillSnapshot } from "../types.js";
import { getSkillsSnapshotVersion, shouldRefreshSnapshotForVersion } from "./refresh-state.js";
import { ensureSkillsWatcher } from "./refresh.js";
import { fingerprintSkillSnapshotConfig } from "./snapshot-config-fingerprint.js";
import { hydrateResolvedSkills } from "./snapshot-hydration.js";
import { getWorkspaceSkillCatalog, prepareWorkspaceSkillCatalog } from "./workspace-catalog.js";

// Full snapshots let fresh sessions and runtime-only hydration share one versioned rebuild.
const skillSnapshotCache = new Map<string, SkillSnapshot>();
const SKILL_SNAPSHOT_CACHE_MAX = 10;

/** Inputs that make a resolved skill snapshot reusable within a process. */
type ReusableSkillSnapshotParams = {
  workspaceDir: string;
  executionSkillsDir?: string;
  config: OpenClawConfig;
  agentId?: string;
  skillFilter?: string[];
  skillOverrides?: Record<string, boolean>;
  eligibility?: SkillEligibilityContext;
  existingSnapshot?: SkillSnapshot;
  snapshotVersion?: number;
  watch?: boolean;
  hydrateExisting?: boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  signal?: AbortSignal;
};

type ReusableSkillSnapshotResult = {
  snapshot: SkillSnapshot;
  shouldRefresh: boolean;
  snapshotVersion: number;
};

function cacheSkillSnapshot(cacheKey: string, snapshot: SkillSnapshot): SkillSnapshot {
  skillSnapshotCache.set(cacheKey, snapshot);
  pruneMapToMaxSize(skillSnapshotCache, SKILL_SNAPSHOT_CACHE_MAX);
  return snapshot;
}

export async function resolveReusableWorkspaceSkillSnapshot(
  params: ReusableSkillSnapshotParams,
): Promise<ReusableSkillSnapshotResult> {
  params.signal?.throwIfAborted();
  const remoteWorkspace = getAgentWorkspaceAccess(params.workspaceDir)
    ? await prepareWorkspaceSkillCatalog(params)
    : false;
  const normalizedRoots = normalizeWorkspaceSkillRoots({
    agentWorkspaceDir: params.workspaceDir,
    ...(params.executionSkillsDir ? { executionSkillsDir: params.executionSkillsDir } : {}),
  });
  const skillRoots = normalizedRoots.executionSkillsDir
    ? {
        agentWorkspaceDir: normalizedRoots.agentWorkspaceDir,
        executionSkillsDir: normalizedRoots.executionSkillsDir,
      }
    : undefined;
  const watcherWorkspaceDir = skillRoots?.agentWorkspaceDir ?? params.workspaceDir;
  if (remoteWorkspace && normalizedRoots.executionSkillsDir) {
    throw new Error("Remote skill discovery does not support an additional execution skill root");
  }
  if (!remoteWorkspace && params.watch !== false) {
    ensureSkillsWatcher({
      workspaceDir: watcherWorkspaceDir,
      ...(skillRoots ? { executionSkillsDir: skillRoots.executionSkillsDir } : {}),
      config: params.config,
      ...(params.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
        : {}),
    });
  }
  const snapshotVersion = remoteWorkspace
    ? getSkillsSnapshotVersion(watcherWorkspaceDir)
    : (params.snapshotVersion ?? getSkillsSnapshotVersion(watcherWorkspaceDir));
  const promptFormatChanged =
    params.existingSnapshot?.promptFormatVersion !== WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION;
  const skillVersionChanged = remoteWorkspace
    ? params.existingSnapshot?.version !== snapshotVersion
    : shouldRefreshSnapshotForVersion(params.existingSnapshot?.version, snapshotVersion);
  const nodeSkillsEligibilityChanged =
    stableStringify(params.existingSnapshot?.nodeSkillsEligibility) !==
    stableStringify(params.eligibility?.nodeSkills);
  const skillOverridesChanged =
    stableStringify(params.existingSnapshot?.skillOverrides) !==
    stableStringify(params.skillOverrides);
  const skillRootsChanged =
    stableStringify(params.existingSnapshot?.skillRoots) !== stableStringify(skillRoots);
  const shouldRefresh =
    promptFormatChanged ||
    skillVersionChanged ||
    nodeSkillsEligibilityChanged ||
    skillRootsChanged ||
    !matchesSkillFilter(params.existingSnapshot?.skillFilter, params.skillFilter) ||
    skillOverridesChanged;
  const buildSnapshot = () => {
    const entries = remoteWorkspace
      ? getWorkspaceSkillCatalog(params.workspaceDir)
      : skillRoots
        ? loadMergedWorkspaceSkills({
            ...skillRoots,
            config: params.config,
            agentId: params.agentId,
            skillFilter: params.skillFilter,
            skillOverrides: params.skillOverrides,
            eligibility: params.eligibility,
            pluginMetadataSnapshot: params.pluginMetadataSnapshot,
          })
        : undefined;
    const snapshot = buildSkillSnapshot(params.workspaceDir, {
      config: params.config,
      ...(entries ? { entries, preserveEntryOrder: true } : {}),
      agentId: params.agentId,
      skillFilter: params.skillFilter,
      skillOverrides: params.skillOverrides,
      eligibility: params.eligibility,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
      snapshotVersion,
    });
    return skillRoots ? { ...snapshot, skillRoots } : snapshot;
  };

  const buildSnapshotCacheKey = () =>
    JSON.stringify([
      params.workspaceDir,
      skillRoots,
      snapshotVersion,
      params.skillFilter,
      params.skillOverrides,
      params.agentId,
      params.eligibility,
      fingerprintSkillSnapshotConfig(params.config),
    ]);

  const cachedRebuild = (snapshotCacheKey = buildSnapshotCacheKey()): SkillSnapshot => {
    const cachedSnapshot = skillSnapshotCache.get(snapshotCacheKey);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }
    return cacheSkillSnapshot(snapshotCacheKey, buildSnapshot());
  };

  const snapshot =
    !params.existingSnapshot || shouldRefresh
      ? cachedRebuild()
      : params.hydrateExisting === false
        ? params.existingSnapshot
        : hydrateResolvedSkills(params.existingSnapshot, cachedRebuild);
  return { snapshot, shouldRefresh, snapshotVersion };
}
