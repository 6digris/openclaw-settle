import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import * as sqliteTransaction from "../../infra/sqlite-transaction.js";
import { withSqliteReclamationAuthorization } from "./session-accessor.sqlite-reclamation-commit.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function waitForWorkerProgress(progress: Int32Array, index = 0): void {
  const deadline = performance.now() + 5_000;
  while (Atomics.load(progress, index) === 0) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new Error("worker did not reach the coordinated transaction boundary");
    }
    Atomics.wait(progress, index, 0, remaining);
  }
}

function createCommitFixture(
  options: {
    holdAfterApproval?: boolean;
    reclaimPages?: boolean;
    outcome?: "rollback" | "exit-before-commit" | "exit-after-commit";
  } = {},
) {
  const directory = fs.realpathSync(tempDirs.make("openclaw-reclamation-commit-"));
  const databasePath = path.join(directory, "proof.sqlite");
  const database = openNodeSqliteDatabase(databasePath);
  if (options.reclaimPages) {
    database.exec("PRAGMA auto_vacuum=INCREMENTAL");
  }
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE proof(value INTEGER); INSERT INTO proof VALUES (1)",
  );
  if (options.reclaimPages) {
    database.exec(
      "CREATE TABLE payload(data BLOB); INSERT INTO payload VALUES (zeroblob(65536)); DELETE FROM payload",
    );
  }
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const progress = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
  const register = `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register();`;
  const worker = new Worker(
    new URL("./session-accessor.sqlite-reclamation-commit.test-support.ts", import.meta.url),
    {
      workerData: { databasePath, gate, progress: progress.buffer, ...options },
      execArgv: ["--import", `data:text/javascript,${encodeURIComponent(register)}`],
    },
  );
  const exited = once(worker, "exit");
  const requested = once(worker, "message");
  const release = () => {
    Atomics.store(progress, 1, 1);
    Atomics.notify(progress, 1);
    Atomics.store(progress, 2, 1);
    Atomics.notify(progress, 2);
  };
  return {
    database,
    databasePath,
    gate,
    progress,
    worker,
    exited,
    requested,
    release,
    value: () => database.prepare("SELECT value FROM proof").get()?.value,
    withAuthorization<T>(
      assertCurrent: () => void,
      run: (authorize: () => unknown[]) => Promise<T>,
    ) {
      return withSqliteReclamationAuthorization(gate, database, assertCurrent, run);
    },
    async close() {
      release();
      await exited;
      database.close();
    },
  };
}

test.each(["transient", "permanent", "closed"] as const)(
  "joins a consumed commit despite a %s barrier failure",
  async (fault) => {
    const fixture = createCommitFixture({ holdAfterApproval: true });
    const actualTransaction = sqliteTransaction.runSqliteImmediateTransactionSync;
    let faultInjected = false;
    try {
      await fixture.requested;
      vi.spyOn(sqliteTransaction, "runSqliteImmediateTransactionSync").mockImplementation(
        (db, operation, options) => {
          if (!faultInjected || fault !== "transient") {
            waitForWorkerProgress(fixture.progress);
            faultInjected = true;
            if (fault !== "transient") {
              fixture.release();
            }
            if (fault === "closed" && db.isOpen) {
              db.close();
            }
            throw new Error("injected non-busy barrier failure");
          }
          fixture.release();
          return actualTransaction(db, operation, options);
        },
      );
      const recovered = await fixture.withAuthorization(
        () => {},
        async (authorize) => authorize(),
      );
      expect(recovered.length).toBeGreaterThan(0);
      expect(
        recovered.every((error) => String(error).includes("injected non-busy barrier failure")),
      ).toBe(true);
      expect(fixture.value()).toBe(2);
    } finally {
      await fixture.close();
    }
  },
);

