import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { resolveStateDir } from "../config/state-dir.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { withOpenClawAgentDatabaseWrite } from "../state/openclaw-agent-db-write.js";
import {
  runOpenClawAgentWriteTransaction,
  resolveOpenClawAgentSqlitePath,
  isIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import type { SessionCostUsageCacheRead } from "./session-cost-usage-cache-read.js";
import {
  acquireSessionCostUsageRefreshLockInDatabase,
  deleteSessionCostUsageRefreshLockInDatabase,
  pruneSessionCostUsageRollupsInDatabase,
  writeSessionCostUsageRollupInDatabase,
  type SessionCostUsageRollupRow,
} from "./session-cost-usage-cache.kernel.js";

// Per-agent SQLite storage for rebuildable per-session usage rollups.
type SessionCostUsageRefreshLock = {
  pid: number;
  startedAt: number;
  ownerNonce: string;
};

function captureCacheDatabaseOptions(
  inputOptions: Parameters<typeof runOpenClawAgentWriteTransaction>[1],
) {
  const options = {
    ...inputOptions,
    env: cloneEnvWithPlatformSemantics(inputOptions.env ?? process.env),
  };
  options.env.OPENCLAW_STATE_DIR = resolveStateDir(options.env);
  return { ...options, path: resolveOpenClawAgentSqlitePath(options) };
}

function runCacheWriteTransaction<T>(
  operation: Parameters<typeof runOpenClawAgentWriteTransaction<T>>[0],
  inputOptions: Parameters<typeof runOpenClawAgentWriteTransaction>[1],
  transactionOptions: Parameters<typeof runOpenClawAgentWriteTransaction>[2],
): Promise<T> {
  const options = captureCacheDatabaseOptions(inputOptions);
  return withOpenClawAgentDatabaseWrite(options, (database) =>
    runOpenClawAgentWriteTransaction(
      operation,
      { ...options, path: database.path },
      transactionOptions,
    ),
  );
}

async function readCacheDatabase(
  options: ReturnType<typeof captureCacheDatabaseOptions>,
  request: SessionCostUsageCacheRead,
) {
  if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
    const { readSessionCostUsageCache } = await import("./session-cost-usage-cache-read.js");
    return readSessionCostUsageCache(options, request);
  }
  return withSessionHistoryWorkerDatabase(options, (owner) =>
    owner.readUsageCache({
      request,
      env: { ...options.env, OPENCLAW_STATE_DIR: options.env.OPENCLAW_STATE_DIR },
    }),
  );
}

async function readRefreshLock(
  options: ReturnType<typeof captureCacheDatabaseOptions>,
): Promise<string | null> {
  const result = await readCacheDatabase(options, { kind: "usage-refresh-lock" });
  if (result.kind !== "usage-refresh-lock") {
    throw new Error("Usage cache worker returned rollups instead of a refresh lock");
  }
  return result.value;
}

async function deleteRefreshLockIfUnchanged(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  valueJson: string;
}): Promise<void> {
  await runCacheWriteTransaction(
    (database) => deleteSessionCostUsageRefreshLockInDatabase(database.db, params.valueJson),
    {
      agentId: normalizeAgentId(params.agentId),
      env: params.env,
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: "session-cost-usage.refresh-lock.delete" },
  );
}

export async function readSessionCostUsageRollupRows(
  agentId?: string,
  databasePath?: string,
  filePaths?: readonly string[],
): Promise<SessionCostUsageRollupRow[]> {
  const options = captureCacheDatabaseOptions({
    agentId: normalizeAgentId(agentId),
    path: databasePath,
  });
  const result = await readCacheDatabase(options, {
    kind: "usage-rollups",
    filePaths: filePaths ? [...filePaths] : undefined,
  });
  if (result.kind !== "usage-rollups") {
    throw new Error("Usage cache worker returned a refresh lock instead of rollups");
  }
  return result.rows;
}

export async function writeSessionCostUsageRollup(params: {
  agentId?: string;
  databasePath?: string;
  rollupId: string;
  previousValueJson: string | null;
  valueJson: string;
  updatedAt: number;
}): Promise<boolean> {
  return runCacheWriteTransaction(
    (database) => writeSessionCostUsageRollupInDatabase(database.db, params),
    {
      agentId: normalizeAgentId(params.agentId),
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: "session-cost-usage.rollup.write" },
  );
}

export async function deleteSessionCostUsageRollupsExcept(params: {
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  databasePath?: string;
  liveKeys: ReadonlySet<string>;
  rows: readonly SessionCostUsageRollupRow[];
}): Promise<void> {
  const existing = params.rows.filter((row) => !params.liveKeys.has(row.key));
  await runCacheWriteTransaction(
    (database) => pruneSessionCostUsageRollupsInDatabase(database.db, existing),
    {
      agentId: normalizeAgentId(params.agentId),
      env: params.env,
      ...(params.databasePath ? { path: params.databasePath } : {}),
    },
    { operationLabel: "session-cost-usage.rollup.prune" },
  );
}

function parseRefreshLock(raw: string | null): SessionCostUsageRefreshLock | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<SessionCostUsageRefreshLock> | null;
    if (
      !value ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.startedAt !== "number" ||
      !Number.isFinite(value.startedAt) ||
      typeof value.ownerNonce !== "string" ||
      !value.ownerNonce
    ) {
      return null;
    }
    return { pid: value.pid, startedAt: value.startedAt, ownerNonce: value.ownerNonce };
  } catch {
    return null;
  }
}

export async function isSessionCostUsageRefreshRunning(
  agentId?: string,
  databasePath?: string,
): Promise<boolean> {
  const options = captureCacheDatabaseOptions({
    agentId: normalizeAgentId(agentId),
    path: databasePath,
  });
  const lock = parseRefreshLock(await readRefreshLock(options));
  // Status never waits for a writer; acquisition replaces stale locks with its existing CAS.
  return lock !== null && isPidAlive(lock.pid);
}

export async function acquireSessionCostUsageRefreshLock(
  agentId?: string,
  databasePath?: string,
): Promise<{ acquired: boolean; release: () => Promise<void> }> {
  const options = captureCacheDatabaseOptions({
    agentId: normalizeAgentId(agentId),
    path: databasePath,
  });
  const previousRaw = await readRefreshLock(options);
  const previousLock = parseRefreshLock(previousRaw);
  // Process liveness is resolved before BEGIN. The transaction only compares
  // the authoritative row and commits the prepared replacement synchronously.
  const previousOwnerIsRunning = previousLock ? isPidAlive(previousLock.pid) : false;
  const lock: SessionCostUsageRefreshLock = {
    pid: process.pid,
    startedAt: Date.now(),
    ownerNonce: `${process.pid}:${Date.now()}:${process.hrtime.bigint()}`,
  };
  const lockJson = JSON.stringify(lock);
  const acquired = await runCacheWriteTransaction(
    (database) =>
      acquireSessionCostUsageRefreshLockInDatabase(database.db, {
        previousRaw,
        previousOwnerIsRunning,
        lockJson,
        startedAt: lock.startedAt,
      }),
    options,
    { operationLabel: "session-cost-usage.refresh-lock.acquire" },
  );
  return {
    acquired,
    release: async () => {
      if (acquired) {
        await deleteRefreshLockIfUnchanged({
          agentId: options.agentId,
          databasePath: options.path,
          env: options.env,
          valueJson: lockJson,
        });
      }
    },
  };
}
