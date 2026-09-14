import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { WorkerTaskPool } from "./worker-task-pool.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";

const cleanup = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock("./temp-artifact-cleanup.js", () => ({ removeTemporaryArtifacts: cleanup }));

const workerUrl = new URL("./worker-task-pool.test-support.ts", import.meta.url);

describe("worker task artifact lifetime", () => {
  it.each([
    { phase: "idle", observer: "returns" },
    { phase: "unconsumed-result", observer: "throws" },
    { phase: "unconsumed-result", observer: "rejects" },
  ] as const)(
    "retries failed $phase retirement with an observer that $observer on the same mocked worker",
    async ({ phase, observer }) => {
      const failure = new Error("mock termination did not complete");
      const terminate = vi
        .fn<() => Promise<number>>()
        .mockRejectedValueOnce(failure)
        .mockResolvedValue(0);
      const delivered = createDeferredCore();
      let created = 0;
      class MockWorker extends EventEmitter {
        constructor() {
          super();
          created += 1;
        }
        ref() {}
        unref() {}
        terminate = terminate;
        postMessage(message: { taskId: number }) {
          queueMicrotask(() => {
            this.emit("message", { status: "ok", taskId: message.taskId, value: 42 });
            delivered.resolve();
          });
        }
      }
      vi.doMock("node:worker_threads", async (importOriginal) => ({
        ...(await importOriginal<typeof import("node:worker_threads")>()),
        Worker: MockWorker,
      }));
      vi.resetModules();
      cleanup.mockReset();
      let artifactsCleaned = false;
      cleanup.mockImplementation(async () => {
        await Promise.resolve();
        artifactsCleaned = true;
      });
      const { WorkerTaskPool: MockedWorkerTaskPool } = await import("./worker-task-pool.js");
      const consumed = vi.fn();
      const observedCustody: number[][] = [];
      const onRetirementFailure = vi.fn((_error: unknown) => {
        observedCustody.push([consumed.mock.calls.length, cleanup.mock.calls.length]);
        if (observer === "throws") {
          throw new Error("observer failed synchronously");
        }
        if (observer === "rejects") {
          return Promise.reject(new Error("observer failed asynchronously"));
        }
        return undefined;
      });
      const pool = new MockedWorkerTaskPool<number, number>({
        workerUrl: new URL("file:///fixture/worker.js"),
        maxWorkers: 1,
        onRetirementFailure,
        prepareWorker: () => ({ options: {}, temporaryDirectory: "/fixture/worker-scratch" }),
      });
      try {
        const task = pool.run(1, phase === "idle" ? {} : { onInputConsumed: consumed });
        let taskSettled = false;
        void task.then(
          () => {
            taskSettled = true;
          },
          () => {
            taskSettled = true;
          },
        );
        await delivered.promise;
        if (phase === "idle") {
          await expect(task).resolves.toBe(42);
        }
        expect(await Promise.allSettled([pool.close(), pool.close()])).toEqual([
          { status: "rejected", reason: failure },
          { status: "rejected", reason: failure },
        ]);
        expect(terminate).toHaveBeenCalledTimes(1);
        expect(onRetirementFailure).toHaveBeenCalledExactlyOnceWith(failure);
        expect(observedCustody).toEqual([[0, 0]]);
        expect(created).toBe(1);
        expect(cleanup).not.toHaveBeenCalled();
        expect(taskSettled).toBe(phase === "idle");
        expect(consumed).not.toHaveBeenCalled();

        await Promise.all([pool.close(), pool.close()]);
        await expect(task).resolves.toBe(42);
        expect(terminate).toHaveBeenCalledTimes(2);
        expect(onRetirementFailure).toHaveBeenCalledTimes(1);
        expect(created).toBe(1);
        expect(cleanup).toHaveBeenCalledExactlyOnceWith("/fixture/worker-scratch", "Worker task");
        expect(artifactsCleaned).toBe(true);
        expect(consumed).toHaveBeenCalledTimes(phase === "idle" ? 0 : 1);
      } finally {
        await pool.close().catch(() => undefined);
        cleanup.mockReset();
        vi.doUnmock("node:worker_threads");
        vi.resetModules();
      }
    },
  );

  it("releases stopped execution before disposal while every close joins pending cleanup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-cleanup-owner-"));
    const gate = createDeferredCore();
    const entered = createDeferredCore();
    const context = new AsyncLocalStorage<string>();
    let cleanupContext: string | undefined;
    cleanup
      .mockImplementationOnce(() => {
        cleanupContext = context.getStore();
        entered.resolve();
        return gate.promise;
      })
      .mockResolvedValue(undefined);
    const roots: string[] = [];
    const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
      workerUrl,
      maxWorkers: 1,
      maxPendingTasks: 1,
      prepareWorker: () => {
        const owned = fs.mkdtempSync(path.join(directory, "generation-"));
        roots.push(owned);
        return { options: {}, temporaryDirectory: owned };
      },
    });
    try {
      const controller = new AbortController();
      const counters = new SharedArrayBuffer(8);
      const active = context.run("request", () =>
        pool.run({ label: "held", counters, wait: true }, { signal: controller.signal }),
      );
      let taskSettled = false;
      void active
        .finally(() => {
          taskSettled = true;
        })
        .catch(() => {});
      await expect.poll(() => Atomics.load(new Int32Array(counters), 0)).toBe(1);
      context.run("request", () => controller.abort(new Error("canceled owner")));
      await entered.promise;
      expect(cleanupContext).toBeUndefined();
      await expect.poll(() => taskSettled).toBe(true);
      await expect(active).rejects.toThrow("canceled owner");
      await expect(pool.run({ label: "replacement" }, {})).resolves.toMatchObject({
        label: "replacement",
      });
      expect(new Set(roots).size).toBe(2);
      let closed = false;
      const closing = Promise.all([pool.close(), pool.close()]).then(() => {
        closed = true;
      });
      await expect.poll(() => cleanup.mock.calls.length).toBe(2);
      expect(closed).toBe(false);
      gate.resolve();
      await closing;
      expect(closed).toBe(true);
    } finally {
      gate.resolve();
      await pool.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
