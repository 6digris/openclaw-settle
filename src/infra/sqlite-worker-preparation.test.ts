import { createHash } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOpenInput, FixtureOperations } from "./sqlite-worker-store.test-support.js";

const stores = new Set<SqliteWorkerStore<FixtureOperations>>();
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all([...stores].map((store) => store.close()));
    } finally {
      stores.clear();
      cleanup();
    }
  }),
);

async function open(databasePath: string, input?: FixtureOpenInput) {
  const store = await openSqliteWorkerStore<FixtureOperations>({
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath,
    input,
  });
  stores.add(store);
  return store;
}

function observePreparation(markerPath: string) {
  const started = createDeferredCore();
  const watcher = watch(path.dirname(markerPath), () => {
    if (existsSync(markerPath)) {
      started.resolve();
    }
  });
  watcher.once("error", started.reject);
  return { started: started.promise, close: () => watcher.close() };
}

it.each([
  { mib: 0, owner: "client" },
  { mib: 40, owner: "client" },
  { mib: 0, owner: "host" },
] as const)(
  "retains FIFO, cancellation, and $owner close while preparing a $mib MiB command",
  async ({ mib, owner }) => {
    const root = dirs.make("sqlite-worker-preparation-");
    const databasePath = path.join(root, "store.sqlite");
    const markerPath = path.join(root, "preparing");
    const gatePath = path.join(root, "release");
    const store = await open(databasePath, { type: "prepare", markerPath, gatePath });
    const observation = observePreparation(markerPath);
    const activeCancel = new AbortController();
    const queuedCancel = new AbortController();
    const value = mib ? "x".repeat(mib * 1024 * 1024) : "first";
    let settled = false;
    const active = store
      .execute({ type: "append", input: { value } }, { signal: activeCancel.signal })
      .then((receipt) => {
        settled = true;
        return receipt;
      });
    let canceled: Promise<unknown> | undefined;
    let following: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await Promise.race([
        observation.started,
        active.then(() => {
          throw new Error("Command executed before its code preparation");
        }),
      ]);
      expect(settled).toBe(false);
      canceled = store.execute(
        { type: "append", input: { value: "canceled" } },
        { signal: queuedCancel.signal },
      );
      const reason = new Error("Cancel the queued command");
      queuedCancel.abort(reason);
      await expect(canceled).rejects.toBe(reason);
      following = store.execute({ type: "append", input: { value: "second" } });
      activeCancel.abort(new Error("Dispatched preparation remains owned"));
      let closed = false;
      closing = (
        owner === "client" ? store.close() : drainGlobalSingletonLifecycleState("restart")
      ).then(() => {
        closed = true;
      });
      await expect(store.execute({ type: "read", input: undefined })).rejects.toMatchObject({
        code: "closed",
      });
      expect(closed).toBe(false);
      await writeFile(gatePath, "release preparation");
      expect(await active).toMatchObject({ writes: 1 });
      expect(await following).toMatchObject({ writes: 2 });
      await closing;
      expect(closed).toBe(true);
      const reopened = await open(databasePath);
      const digest = (text: string) => createHash("sha256").update(text).digest("hex");
      expect((await reopened.execute({ type: "read", input: undefined })).map(digest)).toEqual(
        [value, "second"].map(digest),
      );
    } finally {
      observation.close();
      queuedCancel.abort();
      await writeFile(gatePath, "release for cleanup");
      await Promise.allSettled([active, canceled, following, closing]);
    }
  },
);

it.each(["revoked", "rejected"] as const)(
  "preserves uncommitted state after %s preparation and permits the next command",
  async (failure) => {
    const root = dirs.make("sqlite-worker-preparation-authority-");
    const databasePath = path.join(root, "store.sqlite");
    const markerPath = path.join(root, "preparing");
    const gatePath = path.join(root, "release");
    const store = await open(databasePath, {
      type: "prepare",
      markerPath,
      gatePath,
      guarded: true,
      reject: failure === "rejected",
    });
    const observation = observePreparation(markerPath);
    let current = true;
    const refused = new Error("Authority revoked during code preparation");
    const operation = runSqliteWorkerStoreWrite(
      store,
      (scope) => scope.execute({ type: "append", input: { value: "must not commit" } }),
      () => {
        if (!current) {
          throw refused;
        }
      },
      [databasePath],
    );
    const outcome = Promise.allSettled([operation]);
    try {
      await Promise.race([
        observation.started,
        operation.then(() => {
          throw new Error("Command executed before its code preparation");
        }),
      ]);
      current = false;
      await writeFile(gatePath, "release preparation");
      const [result] = await outcome;
      expect(result).toMatchObject({
        status: "rejected",
        reason: {
          message: failure === "revoked" ? refused.message : "Fixture code preparation failed",
        },
      });
      expect(await store.execute({ type: "read", input: undefined })).toEqual([]);
      await store.close();
      const reopened = await open(databasePath);
      expect(await reopened.execute({ type: "read", input: undefined })).toEqual([]);
      expect(
        await reopened.execute({ type: "append", input: { value: "after refusal" } }),
      ).toMatchObject({ writes: 1 });
    } finally {
      observation.close();
      await writeFile(gatePath, "release for cleanup");
      await outcome;
    }
  },
);
