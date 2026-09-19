import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type {
  PluginStateCompareIntent,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  getFileLockProcessStartTime,
  isPidDefinitelyDead,
} from "openclaw/plugin-sdk/process-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import {
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  memoryCoreStateReference,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
} from "./dreaming-state.js";
import type { ShortTermLockEntry } from "./short-term-promotion-types.js";

const MEMORY_WORKSPACE_LOCK_WAIT_TIMEOUT_MS = 10_000;
const SHORT_TERM_LOCK_STALE_MS = 60_000;
const MEMORY_WORKSPACE_LOCK_RETRY_DELAY_MS = 40;
const inProcessMemoryWorkspaceLocks = new KeyedAsyncQueue();
const memoryWorkspaceLockOwners = new Map<string, MemoryWorkspaceLease>();

type MemoryWorkspaceLease = {
  key: string;
  entry: ShortTermLockEntry;
  store: PluginStateKeyedStore<ShortTermLockEntry>;
  active: boolean;
};
type MemoryWorkspaceLockScope = {
  lease: MemoryWorkspaceLease;
  active: boolean;
  childTail: Promise<void>;
  parent: MemoryWorkspaceLockScope | undefined;
};
const memoryWorkspaceLockScopes = new AsyncLocalStorage<MemoryWorkspaceLockScope>();

function findActiveWorkspaceLockScope(key: string): MemoryWorkspaceLockScope | undefined {
  let scope = memoryWorkspaceLockScopes.getStore();
  while (scope) {
    if (!scope.active || !scope.lease.active) {
      return undefined;
    }
    if (scope.lease.key === key) {
      return scope;
    }
    scope = scope.parent;
  }
  return undefined;
}

async function runWorkspaceLockScope<T>(
  lease: MemoryWorkspaceLease,
  task: () => Promise<T>,
): Promise<T> {
  const scope: MemoryWorkspaceLockScope = {
    lease,
    active: true,
    childTail: Promise.resolve(),
    parent: memoryWorkspaceLockScopes.getStore(),
  };
  try {
    return await memoryWorkspaceLockScopes.run(scope, task);
  } finally {
    // Closed async contexts must acquire a new lease. Already accepted children
    // finish before the owner releases the cross-process lock.
    scope.active = false;
    await scope.childTail;
  }
}

export function resolveLockPath(workspaceDir: string): string {
  return memoryCoreStateReference(SHORT_TERM_LOCK_NAMESPACE, workspaceDir);
}

