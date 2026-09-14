import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { beforeEach, expect, it, vi } from "vitest";
import { SqliteCoordinatorError } from "../infra/sqlite-coordinator.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import {
  getCronJobsStoreRevision,
  loadCronJobsStoreWithConfigJobs,
  noteCronJobsStoreCommit,
} from "./store.js";
import { restoreCronLoadError, serializeCronLoadError } from "./store/load-error.js";
import type { CronStoreWorkerOperations } from "./store/load-worker.types.js";

vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(runOpenClawStateWorkerOperation).mockReset();
});

it.each([
  { ok: true, repairCommits: 2 },
  { ok: false, repairCommits: 2 },
  { ok: false, repairCommits: 0 },
])(
  "publishes completed or uncertain load repairs before settling success=$ok count=$repairCommits",
  async ({ ok, repairCommits }) => {
    const storePath = `/synthetic/cron-repair-result-${ok}-${repairCommits}/jobs.json`;
    const result: CronStoreWorkerOperations["cron.loadMutable"]["output"] = ok
      ? {
          ok: true,
          repairCommits,
          loaded: {
            store: { version: 1, jobs: [] },
            configJobs: [],
            configJobIndexes: [],
            configJobRuntimeEntries: [],
            invalidConfigRows: [],
          },
        }
      : {
          ok: false,
          repairCommits,
          error: { name: "Error", message: "later load stage failed", code: "SQLITE_ERROR" },
        };
    vi.mocked(runOpenClawStateWorkerOperation).mockImplementation(async (_context, operation) =>
      operation({ execute: vi.fn().mockResolvedValue(result) }),
    );
    noteCronJobsStoreCommit(storePath);
    const before = getCronJobsStoreRevision(storePath);
    if (ok) {
      await expect(loadCronJobsStoreWithConfigJobs(storePath)).resolves.toHaveProperty(
        "store.jobs",
        [],
      );
    } else {
      await expect(loadCronJobsStoreWithConfigJobs(storePath)).rejects.toMatchObject({
        message: "later load stage failed",
        code: "SQLITE_ERROR",
      });
    }
    expect(getCronJobsStoreRevision(storePath)).toBe(before + Math.max(1, repairCommits));
  },
);

it("invalidates a cached load when transport cannot provide its repair result", async () => {
  const storePath = "/synthetic/cron-unavailable-result/jobs.json";
  const failure = new Error("worker result unavailable");
  vi.mocked(runOpenClawStateWorkerOperation).mockRejectedValue(failure);
  const before = getCronJobsStoreRevision(storePath);
  await expect(loadCronJobsStoreWithConfigJobs(storePath)).rejects.toBe(failure);
  expect(getCronJobsStoreRevision(storePath)).toBeGreaterThan(before);
});

it("preserves the coordinator cause used by Doctor diagnostics", () => {
  const native = Object.assign(new Error("database busy"), { code: "SQLITE_BUSY" });
  const original = new SqliteCoordinatorError("repair completed but cleanup failed", native);
  const restored = restoreCronLoadError(serializeCronLoadError(original));
  expect(restored.name).toBe(original.name);
  expect(restored.cause).toMatchObject({ message: "database busy", code: "SQLITE_BUSY" });
  expect(formatErrorMessage(restored, { redact: (text) => text })).toBe(
    formatErrorMessage(original, { redact: (text) => text }),
  );
});
