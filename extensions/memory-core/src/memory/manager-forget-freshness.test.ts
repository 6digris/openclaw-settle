import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as origins from "../memory-entry-origins.js";
import { forgetMemoryEntries } from "../memory-forget.js";
import { holdMemoryAgentWriterForTest } from "../memory-forget.test-helpers.js";
import * as publication from "./manager-db.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("forget after another workspace publishes", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());

  it("purges a selected session published ahead of its first writer admission", async () => {
    const sessionId = "forget-freshness";
    const sessionKey = `agent:main:memory:${sessionId}`;
    const sessionPath = `sessions/main/${sessionId}.jsonl`;
    await fixture.seedSessionTranscript({
      sessionId,
      sessionKey,
      messages: [
        { role: "user", content: "Original violet memory.", timestamp: 1, senderIsOwner: true },
      ],
    });
    const cfg = fixture.createConfig({
      provider: "none",
      sources: ["sessions"],
      sessionMemory: true,
      vectorEnabled: false,
    });
    const initial = await fixture.getFreshManager(cfg, "cli");
    await initial.sync({ reason: "baseline", force: true });
    const database = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    const oldRows = database.db
      .prepare("SELECT id FROM memory_index_chunks WHERE path = ?")
      .all(sessionPath);
    expect(oldRows.length).toBeGreaterThan(0);
    await initial.close();
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId,
      sessionKey,
      message: {
        role: "user",
        content: [
          {
            type: "text",
            text: Array.from(
              { length: 120 },
              (_, index) => `New violet detail ${index} published during forget.`,
            ).join("\n"),
          },
        ],
        timestamp: 2,
        __openclaw: { senderIsOwner: true },
      },
    });
    const otherWorkspace = path.join(fixture.paths.root, "other-workspace");
    await fs.mkdir(otherWorkspace);
    const otherConfig = {
      ...cfg,
      agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, workspace: otherWorkspace } },
    };
    const other = await fixture.getFreshManager(otherConfig, "cli");
    expect(other.status().dbPath).toBe(database.path);

    const prepared = createDeferred<void>();
    const allowPublication = createDeferred<void>();
    const publisherQueued = createDeferred<void>();
    const forgetQueued = createDeferred<void>();
    const events: string[] = [];
    let publishedChunks = 0;
    const prepare = publication.prepareMemoryDatabasePublication;
    vi.spyOn(publication, "prepareMemoryDatabasePublication").mockImplementation(
      async (options) => {
        const commit = await prepare(options);
        prepared.resolve();
        await allowPublication.promise;
        return () => {
          commit();
          publishedChunks = database.db
            .prepare("SELECT id FROM memory_index_chunks WHERE path = ?")
            .all(sessionPath).length;
          events.push("published");
        };
      },
    );
    const tombstone = origins.recordMemorySessionTombstonesInDatabase;
    vi.spyOn(origins, "recordMemorySessionTombstonesInDatabase").mockImplementation(
      (db, params) => {
        const count = tombstone(db, params);
        events.push("tombstoned");
        return count;
      },
    );
    const sync = other.sync({ reason: "publish-other-workspace", force: true });
    void sync.catch(() => undefined);
    let held: Awaited<ReturnType<typeof holdMemoryAgentWriterForTest>> | undefined;
    let forgetting: ReturnType<typeof forgetMemoryEntries> | undefined;
    try {
      await Promise.race([prepared.promise, sync]);
      held = await holdMemoryAgentWriterForTest();
      let observeForget = false;
      const admit = sqliteRuntime.withOpenClawAgentDatabaseWrite;
      vi.spyOn(sqliteRuntime, "withOpenClawAgentDatabaseWrite").mockImplementation((...args) => {
        const work = admit(...args);
        if (args[2] === database.db && !observeForget) {
          publisherQueued.resolve();
        } else if (!args[2] && observeForget) {
          forgetQueued.resolve();
        }
        return work;
      });
      allowPublication.resolve();
      await Promise.race([publisherQueued.promise, sync]);
      observeForget = true;
      forgetting = forgetMemoryEntries({ cfg, agentId: "main", sessionIds: [sessionId] });
      void forgetting.catch(() => undefined);
      await Promise.race([forgetQueued.promise, forgetting]);
      expect(
        database.db.prepare("SELECT id FROM memory_index_chunks WHERE path = ?").all(sessionPath),
      ).toEqual(oldRows);
      held.release();
      const results = await Promise.all([held.done, sync, forgetting]);
      expect(publishedChunks).toBeGreaterThan(oldRows.length);
      expect(results[2].artifacts).toMatchObject({
        indexChunks: publishedChunks,
        indexSources: 1,
        ftsRows: publishedChunks,
      });
      expect(events).toEqual(["published", "tombstoned"]);
      expect(origins.listMemorySessionTombstones({ agentId: "main" })).toMatchObject([
        { sessionId },
      ]);
      expect(
        database.db
          .prepare("SELECT id, text FROM memory_index_chunks WHERE path = ?")
          .all(sessionPath),
      ).toEqual([]);
    } finally {
      allowPublication.resolve();
      held?.release();
      await Promise.allSettled([
        sync,
        ...(forgetting ? [forgetting] : []),
        ...(held ? [held.done] : []),
      ]);
    }
  });
});
