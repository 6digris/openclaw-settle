import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  assertNoCanonicalSessionIdentityCollisions,
  normalizeCanonicalSessionCandidateFacts,
} from "../../commands/doctor-session-canonical-candidates.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { ensureSessionEntryValidityProjection } from "../../state/openclaw-agent-db-session-migrations.js";
import { migrateSessionNodesAndWindows } from "../../state/openclaw-agent-db-session-nodes-migration.js";
import { scanCanonicalSessionIdentityFactsFromDatabase } from "./session-accessor.sqlite-canonical-inventory.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function close(database: DatabaseSync) {
  clearNodeSqliteKyselyCacheForDatabase(database);
  database.close();
}

function createLegacyStore(file: string) {
  const database = new DatabaseSync(file);
  database.exec(`
    PRAGMA user_version = 13;
    CREATE TABLE session_entries (
      session_key TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      entry_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE session_routes (
      session_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY, channel TEXT, account_id TEXT, thread_id TEXT
    );
  `);
  return database;
}

function seed(database: DatabaseSync, shape: string) {
  const entry = (
    key: string,
    sessionId: string,
    json = JSON.stringify({ sessionId, updatedAt: 10 }),
  ) =>
    database.prepare("INSERT INTO session_entries VALUES (?, ?, ?, 10)").run(key, sessionId, json);
  database.prepare("INSERT INTO sessions VALUES (?, ?, 1, 10)").run("legacy", "global");
  database
    .prepare("INSERT INTO sessions VALUES (?, ?, 1, 10)")
    .run("qualified", "agent:main:global");
  entry("agent:main:global", "qualified");
  if (shape === "distinct" || shape === "malformed") {
    entry("global", "legacy", shape === "malformed" ? "{" : undefined);
  } else if (shape === "route") {
    database.prepare("INSERT INTO session_routes VALUES ('global', 'legacy', 10)").run();
  } else if (shape !== "history") {
    entry("global", "legacy", "{}");
    const peers = shape === "one-peer" ? 1 : shape === "two-peers" ? 2 : 0;
    for (let index = 0; index < peers; index++) {
      entry(`agent:main:kept-${index}`, "legacy");
    }
  }
}

it("does not require session tables in a pre-session schema", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA user_version = 1;");
    expect(scanCanonicalSessionIdentityFactsFromDatabase({ db: database })).toEqual([]);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  } finally {
    close(database);
  }
});

it.each(
  [13, 14, 18].flatMap((version) =>
    ["distinct", "malformed", "history", "route", "no-peer", "one-peer", "two-peers"].map(
      (shape) => ({ version, shape }),
    ),
  ),
)("preserves $shape identity facts in schema $version before migration", ({ version, shape }) => {
  const root = tempDirs.make("openclaw-historical-identity-");
  const filename = path.join(root, "agent.sqlite");
  const source = createLegacyStore(filename);
  try {
    seed(source, shape);
    if (version >= 14) {
      migrateSessionNodesAndWindows(source, 13);
      if (version === 18) {
        ensureSessionEntryValidityProjection(source);
      }
      source.exec(`PRAGMA user_version = ${version};`);
    }
  } finally {
    close(source);
  }
  const originalBytes = fs.readFileSync(filename);
  const database = new DatabaseSync(filename, { readOnly: true });
  let facts: ReturnType<typeof scanCanonicalSessionIdentityFactsFromDatabase>;
  try {
    facts = scanCanonicalSessionIdentityFactsFromDatabase({ db: database });
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
  } finally {
    close(database);
  }
  expect(fs.readFileSync(filename)).toEqual(originalBytes);
  const target = { agentId: "main", storePath: filename, sqlitePath: filename };
  const candidates = normalizeCanonicalSessionCandidateFacts(
    {
      cfg: { agents: { entries: { main: {} } }, session: { store: filename } },
      env: { OPENCLAW_STATE_DIR: root },
      registeredDatabases: [{ agentId: "main", path: filename }],
    },
    [{ target, facts }],
  );
  const preflight = () =>
    assertNoCanonicalSessionIdentityCollisions(
      candidates.map((candidate) => ({
        canonicalKey: candidate.canonicalKey,
        sessionKey: candidate.sessionKey,
        sqlitePath: candidate.sqlitePath,
        sessionId: candidate.inventoryFact.sessionId,
      })),
    );
  if (shape === "distinct" || shape === "malformed") {
    expect(preflight).toThrow(/session identity conflict/);
  } else {
    expect(preflight).not.toThrow();
    expect(facts.find((fact) => fact.sessionKey === "global")?.canonicalOwnerSessionKey).toBe(
      shape === "one-peer" ? "agent:main:kept-0" : undefined,
    );
  }
  if (version === 13) {
    const migratedPath = path.join(root, "migrated.sqlite");
    fs.copyFileSync(filename, migratedPath);
    const migrated = new DatabaseSync(migratedPath);
    try {
      migrateSessionNodesAndWindows(migrated, 13);
      expect(
        scanCanonicalSessionIdentityFactsFromDatabase({ db: migrated }).toSorted((a, b) =>
          a.sessionKey.localeCompare(b.sessionKey),
        ),
      ).toEqual(facts.toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey)));
    } finally {
      close(migrated);
    }
  }
});
