import { isDeepStrictEqual } from "node:util";
import { loadExactSessionEntryFromStoreReadOnly } from "../../config/sessions/session-accessor.sqlite-exact-read.js";
import { listSessionEntriesReadOnly } from "../../config/sessions/session-accessor.sqlite-list-read.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../config/sessions/targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  listAgentIds,
  resolveAgentRunCwd,
  resolveAgentWorkspaceDir,
} from "../agent-scope-config.js";
import { movedSessionPaths, relocationSessionDigest } from "./relocation-session-paths.js";
import type { WorktreeMovePlan, WorktreeSessionReference } from "./relocation.types.js";
import type { ManagedWorktreeRecord } from "./types.js";

/** Called by the shared-state worker; discovery never creates an agent store. */
export function readWorktreeSessionReferences(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  record: ManagedWorktreeRecord,
  projectionPath?: string,
): WorktreeSessionReference[] {
  const references: WorktreeSessionReference[] = [];
  const roots = [record.path, ...(projectionPath ? [projectionPath] : [])];
  const insideMovedRoot = (value: string | undefined) =>
    value && roots.some((root) => isPathInside(root, value));
  if (
    listAgentIds(config).some((id) =>
      [resolveAgentWorkspaceDir(config, id, env), resolveAgentRunCwd(config, id, env)].some(
        insideMovedRoot,
      ),
    )
  ) {
    throw new Error(
      "Checkout is a configured agent workspace or cwd; canonical owner relocation is a subsequent phase",
    );
  }
  for (const target of resolveAllAgentSessionStoreTargetsSync(config, { env })) {
    for (const { sessionKey, entry } of listSessionEntriesReadOnly({
      ...target,
      env,
      projection: "full",
      clone: false,
    })) {
      if ([entry.acp?.cwd, entry.acp?.runtimeOptions?.cwd].some(insideMovedRoot)) {
        throw new Error(
          "Checkout is bound to a persistent runtime cwd; finish that lifecycle before relocation",
        );
      }
      if (
        [
          entry.worktree?.repoRoot,
          entry.worktree?.canonicalWorkspaceDir,
          entry.pendingWorktree?.workspace,
        ].some(insideMovedRoot)
      ) {
        throw new Error(
          "Checkout is a session's canonical repository source; whole-graph relocation is required",
        );
      }
      if (
        entry.worktree?.id !== record.id &&
        ![entry.sessionRoot, entry.spawnedCwd, entry.spawnedWorkspaceDir].some(insideMovedRoot)
      ) {
        continue;
      }
      if (entry.worktree?.id !== record.id) {
        throw new Error(
          "A session uses this checkout without its managed worktree binding; reconcile that reference before moving",
        );
      }
      references.push({
        ...target,
        sessionKey,
        sessionId: entry.sessionId,
        entryDigest: relocationSessionDigest(entry),
        lifecycleRevision: entry.lifecycleRevision,
        sessionRoot: entry.sessionRoot,
        spawnedCwd: entry.spawnedCwd,
        spawnedWorkspaceDir: entry.spawnedWorkspaceDir,
        worktree: entry.worktree,
      });
      if (references.length > 1024) {
        throw new Error(
          "Worktree relocation has too many session references for one maintenance operation",
        );
      }
    }
  }
  return references.toSorted((a, b) =>
    `${a.storePath}\0${a.sessionKey}`.localeCompare(`${b.storePath}\0${b.sessionKey}`),
  );
}

/** Read on the worker; verification never repairs or creates session state. */
export function verifyWorktreeSessionReferences(
  plan: WorktreeMovePlan,
  env: NodeJS.ProcessEnv,
): string[] {
  for (const reference of plan.sessions) {
    const current = loadExactSessionEntryFromStoreReadOnly({
      agentId: reference.agentId,
      storePath: reference.storePath,
      env,
      sessionKey: reference.sessionKey,
    })?.entry;
    const expected = movedSessionPaths(plan, reference);
    if (
      !current ||
      current.sessionId !== reference.sessionId ||
      current.lifecycleRevision !== reference.lifecycleRevision ||
      !isDeepStrictEqual(current.worktree, reference.worktree) ||
      current.sessionRoot !== expected.sessionRoot ||
      current.spawnedCwd !== expected.spawnedCwd ||
      current.spawnedWorkspaceDir !== expected.spawnedWorkspaceDir
    ) {
      return ["A session binding no longer matches this relocation receipt"];
    }
  }
  return [];
}
