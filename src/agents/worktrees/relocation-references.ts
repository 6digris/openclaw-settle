import { isDeepStrictEqual } from "node:util";
import { openSessionEntryReadView } from "../../config/sessions/session-accessor.js";
import { publishSessionEntryCacheInvalidation } from "../../config/sessions/session-accessor.sqlite-entry-cache.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../config/sessions/targets.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPathInside } from "../../infra/path-guards.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import { withOpenClawAgentDatabaseAsync } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  listAgentIds,
  resolveAgentRunCwd,
  resolveAgentWorkspaceDir,
} from "../agent-scope-config.js";
import { movedSessionPaths, relocationSessionDigest } from "./relocation-session-paths.js";
import type { RelocationSessionOperations } from "./relocation-sessions.worker.js";
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
    for (const { sessionKey, entry } of openSessionEntryReadView({
      ...target,
      env,
      projection: "full",
    }).entries()) {
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
    const current = openSessionEntryReadView({
      agentId: reference.agentId,
      storePath: reference.storePath,
      env,
    }).get(reference.sessionKey);
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

export async function relocateWorktreeSessionReferences(
  plan: WorktreeMovePlan,
  env: NodeJS.ProcessEnv,
  assertOwned: () => void,
): Promise<void> {
  for (const reference of plan.sessions) {
    const resolved = toDatabaseOptions(
      resolveSqliteScope({
        agentId: reference.agentId,
        storePath: reference.storePath,
        sessionKey: reference.sessionKey,
        env,
      }),
    );
    const options = { ...resolved, path: resolveOpenClawAgentSqlitePath(resolved) };
    const identity = readDatabasePathIdentitySync(options.path);
    if (!identity.key.startsWith("file:")) {
      throw new Error("Session database disappeared during relocation");
    }
    const execution = captureOpenClawAgentDatabaseExecution(options);
    const assertCurrent = () => {
      execution.assertCurrent();
      assertExistingDatabaseIdentity(options.path, identity.key);
      assertOwned();
    };
    try {
      await runOpenClawAgentWriteAdmission(
        options,
        () =>
          withOpenClawAgentDatabaseAsync(
            options,
            async (database) => {
              assertCurrent();
              const worker = await openOpenClawAgentSqliteWorkerStore<RelocationSessionOperations>(
                options,
                database.db,
                {
                  moduleUrl: resolveRuntimeWorkerUrl(
                    runtimeProcessEntrypoints.worktreeRelocationSessions,
                  ),
                  input: { agentId: options.agentId, env },
                },
              );
              try {
                await worker.run(
                  (scope) =>
                    scope.execute({
                      type: "relocate",
                      input: { reference, paths: movedSessionPaths(plan, reference) },
                    }),
                  assertCurrent,
                );
              } finally {
                // Lost replies may follow a committed row. Invalidate canonically even
                // on failure; the durable shared intent keeps every affected path fenced.
                try {
                  publishSessionEntryCacheInvalidation(database, {
                    sessionKey: reference.sessionKey,
                  });
                } finally {
                  await worker.close();
                }
              }
            },
            assertCurrent,
          ),
        true,
      );
    } finally {
      await execution.release();
    }
  }
}
