import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as memoryStorage from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as origins from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  holdMemoryAgentWriterForTest,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";

describe("memory forget admission", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  beforeEach(async () => {
    fixture = await createMemoryForgetFixture("openclaw-memory-forget-admission-");
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  it.each(["reserved", "closed", "replaced"] as const)(
    "queues forget mutations after vector preparation behind the agent writer reservation (%s)",
    async (mode) => {
      await seedMemoryForgetSession("target");
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      expect((await memoryStorage.loadSqliteVecExtension({ db })).ok).toBe(true);
      db.exec(`CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
      id TEXT PRIMARY KEY, embedding FLOAT[2]
    )`);
      db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES ('target-chunk', 'sessions/main/target.jsonl', 'sessions', 1, 1,
        'target-hash', 'test', 'Target memory', '[1,0]', 1)`).run();
      db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
        "target-chunk",
        new Float32Array([1, 0]),
      );
      const prepared = createDeferred<void>();
      const resume = createDeferred<void>();
      const load = memoryStorage.loadSqliteVecExtension;
      let reachedBorrowedHandle = false;
      const loadSpy = vi
        .spyOn(memoryStorage, "loadSqliteVecExtension")
        .mockImplementation(async (options) => {
          const result = await load(options);
          if (options.db === db) {
            reachedBorrowedHandle = true;
            prepared.resolve();
            await resume.promise;
          }
          return result;
        });
      const work = forgetMemoryEntries({
        cfg: fixture.cfg,
        agentId: "main",
        sessionIds: ["target"],
      });
      void work.catch(() => undefined);
      let held: Awaited<ReturnType<typeof holdMemoryAgentWriterForTest>> | undefined;
      try {
        await Promise.race([prepared.promise, work]);
        expect(reachedBorrowedHandle).toBe(true);
        held = await holdMemoryAgentWriterForTest();
        if (mode !== "reserved") {
          closeOpenClawAgentDatabasesForTest();
          if (mode === "replaced") {
            openOpenClawAgentDatabase({ agentId: "main" });
          }
        }
        resume.resolve();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(origins.listMemorySessionTombstones({ agentId: "main" })).toEqual([]);
        if (mode === "reserved") {
          expect(db.prepare("SELECT id FROM memory_index_chunks").all()).toEqual([
            { id: "target-chunk" },
          ]);
        }
      } finally {
        resume.resolve();
        held?.release();
        await Promise.allSettled([work, ...(held ? [held.done] : [])]);
        loadSpy.mockRestore();
      }
      if (mode === "reserved") {
        await work;
        expect(origins.listMemorySessionTombstones({ agentId: "main" })).toMatchObject([
          { sessionId: "target" },
        ]);
        expect(db.prepare("SELECT id FROM memory_index_chunks").all()).toEqual([]);
      } else {
        await expect(work).rejects.toThrow("Borrowed agent database closed or changed");
        expect(origins.listMemorySessionTombstones({ agentId: "main" })).toEqual([]);
      }
    },
  );
  it.each(["ready", "failed"] as const)(
    "retains one durable tombstone when a late vector index needs preparation (%s)",
    async (preparation) => {
      await seedMemoryForgetSession("target");
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      expect((await memoryStorage.loadSqliteVecExtension({ db })).ok).toBe(true);
      const revision = () =>
        db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()?.revision;
      const before = Number(revision());
      const record = origins.recordMemorySessionTombstonesInDatabase;
      const recordSpy = vi
        .spyOn(origins, "recordMemorySessionTombstonesInDatabase")
        .mockImplementationOnce((...args) => {
          const count = record(...args);
          // A separate publisher can commit after the durable tombstone and
          // before the purge transaction acquires its native writer lock.
          db.exec(`CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
            id TEXT PRIMARY KEY, embedding FLOAT[2]
          )`);
          db.prepare(`INSERT INTO memory_index_chunks
            (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
            VALUES ('late-chunk', 'sessions/main/target.jsonl', 'sessions', 1, 1,
              'late-hash', 'test', 'Late target memory', '[1,0]', 1)`).run();
          db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
            "late-chunk",
            new Float32Array([1, 0]),
          );
          return count;
        });
      const load = memoryStorage.loadSqliteVecExtension;
      const loadSpy = vi
        .spyOn(memoryStorage, "loadSqliteVecExtension")
        .mockImplementation(async (options) =>
          preparation === "failed"
            ? { ok: false, error: "synthetic vector preparation failure" }
            : await load(options),
        );
      try {
        const work = forgetMemoryEntries({
          cfg: fixture.cfg,
          agentId: "main",
          sessionIds: ["target"],
        });
        if (preparation === "failed") {
          await expect(work).rejects.toThrow("synthetic vector preparation failure");
        } else {
          expect((await work).artifacts).toMatchObject({ indexChunks: 1, vectorRows: 1 });
        }
        expect(origins.listMemorySessionTombstones({ agentId: "main" })).toMatchObject([
          { sessionId: "target" },
        ]);
        // Tombstone and chunk insertion advance the revision; successful
        // chunk deletion advances it once more, with no repeated forget bump.
        expect(revision()).toBe(before + (preparation === "failed" ? 2 : 3));
        const remaining = preparation === "failed" ? [{ id: "late-chunk" }] : [];
        expect(db.prepare("SELECT id FROM memory_index_chunks").all()).toEqual(remaining);
        expect(db.prepare("SELECT id FROM memory_index_chunks_vec").all()).toEqual(remaining);
      } finally {
        loadSpy.mockRestore();
        recordSpy.mockRestore();
      }
    },
  );
});
