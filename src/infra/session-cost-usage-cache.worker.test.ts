import fs from "node:fs/promises";
import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import {
  readSessionCostUsageRollupRows,
  writeSessionCostUsageRollup,
} from "./session-cost-usage-cache.sqlite.js";
import { loadSessionCostSummariesFromCache } from "./session-cost-usage.js";

it("loads fresh session usage without executing cache reads on the caller", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const agentId = "usage-worker";
    const sessionFile = state.path("usage.jsonl");
    await fs.writeFile(
      sessionFile,
      JSON.stringify({
        type: "message",
        timestamp: "2026-09-18T00:00:00Z",
        message: {
          role: "assistant",
          provider: "test",
          model: "test",
          usage: { input: 7, output: 3, totalTokens: 10 },
        },
      }) + "\n",
    );
    await refreshCostUsageCacheForAgent({ agentId, sessionFiles: [sessionFile] });
    const database = openOpenClawAgentDatabase({ agentId });
    const statement = database.db.prepare("SELECT value_json FROM cache_entries");
    const prototype: StatementSync = Object.getPrototypeOf(statement);
    const observers = [
      vi.spyOn(prototype, "all"),
      vi.spyOn(prototype, "get"),
      vi.spyOn(prototype, "iterate"),
      vi.spyOn(prototype, "run"),
    ];
    const cacheReads = () =>
      observers.flatMap((observer) =>
        observer.mock.contexts
          .map((value) => (value as StatementSync).sourceSQL)
          .filter((sql) => /^select\b.*\bfrom\s+["`]?cache_entries["`]?/is.test(sql)),
      );
    try {
      statement.all();
      expect(cacheReads()).toHaveLength(1);
      for (const observer of observers) {
        observer.mockClear();
      }
      for (let round = 0; round < 2; round++) {
        const result = await loadSessionCostSummariesFromCache({
          agentId,
          sessions: [{ sessionFile }],
          requestRefresh: false,
        });
        expect(result.cacheStatus.status).toBe("fresh");
        expect(result.summaries[0]).toMatchObject({ totalTokens: 10 });
      }
      expect(cacheReads()).toEqual([]);
    } finally {
      for (const observer of observers) {
        observer.mockRestore();
      }
    }
  });
});

it("retains the process-held incognito cache without creating its sentinel file", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const agentId = "usage-incognito";
    const databasePath = resolveIncognitoOpenClawAgentSqlitePath({ agentId });
    expect(await readSessionCostUsageRollupRows(agentId, databasePath)).toEqual([]);
    await writeSessionCostUsageRollup({
      agentId,
      databasePath,
      rollupId: "session",
      previousValueJson: null,
      valueJson: '{"totalTokens":7}',
      updatedAt: 1,
    });
    expect(await readSessionCostUsageRollupRows(agentId, databasePath)).toEqual([
      { key: "session", valueJson: '{"totalTokens":7}', updatedAt: 1 },
    ]);
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
