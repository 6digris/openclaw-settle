import { afterEach, describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { listSessionEntriesCore, upsertSessionEntryCore } from "./session-accessor.js";
import { captureSessionEntryCacheRead } from "./session-accessor.sqlite-entry-cache.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createSessionScope(label: string) {
  const stateDir = tempDirs.make(`openclaw-entry-cache-${label}-`);
  return {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    sessionKey: `agent:main:${label}`,
    projection: "list" as const,
  };
}

describe("exact session entry read lifetimes", () => {
  it("invalidates a warm selected read after a main-schema change", async () => {
    const scope = createSessionScope("selected-schema-change");
    await upsertSessionEntryCore(scope, { sessionId: "selected-schema-change", updatedAt: 1 });
    const database = openOpenClawAgentDatabase(scope);
    const read = captureSessionEntryCacheRead(database, scope.sessionKey);
    try {
      for (let index = 0; index < 4; index += 1) {
        expect(read.isCurrent()).toBe(true);
      }
      database.db.exec("CREATE TABLE scalar_schema_probe (value INTEGER) STRICT");
      expect(read.isCurrent()).toBe(false);
      const next = captureSessionEntryCacheRead(database, scope.sessionKey);
      try {
        expect(next.entry).toEqual(read.entry);
        expect(next.isCurrent()).toBe(true);
      } finally {
        next.release();
      }
    } finally {
      read.release();
    }
  });
});

describe("SQLite session entry cache", () => {
  it("executes all three validity scalars on warm public reads without preparing them again", async () => {
    const scope = createSessionScope("scalar-statements");
    await upsertSessionEntryCore(scope, {
      label: "original",
      sessionId: "scalar-statements",
      updatedAt: 1,
    });
    const database = openOpenClawAgentDatabase(scope);
    const expected = listSessionEntriesCore(scope);
    const keys = ["dataVersion", "schemaVersion", "generation"] as const;
    const queries = new Map<string, (typeof keys)[number]>([
      ["PRAGMA data_version", "dataVersion"],
      ["PRAGMA schema_version", "schemaVersion"],
      [
        "SELECT generation FROM temp.openclaw_session_nodes_cache_generation WHERE id = 1",
        "generation",
      ],
    ]);
    const prepares = { dataVersion: 0, schemaVersion: 0, generation: 0 };
    const executions = trackSqliteStatementExecutions(database.db, keys, (sql) => {
      const key = queries.get(sql);
      if (!key) {
        return null;
      }
      prepares[key] += 1;
      return key;
    });
    try {
      for (let index = 0; index < 4; index += 1) {
        expect(listSessionEntriesCore(scope)).toEqual(expected);
      }
      expect(prepares).toEqual({ dataVersion: 2, schemaVersion: 2, generation: 2 });
      const before = { ...executions.counts };
      const copy = listSessionEntriesCore(scope);
      copy[0]!.entry.label = "caller mutation";
      expect(listSessionEntriesCore(scope)).toEqual(expected);
      for (const key of keys) {
        expect(executions.counts[key]).toBeGreaterThan(before[key]);
        expect(prepares[key]).toBe(2);
      }

      database.db
        .prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.label', ?) WHERE session_key = ?",
        )
        .run("raw same-timestamp write", scope.sessionKey);
      expect(listSessionEntriesCore(scope)[0]?.entry.label).toBe("raw same-timestamp write");
    } finally {
      executions.restore();
    }
  });
});
