import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as storage from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as origins from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  holdMemoryAgentWriterForTest,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";

describe("forget lineage freshness", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  beforeEach(async () => {
    fixture = await createMemoryForgetFixture("forget-lineage-freshness-");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.cleanup();
  });

  it.each(["queued", "planning", "purge"] as const)(
    "includes selected lineage committed during %s preparation",
    async (timing) => {
      await seedMemoryForgetSession("target");
      const content =
        "<!-- openclaw-memory-promotion:late-lineage -->\n- Violet fixture detail to remove.\n";
      const memoryPath = path.join(fixture.workspaceDir, "MEMORY.md");
      await fs.writeFile(memoryPath, content);
      const db = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" }).db;
      db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES ('late-lineage-chunk', 'MEMORY.md', 'memory', 1, 2, 'fixture', 'test', ?, '[]', 1)`).run(
        content,
      );
      const revisionBefore = Number(
        db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()?.revision,
      );
      if (timing === "purge") {
        origins.recordMemoryEntryOrigins({
          agentId: "main",
          origins: [
            {
              entryKey: "unrelated",
              agentId: "main",
              sessionId: "survivor",
              sessionKey: null,
              originClass: "owner",
              observedAt: 1,
            },
          ],
        });
        const recordTombstones = origins.recordMemorySessionTombstonesInDatabase;
        vi.spyOn(origins, "recordMemorySessionTombstonesInDatabase").mockImplementationOnce(
          (...args) => {
            const recorded = recordTombstones(...args);
            // Simulate a separate connection committing lineage after the durable
            // tombstone and before the purge takes its native transaction lock.
            db.prepare(`INSERT INTO memory_entry_origins
            (entry_key, agent_id, session_id, session_key, origin_class, observed_at)
            VALUES ('late-lineage', 'main', 'target', NULL, 'owner', 1)`).run();
            return recorded;
          },
        );
      }
      const prepared = createDeferred<void>();
      const resume = createDeferred<void>();
      const queued = createDeferred<void>();
      const admit = sqliteRuntime.withOpenClawAgentDatabaseWrite;
      let calls = 0;
      vi.spyOn(sqliteRuntime, "withOpenClawAgentDatabaseWrite").mockImplementation((...args) => {
        const work = admit(...args);
        if (++calls === 2) {
          queued.resolve();
        }
        return work;
      });
      const list = storage.listMemoryFiles;
      if (timing === "planning") {
        vi.spyOn(storage, "listMemoryFiles").mockImplementation(async (...args) => {
          const files = await list(...args);
          prepared.resolve();
          await resume.promise;
          return files;
        });
      }
      let held: Awaited<ReturnType<typeof holdMemoryAgentWriterForTest>> | undefined;
      let predecessor: Promise<unknown> | undefined;
      let forgetting: ReturnType<typeof forgetMemoryEntries> | undefined;
      const record = () =>
        origins.recordMemoryEntryOrigins({
          agentId: "main",
          origins: [
            {
              entryKey: "late-lineage",
              agentId: "main",
              sessionId: "target",
              sessionKey: null,
              originClass: "owner",
              observedAt: 1,
            },
          ],
        });
      try {
        if (timing === "queued") {
          held = await holdMemoryAgentWriterForTest();
          predecessor = sqliteRuntime.withOpenClawAgentDatabaseWrite({ agentId: "main" }, record);
          void predecessor.catch(() => undefined);
        }
        forgetting = forgetMemoryEntries({
          cfg: fixture.cfg,
          agentId: "main",
          sessionIds: ["target"],
        });
        void forgetting.catch(() => undefined);
        if (timing === "queued") {
          await Promise.race([queued.promise, forgetting]);
          held?.release();
        } else if (timing === "planning") {
          await Promise.race([prepared.promise, forgetting]);
          record();
          resume.resolve();
        }
        const report = await forgetting;
        await predecessor;
        expect(origins.listMemorySessionTombstones({ agentId: "main" })).toMatchObject([
          { sessionId: "target" },
        ]);
        expect(report.entryKeys).toEqual(["late-lineage"]);
        expect(await fs.readFile(memoryPath, "utf8")).not.toContain("Violet fixture");
        expect(db.prepare("SELECT id FROM memory_index_chunks").all()).toEqual([]);
        // One tombstone revision plus deletion of the seeded index chunk.
        expect(
          db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()?.revision,
        ).toBe(revisionBefore + 2);
      } finally {
        resume.resolve();
        held?.release();
        await Promise.allSettled([
          ...(held ? [held.done] : []),
          ...(predecessor ? [predecessor] : []),
          ...(forgetting ? [forgetting] : []),
        ]);
      }
    },
  );
});
