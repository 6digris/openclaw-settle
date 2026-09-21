import { createSubsystemLogger } from "../../logging/subsystem.js";
import { directorySizeBytes } from "./capacity.js";
import type { ManagedWorktreeRecord } from "./types.js";

const log = createSubsystemLogger("agents/worktrees");

/** Count manual trees toward pressure, but evict only unprotected run-owned trees. */
export async function enforceWorktreeCleanupLimits(params: {
  limits: { maxCount?: number; maxTotalSizeBytes?: number };
  listWorktrees: () => ManagedWorktreeRecord[];
  isProtected: (record: ManagedWorktreeRecord) => Promise<boolean>;
  remove: (record: ManagedWorktreeRecord) => Promise<unknown>;
}): Promise<string[]> {
  const { limits } = params;
  if (limits.maxCount === undefined && limits.maxTotalSizeBytes === undefined) {
    return [];
  }
  const live = params.listWorktrees().filter((record) => record.removedAt === undefined);
  const sizes = new Map<string, number>();
  let totalBytes = 0;
  if (limits.maxTotalSizeBytes !== undefined) {
    for (const record of live) {
      try {
        const bytes = await directorySizeBytes(record.path);
        sizes.set(record.id, bytes);
        totalBytes += bytes;
      } catch (error) {
        // Unmeasurable trees stay out of the size total, making it a lower
        // bound: measured worktrees stay capped while no worktree is ever
        // evicted off a bogus zero-byte reading. Aborting enforcement here
        // instead would let one unreadable directory disable the whole cap;
        // the count limit still bounds unmeasurable worktrees.
        log.warn(`worktree size measurement failed for ${record.id}: ${String(error)}`);
      }
    }
  }
  let liveCount = live.length;
  const overLimit = () =>
    (limits.maxCount !== undefined && liveCount > limits.maxCount) ||
    (limits.maxTotalSizeBytes !== undefined && totalBytes > limits.maxTotalSizeBytes);
  if (!overLimit()) {
    return [];
  }
  // Any concurrent removal (manual delete, run-end cleanup, competing gc)
  // must shrink the accounted pressure before the next destructive step, so
  // totals are recomputed from the registry per iteration. Sizes reuse the
  // up-front measurements; worktrees created after them are too fresh to be
  // eviction candidates in this pass.
  const refreshTotals = () => {
    const liveIds = new Set(
      params
        .listWorktrees()
        .filter((record) => record.removedAt === undefined)
        .map((record) => record.id),
    );
    liveCount = liveIds.size;
    if (limits.maxTotalSizeBytes !== undefined) {
      totalBytes = 0;
      for (const [id, bytes] of sizes) {
        if (liveIds.has(id)) {
          totalBytes += bytes;
        }
      }
    }
    return liveIds;
  };
  const removed: string[] = [];
  const candidates = live
    .filter((record) => record.ownerKind === "workboard" || record.ownerKind === "session")
    .toSorted((a, b) => a.lastActiveAt - b.lastActiveAt);
  for (const record of candidates) {
    const liveIds = refreshTotals();
    if (!overLimit()) {
      break;
    }
    if (!liveIds.has(record.id)) {
      continue;
    }
    try {
      if (await params.isProtected(record)) {
        continue;
      }
      await params.remove(record);
    } catch (error) {
      log.warn(`cleanup limit removal failed for ${record.id}: ${String(error)}`);
      continue;
    }
    removed.push(record.id);
  }
  refreshTotals();
  if (overLimit()) {
    log.warn(
      `worktree cleanup limits still exceeded after evicting ${removed.length}; remaining worktrees are protected or manual`,
    );
  }
  return removed;
}
