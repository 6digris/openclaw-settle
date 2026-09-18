import * as childProcess from "node:child_process";
import { once } from "node:events";
import { withTestSpawnBroker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runVectorKnnInSubprocess } from "./manager-search-knn-subprocess.js";
import type { VectorKnnRequest } from "./manager-search-knn.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  return {
    ...actual,
    resolveRuntimeWorkerUrl: (params: Parameters<typeof actual.resolveRuntimeWorkerUrl>[0]) =>
      params.sourceWorkerName === "manager-search-knn.child"
        ? new URL("./fixtures/manager-search-knn-child.fixture.mjs", import.meta.url)
        : actual.resolveRuntimeWorkerUrl(params),
  };
});

const request: VectorKnnRequest = {
  vectorTable: "memory_index_chunks_vec",
  providerModels: ["test-model"],
  queryVec: [1, 0],
  limit: 1,
  snippetMaxChars: 700,
  sourceFilter: { sql: "", params: [] },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "memory vector KNN broker transport",
  () => {
    it("reaps a query canceled before its broker pipes arrive", async () => {
      await withTestSpawnBroker(async ({ broker: host }) => {
        const spawn = host.spawn.bind(host);
        const controller = new AbortController();
        let closed: Promise<unknown[]> | undefined;
        vi.spyOn(host, "spawn").mockImplementationOnce((...args) => {
          const child = spawn(...args);
          closed = once(child, "close");
          controller.abort(new Error("KNN canceled before readiness"));
          return child;
        });
        vi.mocked(childProcess.spawn).mockClear();

        await expect(
          runVectorKnnInSubprocess({
            databasePath: "fixture:ok",
            request: { ...request, limit: 30_000 },
            signal: controller.signal,
          }),
        ).rejects.toThrow("KNN canceled before readiness");
        expect(closed).toBeDefined();
        expect(await closed).toEqual([null, "SIGKILL"]);
        await expect(
          runVectorKnnInSubprocess({ databasePath: "fixture:ok", request }),
        ).resolves.toEqual({ rows: [], fallbackScanRequired: false });
        expect(childProcess.spawn).not.toHaveBeenCalled();
      });
    });

    it("runs queries under the broker with isolated env, diagnostics, and hard cancellation", async () => {
      await withTestSpawnBroker(async ({ broker: host, pid }) => {
        const spawn = host.spawn.bind(host);
        const brokerSpawn = vi.spyOn(host, "spawn");
        vi.mocked(childProcess.spawn).mockClear();
        vi.stubEnv("TMPDIR", "/synthetic/knn-temp");
        vi.stubEnv("SYNTHETIC_KNN_SECRET", "must-not-enter-query-child");
        const result = await runVectorKnnInSubprocess({
          databasePath: "fixture:process-context",
          request,
        });
        expect(result).toEqual({
          rows: [
            {
              id: "process-context",
              path: "memory/process-context.md",
              start_line: 1,
              end_line: 1,
              text: JSON.stringify({
                parent: pid,
                cwd: process.cwd(),
                temp: "/synthetic/knn-temp",
              }),
              source: "memory",
              dist: 0,
            },
          ],
          fallbackScanRequired: false,
        });
        expect(brokerSpawn).toHaveBeenCalledOnce();
        expect(childProcess.spawn).not.toHaveBeenCalled();

        await expect(
          runVectorKnnInSubprocess({
            databasePath: "fixture:early-exit",
            request,
          }),
        ).rejects.toThrow(
          "exited before returning a result (code 7, signal none): fixture KNN failure",
        );

        const controller = new AbortController();
        const started = new Promise<void>((resolve, reject) => {
          brokerSpawn.mockImplementationOnce((...args) => {
            const child = spawn(...args);
            child.once("error", reject);
            child.once("spawn", () => {
              if (!child.stderr) {
                reject(new Error("KNN query child has no stderr pipe"));
                return;
              }
              child.stderr.once("data", () => resolve());
            });
            return child;
          });
        });
        const query = runVectorKnnInSubprocess({
          databasePath: "fixture:ok",
          request: { ...request, limit: 30_000 },
          signal: controller.signal,
        });
        const rejected = expect(query).rejects.toThrow("broker KNN deadline");
        try {
          await started;
          expect(brokerSpawn).toHaveBeenCalledTimes(3);
          const child = brokerSpawn.mock.results[2]!.value;
          const closed = once(child, "close");
          controller.abort(new Error("broker KNN deadline"));
          await rejected;
          expect(await closed).toEqual([null, "SIGKILL"]);
        } finally {
          controller.abort(new Error("broker KNN deadline"));
          await rejected;
        }
        await expect(
          runVectorKnnInSubprocess({
            databasePath: "fixture:ok",
            request,
          }),
        ).resolves.toEqual({ rows: [], fallbackScanRequired: false });
        expect(brokerSpawn).toHaveBeenCalledTimes(4);
        expect(childProcess.spawn).not.toHaveBeenCalled();
      });
    });
  },
);
