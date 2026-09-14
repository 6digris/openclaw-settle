import { DatabaseSync, StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getCronJobsStoreRevision,
  loadCronJobsStoreWithConfigJobs,
  saveCronJobsStore,
} from "./store.js";
import type { CronStoreFile } from "./types.js";

it("loads complete partitioned cron state off the host and preserves it through reopen", async () => {
  await withOpenClawTestState({ label: "cron-worker-load" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const otherStorePath = state.statePath("other", "jobs.json");
    const store: CronStoreFile = {
      version: 1,
      jobs: ["first", "second"].map((id) => ({
        id,
        name: id,
        enabled: true,
        createdAtMs: 1,
        updatedAtMs: 2,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "scheduled café 🦞" },
        state: { nextRunAtMs: 60_001 },
      })),
    };
    await saveCronJobsStore(storePath, store);
    await saveCronJobsStore(otherStorePath, { version: 1, jobs: [] });
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    await closeOpenClawStateDatabaseByPathAsync(databasePath);
    const revision = getCronJobsStoreRevision(storePath);
    const spies = [
      vi.spyOn(DatabaseSync.prototype, "prepare"),
      vi.spyOn(DatabaseSync.prototype, "exec"),
      vi.spyOn(StatementSync.prototype, "get"),
      vi.spyOn(StatementSync.prototype, "all"),
      vi.spyOn(StatementSync.prototype, "run"),
      vi.spyOn(StatementSync.prototype, "iterate"),
    ];
    try {
      const loaded = await loadCronJobsStoreWithConfigJobs(storePath);
      expect(loaded.store.jobs.map((job) => job.id)).toEqual(["first", "second"]);
      expect(loaded.store.jobs[0]).toMatchObject(
        expectDefined(store.jobs[0], "first seeded cron job"),
      );
      expect(loaded.configJobs).toHaveLength(2);
      expect(loaded.configJobIndexes).toEqual([0, 1]);
      expect(loaded.configJobRuntimeEntries[0]?.state).toMatchObject({ nextRunAtMs: 60_001 });
      expect(loaded.jobsFingerprint).toEqual(expect.any(String));
      expect(loaded.invalidConfigRows).toEqual([]);
      expect((await loadCronJobsStoreWithConfigJobs(otherStorePath)).store.jobs).toEqual([]);
      expect(getCronJobsStoreRevision(storePath)).toBe(revision);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      for (const job of store.jobs) {
        job.name = `updated ${job.id}`;
      }
      await saveCronJobsStore(storePath, store);
      for (const spy of spies) {
        spy.mockClear();
      }
      const updated = await loadCronJobsStoreWithConfigJobs(storePath);
      expect(updated.store.jobs.map((job) => job.name)).toEqual([
        "updated first",
        "updated second",
      ]);
      expect(updated.jobsFingerprint).not.toBe(loaded.jobsFingerprint);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
      // The retained synchronous writer owns its close-time WAL maintenance.
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      for (const spy of spies) {
        spy.mockClear();
      }
      expect(await loadCronJobsStoreWithConfigJobs(storePath)).toEqual(updated);
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });
});