test("checkpoints reclaimed pages after the parent releases its settlement writer", async () => {
  const fixture = createCommitFixture({ reclaimPages: true });
  const actualTransaction = sqliteTransaction.runSqliteImmediateTransactionSync;
  let joinedSettlement = false;
  try {
    const freePages = () =>
      Number(fixture.database.prepare("PRAGMA freelist_count").get()?.freelist_count);
    const freePagesBefore = freePages();
    expect(freePagesBefore).toBeGreaterThan(0);
    await fixture.requested;
    const checkpointed = once(fixture.worker, "message");
    vi.spyOn(sqliteTransaction, "runSqliteImmediateTransactionSync").mockImplementation(
      (database, operation, options) => {
        if (options?.operationLabel !== "session.reclamation.commit-settlement") {
          return actualTransaction(database, operation, options);
        }
        return actualTransaction(
          database,
          () => {
            joinedSettlement = true;
            Atomics.store(fixture.progress, 2, 1);
            Atomics.notify(fixture.progress, 2);
            waitForWorkerProgress(fixture.progress, 3);
            return operation();
          },
          options,
        );
      },
    );
    await fixture.withAuthorization(
      () => {},
      async (authorize) => {
        expect(authorize()).toEqual([]);
        expect(await checkpointed).toEqual([
          expect.objectContaining({
            checkpointCompleted: true,
            checkpoint: expect.objectContaining({ state: "complete", walBytes: 0 }),
            checkpointCalls: 2,
            checkpointIncomplete: 0,
            vacuumPasses: 1,
          }),
        ]);
      },
    );
    expect(joinedSettlement).toBe(true);
    expect(freePages()).toBeLessThan(freePagesBefore);
    expect(fixture.value()).toBe(1);
  } finally {
    await fixture.close();
  }
});

test.each([
  { outcome: undefined, value: 2, exitCode: 0 },
  { outcome: "rollback" as const, value: 1, exitCode: 0 },
  { outcome: "exit-before-commit" as const, value: 1, exitCode: 7 },
  { outcome: "exit-after-commit" as const, value: 2, exitCode: 9 },
])(
  "joins Worker settlement before queued retirement ($outcome)",
  async ({ outcome, value, exitCode }) => {
    const fixture = createCommitFixture({ outcome });
    let retired = false;
    try {
      await fixture.requested;
      await fixture.withAuthorization(
        () => {
          queueMicrotask(() => {
            retired = true;
          });
        },
        async (authorize) => {
          authorize();
          expect(retired).toBe(false);
          expect(fixture.value()).toBe(value);
          expect(await fixture.exited).toEqual([exitCode]);
          expect(retired).toBe(true);
        },
      );
    } finally {
      await fixture.close();
    }
  },
);

test("rolls back when the live authority rejects the prepared deletion", async () => {
  const fixture = createCommitFixture();
  try {
    await fixture.requested;
    await fixture.withAuthorization(
      () => {
        throw new Error("retired owner");
      },
      async (authorize) => {
        expect(authorize).toThrow("retired owner");
      },
    );
    await fixture.exited;
    expect(fixture.value()).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("cannot revive a commit checkpoint after its decision deadline", async () => {
  const fixture = createCommitFixture();
  try {
    await fixture.requested;
    await fixture.exited;
    await fixture.withAuthorization(
      () => {},
      async (authorize) => {
        expect(authorize).toThrow("checkpoint expired");
      },
    );
    expect(fixture.value()).toBe(1);
  } finally {
    await fixture.close();
  }
}, 10_000);

test.each([false, true])(
  "preserves the authoritative outcome when barrier close fails (rejected: %s)",
  async (rejected) => {
    const fixture = createCommitFixture();
    const actualOpen = nodeSqlite.openNodeSqliteDatabase;
    try {
      await fixture.requested;
      vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementationOnce((...args) => {
        const database = actualOpen(...args);
        const actualClose = database.close.bind(database);
        vi.spyOn(database, "close").mockImplementationOnce(() => {
          actualClose();
          throw new Error("injected close failure");
        });
        return database;
      });
      await fixture.withAuthorization(
        () => {
          if (rejected) {
            throw new Error("retired owner");
          }
        },
        async (authorize) => {
          if (rejected) {
            expect(authorize).toThrow("retired owner");
          } else {
            expect(authorize().map(String)).toEqual(["Error: injected close failure"]);
          }
        },
      );
      await fixture.exited;
      expect(fixture.value()).toBe(rejected ? 1 : 2);
    } finally {
      await fixture.close();
    }
  },
);
