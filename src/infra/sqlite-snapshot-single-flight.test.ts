import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { prepareSingleFlightSqliteSnapshot } from "./sqlite-snapshot-single-flight.js";

it("tracks the producer after a caller cancels its wait", async () => {
  const produced = createDeferred();
  const tracked: Promise<unknown>[] = [];
  const controller = new AbortController();
  const pending = prepareSingleFlightSqliteSnapshot(
    "producer-drain.sqlite",
    "test",
    async () => {
      await produced.promise;
      return {
        location: "snapshot.sqlite",
        cleanup: () => true,
        cleanupAsync: async () => true,
      };
    },
    controller.signal,
    { trackProducer: (producer) => tracked.push(producer) },
  );

  controller.abort(new Error("caller stopped waiting"));
  await expect(pending).rejects.toThrow("caller stopped waiting");
  expect(tracked).toHaveLength(1);
  let producerSettled = false;
  void tracked[0]?.then(() => {
    producerSettled = true;
  });
  await Promise.resolve();
  expect(producerSettled).toBe(false);
  produced.resolve();
  await expect(tracked[0]).resolves.toMatchObject({ location: "snapshot.sqlite" });
});

it("joins orphan cleanup before the tracked producer settles", async () => {
  const produced = createDeferred();
  const cleanupStarted = createDeferred();
  const cleanupFinished = createDeferred();
  const tracked: Promise<unknown>[] = [];
  const controller = new AbortController();
  const pending = prepareSingleFlightSqliteSnapshot(
    "orphan-drain.sqlite",
    "test",
    async () => {
      await produced.promise;
      return {
        location: "orphan-snapshot.sqlite",
        cleanup: () => true,
        cleanupAsync: async () => {
          cleanupStarted.resolve();
          await cleanupFinished.promise;
          return true;
        },
      };
    },
    controller.signal,
    { trackProducer: (producer) => tracked.push(producer) },
  );
  controller.abort(new Error("caller cancelled"));
  await expect(pending).rejects.toThrow("caller cancelled");
  let settled = false;
  void tracked[0]?.then(() => {
    settled = true;
  });
  produced.resolve();
  await cleanupStarted.promise;
  await Promise.resolve();
  await Promise.resolve();
  const settledBeforeCleanup = settled;
  cleanupFinished.resolve();
  await tracked[0];
  expect(settledBeforeCleanup).toBe(false);
});

it("retains the snapshot until a signalled joined waiter acquires its lease", async () => {
  const produced = createDeferred();
  let exists = true;
  let copies = 0;
  const producer = async () => {
    copies += 1;
    await produced.promise;
    return {
      location: "joined-snapshot.sqlite",
      cleanup: () => {
        exists = false;
        return true;
      },
      cleanupAsync: async () => {
        exists = false;
        return true;
      },
    };
  };
  const first = prepareSingleFlightSqliteSnapshot("joined-source.sqlite", "test", producer);
  await Promise.resolve();
  await Promise.resolve();
  const second = prepareSingleFlightSqliteSnapshot(
    "joined-source.sqlite",
    "test",
    producer,
    new AbortController().signal,
  );
  const firstCleanup = first.then((snapshot) => snapshot.cleanup());
  produced.resolve();
  const snapshot = await second;
  try {
    expect(await firstCleanup).toBe(true);
    expect(copies).toBe(1);
    expect(exists).toBe(true);
  } finally {
    await snapshot.cleanupAsync();
  }
  expect(exists).toBe(false);
});

it("cancels queued snapshot allocation when its only waiter aborts", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled before snapshot allocation");
  let allocated = false;
  const pending = prepareSingleFlightSqliteSnapshot(
    "cancelled-queued-source.sqlite",
    "test",
    async (signal) => {
      signal.throwIfAborted();
      allocated = true;
      return {
        location: "unused-snapshot.sqlite",
        cleanup: () => true,
        cleanupAsync: async () => true,
      };
    },
    controller.signal,
  );
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(allocated).toBe(false);
});

it("keeps queued production for a surviving waiter after the first aborts", async () => {
  const controller = new AbortController();
  const reason = new Error("first waiter stopped");
  const produced = createDeferred();
  const entered = createDeferred();
  let cleaned = false;
  const producer = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    entered.resolve();
    await produced.promise;
    signal.throwIfAborted();
    return {
      location: "surviving-snapshot.sqlite",
      cleanup: () => true,
      cleanupAsync: async () => {
        cleaned = true;
        return true;
      },
    };
  };
  const first = prepareSingleFlightSqliteSnapshot(
    "surviving-queued-source.sqlite",
    "test",
    producer,
    controller.signal,
  );
  const second = prepareSingleFlightSqliteSnapshot(
    "surviving-queued-source.sqlite",
    "test",
    producer,
  );
  controller.abort(reason);
  try {
    await expect(first).rejects.toBe(reason);
    await entered.promise;
    expect(cleaned).toBe(false);
  } finally {
    produced.resolve();
    const snapshot = await second;
    expect(snapshot.location).toBe("surviving-snapshot.sqlite");
    expect(await snapshot.cleanupAsync()).toBe(true);
  }
  expect(cleaned).toBe(true);
});
