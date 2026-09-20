import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordDeferredPluginSessionImport } from "../infra/deferred-plugin-session-sources.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import * as snapshots from "../infra/sqlite-snapshot.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { readStateSchemaContentVersion } from "../state/openclaw-state-db-schema-version.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  LEGACY_SESSION_GROUP_SECTION_ORDER_KEY,
  SESSION_GROUP_MIGRATION_KEY,
  sessionGroupSectionOrderKey,
} from "../state/session-group-ownership.js";
import {
  isSessionGroupCatalogReady,
  assertSessionGroupCatalogReady,
} from "../state/session-group-readiness.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runDoctorConfigPreflight } from "./doctor-config-preflight.js";
import { migrateDoctorSessionGroups } from "./doctor-session-groups.js";
import { readMigrationArtifactIdentity } from "./doctor-session-sqlite-artifact.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(directories);
});

function fixture() {
  const root = makeTempDir(directories, "session-group-cutover-");
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { alpha: {}, beta: {} },
      defaults: { systemAgent: { agentId: "beta" } },
    },
  };
  return { root, env, cfg };
}

function seedAgent(
  env: NodeJS.ProcessEnv,
  agentId: string,
  entries: Array<{ key: string; category?: string }>,
  databasePath?: string,
) {
  const opened = openOpenClawAgentDatabase({
    agentId,
    env,
    ...(databasePath ? { path: databasePath } : {}),
  });
  const pathname = opened.path;
  closeOpenClawAgentDatabasesForTest();
  const db = openNodeSqliteDatabase(pathname);
  try {
    for (const [index, entry] of entries.entries()) {
      const sessionId = `session-${index}`;
      const json = JSON.stringify({
        sessionId,
        updatedAt: 123,
        category: entry.category,
        skillsSnapshot: { prompt: "saved prompt that is not a migration input" },
        systemPromptReport: { huge: "x".repeat(1024) },
      });
      db.prepare(
        "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES(?,?,?,?)",
      ).run(entry.key, sessionId, json, 123);
    }
  } finally {
    db.close();
  }
  return pathname;
}

function seedGlobal(env: NodeJS.ProcessEnv) {
  const db = openOpenClawStateDatabase({ env }).db;
  db.prepare(
    "INSERT INTO session_groups(name,position,created_at,cwd,worktree) VALUES(?,?,?,?,?)",
  ).run("Shared", 3, 42, "/workspace/project", 0);
  db.prepare(
    "INSERT INTO session_groups(name,position,created_at,cwd,worktree) VALUES(?,?,?,?,?)",
  ).run("Empty", 8, 99, null, null);
  db.prepare("INSERT INTO config_machine_state VALUES(?,?,?)").run(
    LEGACY_SESSION_GROUP_SECTION_ORDER_KEY,
    JSON.stringify(["work", "category:Empty", "category:Shared", "ungrouped"]),
    12,
  );
  return db;
}

function groups(db: DatabaseSync) {
  return db.prepare("SELECT * FROM agent_session_groups ORDER BY agent_id, position, name").all();
}
function metadata(pathname: string) {
  const db = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return db
      .prepare("SELECT session_key,entry_json,updated_at FROM session_nodes ORDER BY session_key")
      .all();
  } finally {
    db.close();
  }
}

function downgradeTo17(env: NodeJS.ProcessEnv) {
  const pathname = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  const db = openNodeSqliteDatabase(pathname);
  db.exec(
    "DROP TABLE agent_session_groups; PRAGMA user_version=17; UPDATE schema_meta SET schema_version=17 WHERE meta_key='primary';",
  );
  db.prepare("DELETE FROM config_machine_state WHERE state_key IN (?, ?)").run(
    SESSION_GROUP_MIGRATION_KEY,
    "state.schema.contentVersion",
  );
  db.close();
  return pathname;
}

