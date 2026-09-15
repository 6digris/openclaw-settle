import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingState,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
  SHORT_TERM_RECALL_NAMESPACE,
} from "./dreaming-state.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  holdMemoryAgentWriterForTest,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { recordShortTermRecalls } from "./short-term-promotion-record.js";
import type { ShortTermRecallEntry } from "./short-term-promotion-types.js";

describe("forget original storage binding", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  let replacement: string;
  beforeEach(async () => {
    fixture = await createMemoryForgetFixture("forget-storage-binding-");
    replacement = path.join(fixture.stateDir, "replacement-state");
    await fs.mkdir(replacement);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    for (const root of [fixture.stateDir, replacement]) {
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      await closeOpenClawStateDatabaseAsync();
    }
    await fixture.cleanup();
  });

  it("resolves selectors in the original store after waiting for the workspace lock", async () => {
    await seedMemoryForgetSession("original", "gmail");
    vi.stubEnv("OPENCLAW_STATE_DIR", replacement);
    await seedMemoryForgetSession("replacement", "gmail");
    vi.stubEnv("OPENCLAW_STATE_DIR", fixture.stateDir);
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const held = withMemoryWorkspaceLock(fixture.workspaceDir, async () => {
      entered.resolve();
      await resume.promise;
    });
    void held.catch(() => undefined);
    let forgetting: ReturnType<typeof forgetMemoryEntries> | undefined;
    try {
      await Promise.race([entered.promise, held]);
      forgetting = forgetMemoryEntries({
        cfg: fixture.cfg,
        agentId: "main",
        hookSources: ["gmail"],
      });
      void forgetting.catch(() => undefined);
      vi.stubEnv("OPENCLAW_STATE_DIR", replacement);
      resume.resolve();
      const report = await forgetting;
      expect(report.sessionIds).toEqual(["original"]);
    } finally {
      resume.resolve();
      await Promise.allSettled([held, ...(forgetting ? [forgetting] : [])]);
    }
  });

  it.each(["transcript", "workspace-state"] as const)(
    "keeps %s planning and cleanup on the original root after writer admission waits",
    async (source) => {
      // Match the production factory: each open respects its supplied environment,
      // rather than the normal fixture's test-wide environment override.
      configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
        createPluginStateKeyedStoreForTests<T>("memory-core", options),
      );
      await seedMemoryForgetSession("original");
      if (source === "transcript") {
        await appendSessionTranscriptMessageByIdentity({
          agentId: "main",
          sessionId: "original",
          sessionKey: "agent:main:original",
          message: {
            role: "assistant",
            timestamp: Date.now(),
            content: [
              {
                type: "toolCall",
                id: "original-write",
                name: "write",
                arguments: { path: "USER.md" },
              },
            ],
          },
        });
      } else {
        await recordShortTermRecalls({
          workspaceDir: fixture.workspaceDir,
          query: "violet",
          signalType: "daily",
          results: [
            {
              source: "memory",
              path: "memory/2026-09-15.md",
              startLine: 1,
              endLine: 1,
              score: 1,
              snippet: "The user prefers violet tea.",
              sessionOrigin: { agentId: "main", sessionId: "original" },
              provenance: {
                originClass: "owner",
                sessionKind: "interactive",
                observedAt: Date.now(),
              },
            },
          ],
        });
        const original = await readMemoryCoreWorkspaceEntries<ShortTermRecallEntry>({
          namespace: SHORT_TERM_RECALL_NAMESPACE,
          workspaceDir: fixture.workspaceDir,
        });
        expect(original).toHaveLength(1);
        vi.stubEnv("OPENCLAW_STATE_DIR", replacement);
        await writeMemoryCoreWorkspaceEntries({
          namespace: SHORT_TERM_RECALL_NAMESPACE,
          workspaceDir: fixture.workspaceDir,
          entries: original.map(({ key, value }) => ({
            key,
            value: { ...value, snippet: "Unrelated replacement state must survive." },
          })),
        });
        vi.stubEnv("OPENCLAW_STATE_DIR", fixture.stateDir);
      }
      const held = await holdMemoryAgentWriterForTest();
      const queued = createDeferred<void>();
      const admit = sqliteRuntime.withOpenClawAgentDatabaseWrite;
      vi.spyOn(sqliteRuntime, "withOpenClawAgentDatabaseWrite").mockImplementation((...args) => {
        const work = admit(...args);
        queued.resolve();
        return work;
      });
      const forgetting = forgetMemoryEntries({
        cfg: fixture.cfg,
        agentId: "main",
        sessionIds: ["original"],
      });
      void forgetting.catch(() => undefined);
      try {
        await Promise.race([queued.promise, forgetting]);
        vi.stubEnv("OPENCLAW_STATE_DIR", replacement);
        held.release();
        const report = await forgetting;
        if (source === "transcript") {
          expect(report.curatedWrites).toContainEqual({
            relativePath: "USER.md",
            observedAt: expect.any(Number),
          });
        } else {
          vi.stubEnv("OPENCLAW_STATE_DIR", fixture.stateDir);
          expect(
            await readMemoryCoreWorkspaceEntries({
              namespace: SHORT_TERM_RECALL_NAMESPACE,
              workspaceDir: fixture.workspaceDir,
            }),
          ).toEqual([]);
          vi.stubEnv("OPENCLAW_STATE_DIR", replacement);
          expect(
            await readMemoryCoreWorkspaceEntries<ShortTermRecallEntry>({
              namespace: SHORT_TERM_RECALL_NAMESPACE,
              workspaceDir: fixture.workspaceDir,
            }),
          ).toMatchObject([{ value: { snippet: "Unrelated replacement state must survive." } }]);
        }
      } finally {
        held.release();
        await Promise.allSettled([held.done, forgetting]);
      }
    },
  );
});
