import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  PluginStateCompareResult,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteShortTermLockEntryIfCurrent,
  isShortTermLockStealable,
  withMemoryWorkspaceLock,
} from "./memory-workspace-lock.js";
import type { ShortTermLockEntry } from "./short-term-promotion-types.js";

const state = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./dreaming-state.js", () => ({
  SHORT_TERM_LOCK_MAX_ENTRIES: 2,
  SHORT_TERM_LOCK_NAMESPACE: "short-term-locks",
  memoryCoreStateReference: (namespace: string, workspace: string) => `${namespace}/${workspace}`,
  memoryCoreWorkspaceStateKey: (workspace: string) => workspace,
  openMemoryCoreStateStore: state.open,
}));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  getFileLockProcessStartTime: () => 123,
  isPidDefinitelyDead: () => false,
}));
vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  sleep: async () => {
    throw new Error("Unexpected lock contention");
  },
}));

function createLockStore() {
  const rows = new Map<string, ShortTermLockEntry>();
  const observation = (key: string) => ({
    value: structuredClone(rows.get(key)),
    comparison: JSON.stringify(rows.get(key)) ?? "missing",
  });
  const store = {
    observe: vi.fn(async (key: string) => observation(key)),
    compareAndApply: vi.fn<
      NonNullable<PluginStateKeyedStore<ShortTermLockEntry>["compareAndApply"]>
    >(async (key, comparison, intent): Promise<PluginStateCompareResult<ShortTermLockEntry>> => {
      const current = observation(key);
      if (comparison !== current.comparison) {
        return { status: "conflict", current };
      }
      if (intent.action === "keep") {
        return { status: "unchanged" };
      }
      if (intent.action === "delete") {
        return { status: rows.delete(key) ? "applied" : "unchanged" };
      }
      throw new Error("Unexpected lock update");
    }),
    async register(key: string, value: ShortTermLockEntry) {
      rows.set(key, structuredClone(value));
    },
    async registerIfAbsent(key: string, value: ShortTermLockEntry) {
      if (rows.has(key)) {
        return false;
      }
      rows.set(key, structuredClone(value));
      return true;
    },
    async lookup(key: string) {
      return structuredClone(rows.get(key));
    },
    async consume(key: string) {
      const value = rows.get(key);
      rows.delete(key);
      return value;
    },
    async delete(key: string) {
      return rows.delete(key);
    },
    async entries() {
      return [...rows].map(([key, value]) => ({ key, value, createdAt: value.acquiredAt }));
    },
    async clear() {
      rows.clear();
    },
  } satisfies PluginStateKeyedStore<ShortTermLockEntry>;
  state.open.mockReturnValue(store);
  return store;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("memory workspace lock comparisons", () => {
  const key = "synthetic-workspace";
  const expected: ShortTermLockEntry = { owner: "synthetic-owner", acquiredAt: 1 };

  it("releases a completed workspace lock through data-only storage", async () => {
    const store = createLockStore();
    await expect(
      withMemoryWorkspaceLock(key, async () => {
        expect(await store.lookup(key)).toBeDefined();
        return "completed";
      }),
    ).resolves.toBe("completed");
    expect(await store.lookup(key)).toBeUndefined();
  });

  it("reclaims a stale synthetic lock before running the next task", async () => {
    const store = createLockStore();
    await store.register(key, expected);
    await expect(
      withMemoryWorkspaceLock(key, async () => {
        expect(await store.lookup(key)).not.toEqual(expected);
        return "recovered";
      }),
    ).resolves.toBe("recovered");
    expect(await store.lookup(key)).toBeUndefined();
  });

  it.each([
    { owner: "replacement-owner", acquiredAt: expected.acquiredAt },
    { owner: expected.owner, acquiredAt: expected.acquiredAt + 1 },
  ])("preserves a replacement lock after a comparison conflict: %j", async (replacement) => {
    const store = createLockStore();
    await store.register(key, expected);
    const compare = store.compareAndApply.getMockImplementation()!;
    store.compareAndApply.mockImplementationOnce(async (...args) => {
      await store.register(key, replacement);
      return await compare(...args);
    });

    await expect(deleteShortTermLockEntryIfCurrent(store, key, expected)).resolves.toBe(false);
    expect(await store.lookup(key)).toEqual(replacement);
  });

  it("retries a conflict while preserving the owner and acquisition-time predicate", async () => {
    const store = createLockStore();
    await store.register(key, expected);
    const compare = store.compareAndApply.getMockImplementation()!;
    store.compareAndApply.mockImplementationOnce(async (...args) => {
      await store.register(key, { ...expected, ownerStartTime: 456 });
      return await compare(...args);
    });

    await expect(deleteShortTermLockEntryIfCurrent(store, key, expected)).resolves.toBe(true);
    expect(await store.lookup(key)).toBeUndefined();
  });

  it("reports a missing lock as unchanged", async () => {
    const store = createLockStore();
    await expect(deleteShortTermLockEntryIfCurrent(store, key, expected)).resolves.toBe(false);
  });

  it.each(["observe", "compareAndApply"] as const)("does not retry a failed %s", async (method) => {
    const store = createLockStore();
    await store.register(key, expected);
    const failure = new Error("worker result unavailable");
    store[method].mockRejectedValue(failure);

    await expect(deleteShortTermLockEntryIfCurrent(store, key, expected)).rejects.toBe(failure);
    expect(store[method]).toHaveBeenCalledOnce();
    expect(await store.lookup(key)).toEqual(expected);
  });

  it.each(["observe", "compareAndApply"] as const)(
    "reconciles a settled lease after its release %s fails",
    async (method) => {
      const workspace = `release-failure-${method}`;
      const store = createLockStore();
      store[method].mockRejectedValueOnce(new Error("worker result unavailable"));
      await expect(withMemoryWorkspaceLock(workspace, async () => "completed")).resolves.toBe(
        "completed",
      );
      expect(store[method]).toHaveBeenCalledOnce();
      expect(await store.lookup(workspace)).toBeDefined();

      const retryFailure = new Error("cleanup still unavailable");
      store[method].mockRejectedValueOnce(retryFailure);
      const blocked = vi.fn(async () => undefined);
      await expect(withMemoryWorkspaceLock(workspace, blocked)).rejects.toBe(retryFailure);
      expect(blocked).not.toHaveBeenCalled();

      await expect(withMemoryWorkspaceLock(workspace, async () => "recovered")).resolves.toBe(
        "recovered",
      );
      expect(await store.lookup(workspace)).toBeUndefined();
    },
  );

  it("reconciles a release whose deletion succeeded before its reply failed", async () => {
    const workspace = "lost-release-reply";
    const store = createLockStore();
    const compare = store.compareAndApply.getMockImplementation()!;
    store.compareAndApply.mockImplementationOnce(async (...args) => {
      await compare(...args);
      throw new Error("worker reply unavailable");
    });
    await withMemoryWorkspaceLock(workspace, async () => undefined);
    expect(await store.lookup(workspace)).toBeUndefined();

    await expect(withMemoryWorkspaceLock(workspace, async () => "recovered")).resolves.toBe(
      "recovered",
    );
    expect(await store.lookup(workspace)).toBeUndefined();
  });

  it("keeps an unfamiliar same-process replacement authoritative", async () => {
    const workspace = "replacement-after-release";
    const store = createLockStore();
    store.compareAndApply.mockRejectedValueOnce(new Error("worker result unavailable"));
    await withMemoryWorkspaceLock(workspace, async () => undefined);
    const replacement = {
      owner: `${process.pid}:another-instance`,
      acquiredAt: Date.now(),
      ownerStartTime: 123,
    };
    await store.register(workspace, replacement);
    const contender = vi.fn(async () => undefined);

    await expect(withMemoryWorkspaceLock(workspace, contender)).rejects.toThrow(
      "Unexpected lock contention",
    );
    expect(contender).not.toHaveBeenCalled();
    expect(await store.lookup(workspace)).toEqual(replacement);
  });

  it("reconciles cleanup through the store that granted the lease", async () => {
    const workspace = "reconfigured-store";
    const original = createLockStore();
    original.compareAndApply.mockRejectedValueOnce(new Error("worker result unavailable"));
    await withMemoryWorkspaceLock(workspace, async () => undefined);
    const replacement = createLockStore();

    await withMemoryWorkspaceLock(workspace, async () => {
      expect(await original.lookup(workspace)).toBeUndefined();
      expect(await replacement.lookup(workspace)).toBeDefined();
    });
    expect(await replacement.lookup(workspace)).toBeUndefined();
  });

  it("does not let delayed cleanup delete a later lease acquired in the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const workspace = "same-millisecond-leases";
    const store = createLockStore();
    const first = await withMemoryWorkspaceLock(workspace, async () => store.lookup(workspace));
    expect(first).toBeDefined();

    await withMemoryWorkspaceLock(workspace, async () => {
      const current = await store.lookup(workspace);
      await expect(deleteShortTermLockEntryIfCurrent(store, workspace, first!)).resolves.toBe(
        false,
      );
      expect(await store.lookup(workspace)).toEqual(current);
    });
  });

  it("joins accepted children before reconciling a failed release for the next writer", async () => {
    const workspace = "accepted-child-release";
    const store = createLockStore();
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const returned = createDeferred<void>();
    const order: string[] = [];
    let child: Promise<void> | undefined;
    let settled = false;
    store.compareAndApply.mockRejectedValueOnce(new Error("worker result unavailable"));
    const parent = withMemoryWorkspaceLock(workspace, async () => {
      child = withMemoryWorkspaceLock(workspace, async () => {
        entered.resolve();
        await resume.promise;
        order.push("child");
      });
      returned.resolve();
    }).then(() => {
      settled = true;
    });
    let next: Promise<void> | undefined;
    try {
      await returned.promise;
      await entered.promise;
      next = withMemoryWorkspaceLock(workspace, async () => {
        order.push("next");
      });
      expect(
        await store.registerIfAbsent(workspace, {
          owner: "independent-writer",
          acquiredAt: Date.now(),
        }),
      ).toBe(false);
      expect(settled).toBe(false);
      expect(store.compareAndApply).not.toHaveBeenCalled();
      resume.resolve();
      await Promise.all([parent, child, next]);
      expect(order).toEqual(["child", "next"]);
      expect(await store.lookup(workspace)).toBeUndefined();
    } finally {
      resume.resolve();
      await Promise.allSettled([parent, child, next]);
    }
  });

  it("bounds failed-release receipts without evicting a live lease or stealing forgotten rows", async () => {
    const store = createLockStore();
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const active = withMemoryWorkspaceLock("receipt-capacity-active", async () => {
      entered.resolve();
      await resume.promise;
    });
    try {
      await entered.promise;
      for (const workspace of ["receipt-capacity-old", "receipt-capacity-recent"]) {
        store.compareAndApply.mockRejectedValueOnce(new Error("worker result unavailable"));
        await withMemoryWorkspaceLock(workspace, async () => undefined);
      }
      const held = await store.lookup("receipt-capacity-active");
      expect(held).toBeDefined();
      expect(isShortTermLockStealable("receipt-capacity-active", held!, Date.now() + 120_000)).toBe(
        false,
      );
      const contender = vi.fn(async () => undefined);
      await expect(withMemoryWorkspaceLock("receipt-capacity-old", contender)).rejects.toThrow(
        "Unexpected lock contention",
      );
      expect(contender).not.toHaveBeenCalled();
      expect(await store.lookup("receipt-capacity-old")).toBeDefined();
      await withMemoryWorkspaceLock("receipt-capacity-recent", async () => undefined);
      expect(await store.lookup("receipt-capacity-recent")).toBeUndefined();
    } finally {
      resume.resolve();
      await active;
    }
  });

  it.each(["observe", "compareAndApply"] as const)(
    "requires %s before deletion",
    async (method) => {
      const store: PluginStateKeyedStore<ShortTermLockEntry> = createLockStore();
      await store.register(key, expected);
      store[method] = undefined;
      await expect(deleteShortTermLockEntryIfCurrent(store, key, expected)).rejects.toThrow(
        "memory-core short-term lock store requires atomic comparisons",
      );
      expect(await store.lookup(key)).toEqual(expected);
    },
  );
});