function parseLockOwnerPid(raw: string): number | null {
  const match = raw.trim().match(/^(\d+):/);
  const pid = Number.parseInt(match?.[1] ?? "", 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function isShortTermLockStealable(
  lockKey: string,
  existing: ShortTermLockEntry,
  nowMs: number,
): boolean {
  if (nowMs - existing.acquiredAt <= SHORT_TERM_LOCK_STALE_MS) {
    return false;
  }
  const ownerPid = parseLockOwnerPid(existing.owner);
  if (ownerPid === null) {
    return true;
  }
  if (ownerPid === process.pid) {
    // Preserve tracked live owners; abandoned rows can survive cleanup failure or PID reuse.
    const local = memoryWorkspaceLockOwners.get(lockKey);
    return !local?.active || local.entry.owner !== existing.owner;
  }
  if (isPidDefinitelyDead(ownerPid)) {
    return true;
  }
  // Shipped rows lack start identity. Keep a live foreign PID authoritative.
  if (existing.ownerStartTime === undefined) {
    return false;
  }
  const currentStartTime = getFileLockProcessStartTime(ownerPid);
  return currentStartTime !== null && currentStartTime !== existing.ownerStartTime;
}

export async function deleteShortTermLockEntryIfCurrent(
  lockStore: PluginStateKeyedStore<ShortTermLockEntry>,
  lockKey: string,
  expected: ShortTermLockEntry,
): Promise<boolean> {
  if (!lockStore.observe || !lockStore.compareAndApply) {
    throw new Error("memory-core short-term lock store requires atomic comparisons");
  }
  const { owner, acquiredAt } = expected;
  const decideDeletion = (
    current: ShortTermLockEntry | undefined,
  ): PluginStateCompareIntent<ShortTermLockEntry> => ({
    operation: "delete",
    action:
      current !== undefined && current.owner === owner && current.acquiredAt === acquiredAt
        ? "delete"
        : "keep",
  });
  let observation = await lockStore.observe(lockKey);
  while (true) {
    const result = await lockStore.compareAndApply(
      lockKey,
      observation.comparison,
      decideDeletion(observation.value),
    );
    if (result.status !== "conflict") {
      return result.status === "applied";
    }
    observation = result.current;
  }
}

async function releaseMemoryWorkspaceLease(lease: MemoryWorkspaceLease): Promise<void> {
  lease.active = false;
  memoryWorkspaceLockOwners.delete(lease.key);
  try {
    await deleteShortTermLockEntryIfCurrent(lease.store, lease.key, lease.entry);
  } catch (error) {
    memoryWorkspaceLockOwners.set(lease.key, lease);
    // Eviction forgets only settled cleanup; durable rows retain normal stale recovery.
    for (const [key, retained] of memoryWorkspaceLockOwners) {
      if (memoryWorkspaceLockOwners.size <= SHORT_TERM_LOCK_MAX_ENTRIES) {
        break;
      }
      if (!retained.active) {
        memoryWorkspaceLockOwners.delete(key);
      }
    }
    throw error;
  }
}

/** Captured input preparation shares local ordering without claiming a durable write lease. */
export async function withMemoryWorkspacePreparation<T>(
  workspaceDir: string,
  prepare: () => Promise<T>,
): Promise<T> {
  const key = memoryCoreWorkspaceStateKey(workspaceDir);
  if (findActiveWorkspaceLockScope(key)) {
    return await withMemoryWorkspaceLock(workspaceDir, prepare);
  }
  // Keep existing FIFO and pending Worker input bounds; never mint a write scope.
  return await inProcessMemoryWorkspaceLocks.enqueue(key, prepare);
}

export async function withMemoryWorkspaceLock<T>(
  workspaceDir: string,
  task: () => Promise<T>,
): Promise<T> {
  const lockKey = memoryCoreWorkspaceStateKey(workspaceDir);
  const scope = findActiveWorkspaceLockScope(lockKey);
  if (scope) {
    // Each scope queues its children separately: nested calls can reenter,
    // while Promise.all siblings cannot race read-modify-write operations.
    const child = scope.childTail.then(() => runWorkspaceLockScope(scope.lease, task));
    scope.childTail = child.then(
      () => undefined,
      () => undefined,
    );
    return await child;
  }
  const lockRef = resolveLockPath(workspaceDir);
  const lockStore = openMemoryCoreStateStore<ShortTermLockEntry>({
    namespace: SHORT_TERM_LOCK_NAMESPACE,
    maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
  });
  return await inProcessMemoryWorkspaceLocks.enqueue(lockKey, async () => {
    const retained = memoryWorkspaceLockOwners.get(lockKey);
    if (retained && !retained.active) {
      await releaseMemoryWorkspaceLease(retained);
    }
    const startedAt = Date.now();

    while (true) {
      const acquiredAt = Date.now();
      const ownerStartTime = getFileLockProcessStartTime(process.pid);
      const lockEntry: ShortTermLockEntry = {
        owner: `${process.pid}:${acquiredAt}:${randomUUID()}`,
        acquiredAt,
        ...(ownerStartTime === null ? {} : { ownerStartTime }),
      };
      const acquired = await lockStore.registerIfAbsent(lockKey, lockEntry);
      if (acquired) {
        const lease = { key: lockKey, entry: lockEntry, store: lockStore, active: true };
        memoryWorkspaceLockOwners.set(lockKey, lease);
        try {
          return await runWorkspaceLockScope(lease, task);
        } finally {
          await releaseMemoryWorkspaceLease(lease).catch(() => undefined);
        }
      }

      const existing = await lockStore.lookup(lockKey);
      if (existing && isShortTermLockStealable(lockKey, existing, Date.now())) {
        if (await deleteShortTermLockEntryIfCurrent(lockStore, lockKey, existing)) {
          continue;
        }
      }

      if (Date.now() - startedAt >= MEMORY_WORKSPACE_LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for memory workspace lock at ${lockRef}`);
      }

      await sleep(MEMORY_WORKSPACE_LOCK_RETRY_DELAY_MS);
    }
  });
}