describe("agent-owned session group cutover", () => {
  it.each(["doctor", "startup"] as const)(
    "refuses public %s preflight before schema publication when a required catalog source is unavailable",
    async (mode) => {
      const f = fixture();
      const agentPath = seedAgent(f.env, "alpha", [
        { key: "agent:alpha:main", category: "Shared" },
      ]);
      seedGlobal(f.env);
      const statePath = downgradeTo17(f.env);
      fs.writeFileSync(f.env.OPENCLAW_CONFIG_PATH, JSON.stringify(f.cfg));
      fs.renameSync(agentPath, `${agentPath}.retained`);
      await withEnvAsync(f.env, async () => {
        await expect(
          runDoctorConfigPreflight({
            doctorOnlyStateMigrations: mode === "doctor",
            requireStartupMigrationCheckpoint: mode === "startup",
            migrateLegacyConfig: false,
          }),
        ).rejects.toThrow();
      });
      const state = openNodeSqliteDatabase(statePath, { readOnly: true });
      try {
        expect(state.prepare("PRAGMA user_version").get()?.user_version).toBe(17);
        expect(readStateSchemaContentVersion(state)).toBe(17);
        expect(isSessionGroupCatalogReady(state)).toBe(false);
      } finally {
        state.close();
      }
    },
  );
  it("splits shared names, preserves false vs absent defaults, empty ambient ownership, orphan categories and session bytes", async () => {
    const f = fixture();
    const alpha = seedAgent(f.env, "alpha", [{ key: "agent:alpha:main", category: "Shared" }]);
    const beta = seedAgent(f.env, "beta", [
      { key: "agent:beta:main", category: "Shared" },
      { key: "agent:beta:other", category: "Orphan" },
    ]);
    seedGlobal(f.env);
    downgradeTo17(f.env);
    const before = [metadata(alpha), metadata(beta)];
    await migrateDoctorSessionGroups(f.cfg, f.env);
    const db = openOpenClawStateDatabase({ env: f.env }).db;
    expect(groups(db)).toEqual([
      {
        agent_id: "alpha",
        name: "Shared",
        position: 3,
        created_at: 42,
        cwd: "/workspace/project",
        worktree: 0,
      },
      {
        agent_id: "beta",
        name: "Shared",
        position: 3,
        created_at: 42,
        cwd: "/workspace/project",
        worktree: 0,
      },
      { agent_id: "beta", name: "Empty", position: 8, created_at: 99, cwd: null, worktree: null },
      { agent_id: "beta", name: "Orphan", position: 9, created_at: 0, cwd: null, worktree: null },
    ]);
    expect(readConfigMachineState(sessionGroupSectionOrderKey("alpha"), { env: f.env })).toEqual([
      "work",
      "category:Shared",
      "ungrouped",
    ]);
    expect(readConfigMachineState(sessionGroupSectionOrderKey("beta"), { env: f.env })).toEqual([
      "work",
      "category:Empty",
      "category:Shared",
      "ungrouped",
    ]);
    expect([metadata(alpha), metadata(beta)]).toEqual(before);
    expect(db.prepare("SELECT count(*) AS n FROM session_groups").get()?.n).toBe(2);
    expect(isSessionGroupCatalogReady(db)).toBe(true);
    const receipt = readConfigMachineState<{ backupPath: string }>(SESSION_GROUP_MIGRATION_KEY, {
      env: f.env,
    });
    const backup = openNodeSqliteDatabase(receipt!.backupPath, { readOnly: true });
    try {
      expect(backup.prepare("PRAGMA user_version").get()?.user_version).toBe(17);
      expect(readStateSchemaContentVersion(backup)).toBe(17);
      expect(backup.prepare("SELECT name FROM session_groups ORDER BY position").all()).toEqual([
        { name: "Shared" },
        { name: "Empty" },
      ]);
    } finally {
      backup.close();
    }
    db.prepare("DELETE FROM agent_session_groups WHERE agent_id='alpha'").run();
    closeOpenClawStateDatabaseForTest();
    await expect(migrateDoctorSessionGroups(f.cfg, f.env)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
    expect(
      groups(openOpenClawStateDatabase({ env: f.env }).db).some((row) => row.agent_id === "alpha"),
    ).toBe(false);
  });

  it("preserves absent defaults when the legacy catalog predates first-use columns", async () => {
    const f = fixture();
    seedGlobal(f.env);
    const pathname = downgradeTo17(f.env);
    const legacy = openNodeSqliteDatabase(pathname);
    legacy.exec(
      "ALTER TABLE session_groups DROP COLUMN cwd; ALTER TABLE session_groups DROP COLUMN worktree;",
    );
    legacy.close();
    await migrateDoctorSessionGroups(f.cfg, f.env);
    expect(
      groups(openOpenClawStateDatabase({ env: f.env }).db).every(
        (row) => row.cwd === null && row.worktree === null,
      ),
    ).toBe(true);
  });

  it("uses logical key owners in a shared physical store and retains retired owners", async () => {
    const f = fixture();
    const shared = path.join(f.root, "shared.sqlite");
    f.cfg.session = { store: shared };
    f.cfg.agents!.defaults!.sessionStore = { agentId: "alpha" };
    seedAgent(
      f.env,
      "alpha",
      [
        { key: "agent:alpha:main", category: "Shared" },
        { key: "agent:beta:main", category: "Shared" },
        { key: "agent:retired:main", category: "Shared" },
      ],
      shared,
    );
    seedGlobal(f.env);
    await migrateDoctorSessionGroups(f.cfg, f.env);
    expect(
      groups(openOpenClawStateDatabase({ env: f.env }).db)
        .filter((row) => row.name === "Shared")
        .map((row) => row.agent_id),
    ).toEqual(["alpha", "beta", "retired"]);
  });

  it("imports legacy metadata without reading transcripts and preserves canonical cleared categories", async () => {
    const f = fixture();
    seedAgent(f.env, "alpha", [{ key: "agent:alpha:main" }]);
    seedGlobal(f.env);
    const storePath = path.join(f.root, "agents", "alpha", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const bytes = JSON.stringify({
      "agent:alpha:main": { sessionId: "old", category: "Shared" },
      "agent:retired:other": {
        sessionId: "legacy",
        category: "Legacy only",
        sessionFile: "/must-not-be-read.jsonl",
      },
    });
    fs.writeFileSync(storePath, bytes);
    await migrateDoctorSessionGroups(f.cfg, f.env);
    const rows = groups(openOpenClawStateDatabase({ env: f.env }).db);
    expect(rows.some((row) => row.agent_id === "alpha" && row.name === "Shared")).toBe(false);
    expect(rows.some((row) => row.agent_id === "retired" && row.name === "Legacy only")).toBe(true);
    expect(fs.readFileSync(storePath, "utf8")).toBe(bytes);
  });

  it("does not resurrect a deleted member from an acknowledged retained index", async () => {
    const f = fixture();
    const sqlitePath = seedAgent(f.env, "alpha", []);
    seedGlobal(f.env);
    const storePath = path.join(f.root, "agents", "alpha", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:alpha:deleted": { sessionId: "deleted", category: "Shared" },
      }),
    );
    recordDeferredPluginSessionImport({
      cfg: f.cfg,
      env: f.env,
      target: { agentId: "alpha", storePath },
      sqlitePath,
      pluginIds: ["fixture"],
      recordCount: 1,
      sources: [{ path: storePath, identity: readMigrationArtifactIdentity(storePath) }],
    });
    await migrateDoctorSessionGroups(f.cfg, f.env);
    expect(
      groups(openOpenClawStateDatabase({ env: f.env }).db).some((row) => row.agent_id === "alpha"),
    ).toBe(false);
  });

  it.each(["missing", "corrupt"])(
    "does not treat a %s required source as empty",
    async (failure) => {
      const f = fixture();
      const pathname = seedAgent(f.env, "alpha", [{ key: "agent:alpha:main", category: "Shared" }]);
      seedGlobal(f.env);
      const statePath = downgradeTo17(f.env);
      if (failure === "missing") {
        fs.renameSync(pathname, `${pathname}.retained`);
      } else {
        fs.writeFileSync(pathname, "not a SQLite database");
      }
      await expect(migrateDoctorSessionGroups(f.cfg, f.env)).rejects.toThrow();
      const db = openNodeSqliteDatabase(statePath, { readOnly: true });
      try {
        expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(17);
        expect(readStateSchemaContentVersion(db)).toBe(17);
        expect(isSessionGroupCatalogReady(db)).toBe(false);
      } finally {
        db.close();
      }
    },
  );

  it("rolls all catalog/order writes back when receipt publication fails and retries after reopen", async () => {
    const f = fixture();
    seedGlobal(f.env);
    const db = openOpenClawStateDatabase({ env: f.env }).db;
    db.exec(`CREATE TEMP TRIGGER fail_group_receipt BEFORE INSERT ON config_machine_state
      WHEN NEW.state_key='sessionGroups.agentOwnedCatalog' BEGIN SELECT RAISE(ABORT,'receipt crash'); END;`);
    await expect(migrateDoctorSessionGroups(f.cfg, f.env)).rejects.toThrow("receipt crash");
    expect(groups(db)).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT state_key FROM config_machine_state WHERE state_key LIKE 'sidebar.sectionOrder.agent:%'",
        )
        .all(),
    ).toEqual([]);
    expect(isSessionGroupCatalogReady(db)).toBe(false);
    closeOpenClawStateDatabaseForTest();
    await migrateDoctorSessionGroups(f.cfg, f.env);
    expect(isSessionGroupCatalogReady(openOpenClawStateDatabase({ env: f.env }).db)).toBe(true);
  });

  it("refuses source changes during the awaited verified snapshot", async () => {
    const f = fixture();
    const db = seedGlobal(f.env);
    const realSnapshot = snapshots.createVerifiedSqliteSnapshot;
    vi.spyOn(snapshots, "createVerifiedSqliteSnapshot").mockImplementationOnce(async (options) => {
      const result = await realSnapshot(options);
      db.prepare("UPDATE session_groups SET position=position+1").run();
      return result;
    });
    await expect(migrateDoctorSessionGroups(f.cfg, f.env)).rejects.toThrow("sources changed");
    expect(groups(db)).toEqual([]);
    expect(isSessionGroupCatalogReady(db)).toBe(false);
  });

  it("does not publish any catalog when the verified recovery snapshot fails", async () => {
    const f = fixture();
    const db = seedGlobal(f.env);
    vi.spyOn(snapshots, "createVerifiedSqliteSnapshot").mockRejectedValueOnce(
      new Error("snapshot unavailable"),
    );
    await expect(migrateDoctorSessionGroups(f.cfg, f.env)).rejects.toThrow("snapshot unavailable");
    expect(groups(db)).toEqual([]);
    expect(isSessionGroupCatalogReady(db)).toBe(false);
  });

  it("refuses a missing v17 source table rather than recreating an empty catalog", async () => {
    const f = fixture();
    seedGlobal(f.env);
    const pathname = downgradeTo17(f.env);
    const legacy = openNodeSqliteDatabase(pathname);
    legacy.exec("DROP TABLE session_groups");
    legacy.close();
    await expect(migrateDoctorSessionGroups(f.cfg, f.env)).rejects.toThrow();
    const after = openNodeSqliteDatabase(pathname, { readOnly: true });
    try {
      expect(
        after.prepare("SELECT name FROM sqlite_schema WHERE name = 'session_groups'").get(),
      ).toBeUndefined();
      expect(after.prepare("PRAGMA user_version").get()?.user_version).toBe(17);
    } finally {
      after.close();
    }
  });

  it("never overwrites newer owned rows lacking a receipt", async () => {
    const f = fixture();
    const db = seedGlobal(f.env);
    db.prepare("INSERT INTO agent_session_groups VALUES('alpha','New',0,100,NULL,NULL)").run();
    await expect(migrateDoctorSessionGroups(f.cfg, f.env)).rejects.toThrow(
      "without their migration receipt",
    );
    expect(groups(db)).toEqual([
      { agent_id: "alpha", name: "New", position: 0, created_at: 100, cwd: null, worktree: null },
    ]);
  });

  it("keeps schema-only readers unready and initializes a fresh empty fleet through the same owner", async () => {
    const f = fixture();
    const db = openOpenClawStateDatabase({ env: f.env }).db;
    expect(() => assertSessionGroupCatalogReady(db)).toThrow("migration is incomplete");
    await migrateDoctorSessionGroups(f.cfg, f.env);
    expect(() => assertSessionGroupCatalogReady(db)).not.toThrow();
    expect(groups(db)).toEqual([]);
    expect(fs.existsSync(path.join(f.root, "agents"))).toBe(false);
  });

  it("retains the old global shape during the 2026.9.2 trailing-ledger window", async () => {
    const f = fixture();
    seedGlobal(f.env);
    createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, { env: f.env });
    downgradeTo17(f.env);
    await migrateDoctorSessionGroups(f.cfg, f.env);
    const db = openOpenClawStateDatabase({ env: f.env }).db;
    expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(17);
    expect(readStateSchemaContentVersion(db)).toBe(18);
    expect(
      db
        .prepare(
          "SELECT name, position, created_at, cwd, worktree FROM session_groups ORDER BY position",
        )
        .all(),
    ).toHaveLength(2);
    expect(isSessionGroupCatalogReady(db)).toBe(true);
    closeOpenClawStateDatabaseForTest();
    await expect(migrateDoctorSessionGroups(f.cfg, f.env)).resolves.toEqual({
      changes: [],
      warnings: [],
    });
  });
});
