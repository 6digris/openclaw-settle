import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { removeCanonicalValidationFromHistoricalAgentFixture } from "../state/openclaw-agent-db.test-support.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const run = promisify(execFile);

function prepare(root: string) {
  return run(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(new URL("./memory-worker-entry.ts", import.meta.url)),
      "--prepare",
      path.join(root, "workspace"),
      path.join(root, "state"),
      "main",
    ],
    { env: { PATH: process.env.PATH, HOME: root }, timeout: 30_000 },
  );
}

it("prepares an existing schema-19 index without losing its data and can run again", async () => {
  const root = tempDirs.make("memory-worker-upgrade-");
  const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
  const current = openOpenClawAgentDatabase({ agentId: "main", env });
  const filename = current.path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const { DatabaseSync } = requireNodeSqlite();
  const legacy = new DatabaseSync(filename);
  removeCanonicalValidationFromHistoricalAgentFixture(legacy);
  legacy.exec(`
    DROP TABLE session_transcript_cold_archives;
    PRAGMA user_version = 19;
    UPDATE schema_meta SET schema_version = 19 WHERE meta_key = 'primary';
    INSERT INTO cache_entries(scope, key, value_json, updated_at)
      VALUES ('memory-upgrade-test', 'retained', '"existing value"', 1);
  `);
  legacy.close();
  const registryPath = resolveOpenClawStateSqlitePath(env);
  const registry = new DatabaseSync(registryPath);
  registry.exec("UPDATE agent_databases SET schema_version = 19 WHERE agent_id = 'main'");
  registry.close();

  await prepare(root);
  await prepare(root);

  const upgraded = new DatabaseSync(filename, { readOnly: true });
  try {
    expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(upgraded.prepare("SELECT role, agent_id FROM schema_meta").get()).toEqual({
      role: "agent",
      agent_id: "main",
    });
    expect(
      upgraded
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ?")
        .get("memory-upgrade-test"),
    ).toEqual({ value_json: '"existing value"' });
  } finally {
    upgraded.close();
  }
  // Ordinary open owns registry refresh after the offline schema upgrade.
  openOpenClawAgentDatabase({ agentId: "main", env });
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const registered = new DatabaseSync(registryPath, { readOnly: true });
  try {
    expect(
      registered
        .prepare("SELECT schema_version FROM agent_databases WHERE agent_id = 'main'")
        .get(),
    ).toEqual({
      schema_version: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
    expect(registered.prepare("SELECT COUNT(*) AS count FROM agent_database_leases").get()).toEqual(
      { count: 0 },
    );
  } finally {
    registered.close();
  }
  expect(fs.existsSync(path.join(root, "workspace"))).toBe(false);
}, 60_000);

it("refuses preparation while another process holds the agent database", async () => {
  const root = tempDirs.make("memory-worker-active-");
  const current = openOpenClawAgentDatabase({
    agentId: "main",
    env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
  });
  await expect(prepare(root)).rejects.toThrow(/lease|active|in use/i);
  expect(current.db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
  });
}, 60_000);
