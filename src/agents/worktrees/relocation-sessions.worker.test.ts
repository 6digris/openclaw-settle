import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  openSessionEntryReadView,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  readCommittedSessionEntryCache,
  readSessionEntryCache,
} from "../../config/sessions/session-accessor.sqlite-entry-cache.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { relocationSessionDigest } from "./relocation-session-paths.js";
import { bindSqliteWorkerBackend } from "./relocation-sessions.worker.js";
import type { WorktreeSessionReference } from "./relocation.types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("relocation session metadata commit", () => {
  let env: NodeJS.ProcessEnv;
  let reference: WorktreeSessionReference;
  let scope: { agentId: string; sessionKey: string; storePath: string; env: NodeJS.ProcessEnv };
  let worker: ReturnType<typeof bindSqliteWorkerBackend>;
  let database: ReturnType<typeof openOpenClawAgentDatabase>;
  let admit: ReturnType<typeof vi.fn<Parameters<typeof bindSqliteWorkerBackend>[1]["admit"]>>;
  const paths = {
    sessionRoot: "/new/workspace",
    spawnedCwd: "/new/workspace/task",
    spawnedWorkspaceDir: "/new/workspace",
  };

  beforeEach(async () => {
    env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("relocation-session-commit-") };
    scope = {
      agentId: "main",
      sessionKey: "agent:main:relocation",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main", env }),
      env,
    };
    await upsertSessionEntryCore(scope, {
      sessionId: "session-1",
      lifecycleRevision: "lifecycle-1",
      updatedAt: 1,
      sessionRoot: "/old/workspace",
      spawnedCwd: "/old/workspace/task",
      spawnedWorkspaceDir: "/old/workspace",
      worktree: { id: "worktree-1", repoRoot: "/repo", branch: "task" },
    });
    const entry = openSessionEntryReadView(scope).get(scope.sessionKey)!;
    reference = {
      agentId: scope.agentId,
      storePath: scope.storePath,
      sessionKey: scope.sessionKey,
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
      entryDigest: relocationSessionDigest(entry),
      sessionRoot: entry.sessionRoot,
      spawnedCwd: entry.spawnedCwd,
      spawnedWorkspaceDir: entry.spawnedWorkspaceDir,
      worktree: entry.worktree,
    };
    database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope)));
    admit = vi.fn<Parameters<typeof bindSqliteWorkerBackend>[1]["admit"]>();
    worker = bindSqliteWorkerBackend(
      { agentId: scope.agentId, env },
      { database: database.db, databasePath: database.path, admit },
    );
  });

  afterEach(async () => {
    await worker?.close();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
  });

  it("commits once and accepts only the same moved row on replay", () => {
    const beforeMove = openSessionEntryReadView(scope).get(scope.sessionKey)!;
    const command = { type: "relocate" as const, input: { reference, paths } };
    readSessionEntryCache(database, { cache: true });
    const publications: Array<{ inTransaction: boolean; cachedRoot: string | undefined }> = [];
    const unsubscribe = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
        publications.push({
          inTransaction: database.db.isTransaction,
          cachedRoot: readCommittedSessionEntryCache(database.db)?.get(scope.sessionKey)
            ?.sessionRoot,
        });
      }
    });
    try {
      worker.execute(command);
      worker.execute(command);
    } finally {
      unsubscribe();
    }
    worker.assertSettled?.();
    expect(publications).toEqual([{ inTransaction: false, cachedRoot: paths.sessionRoot }]);
    expect(admit.mock.calls.map(([stage]) => stage)).toEqual([
      "transaction",
      "commit",
      "transaction",
      "commit",
    ]);
    expect(openSessionEntryReadView(scope).get(scope.sessionKey)).toEqual({
      ...beforeMove,
      ...paths,
    });
  });

  it("rolls back row and cache state without publication when commit authority is revoked", () => {
    readSessionEntryCache(database, { cache: true });
    const publish = vi.fn();
    const unsubscribe = sessionChanges.subscribe(publish);
    admit.mockImplementation((stage: string) => {
      if (stage === "commit") {
        throw new Error("Commit authority revoked");
      }
    });
    try {
      expect(() => worker.execute({ type: "relocate", input: { reference, paths } })).toThrow(
        "Commit authority revoked",
      );
      worker.assertSettled?.();
      expect(publish).not.toHaveBeenCalled();
      expect(readCommittedSessionEntryCache(database.db)?.get(scope.sessionKey)?.sessionRoot).toBe(
        reference.sessionRoot,
      );
      expect(openSessionEntryReadView(scope).get(scope.sessionKey)).toMatchObject({
        sessionRoot: reference.sessionRoot,
        spawnedCwd: reference.spawnedCwd,
        spawnedWorkspaceDir: reference.spawnedWorkspaceDir,
      });
    } finally {
      unsubscribe();
    }
  });

  it("retains an unrelated later edit and refuses the old row digest", async () => {
    await patchSessionEntryCore(scope, () => ({ spawnedCwd: path.join("/other", "task") }), {
      preserveActivity: true,
    });
    expect(() => worker.execute({ type: "relocate", input: { reference, paths } })).toThrow(
      "Session workspace changed",
    );
    worker.assertSettled?.();
    expect(admit).not.toHaveBeenCalledWith("commit");
    expect(openSessionEntryReadView(scope).get(scope.sessionKey)?.spawnedCwd).toBe(
      path.join("/other", "task"),
    );
  });

  it("refuses changed row metadata even when all old path fields still match", async () => {
    await patchSessionEntryCore(scope, () => ({ label: "later operator edit" }), {
      preserveActivity: true,
    });
    expect(() => worker.execute({ type: "relocate", input: { reference, paths } })).toThrow(
      "Session row changed",
    );
    worker.assertSettled?.();
    expect(openSessionEntryReadView(scope).get(scope.sessionKey)?.sessionRoot).toBe(
      reference.sessionRoot,
    );
  });
});
