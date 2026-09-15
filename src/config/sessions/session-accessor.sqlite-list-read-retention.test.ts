import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as nodeSqlite from "../../infra/node-sqlite.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import * as agentReadOnly from "../../state/openclaw-agent-db-readonly-open.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabaseByPathAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { listSessionEntriesReadOnly, recordSessionParticipant } from "./session-accessor.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { retainSessionEntryListReads } from "./session-accessor.sqlite-list-read-retention.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";

const [nodeMajor = 0, nodeMinor = 0] = process.versions.node.split(".").map(Number);
// Node added the public SQLite query diagnostic event in 26.8.0.
const supportsQueryDiagnostics = nodeMajor > 26 || (nodeMajor === 26 && nodeMinor >= 8);

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const activeReads = new Set<ReturnType<typeof retainSessionEntryListReads>>();

afterEach(() => {
  for (const reads of activeReads) {
    reads.release();
  }
  activeReads.clear();
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function retain() {
  const onRevoked = vi.fn<(reason: unknown) => void>();
  const reads = retainSessionEntryListReads({ onRevoked });
  activeReads.add(reads);
  return { reads, onRevoked };
}

function fixture(mode?: "incognito" | "canonical") {
  const stateDir = tempDirs.make("session-list-retention-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const options = {
    agentId: "main",
    env,
    path:
      mode === "incognito"
        ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env })
        : mode === "canonical"
          ? resolveOpenClawAgentSqlitePath({ agentId: "main", env })
          : path.join(stateDir, "sessions.sqlite"),
  };
  const scope = {
    agentId: options.agentId,
    env,
    ...(mode === "canonical" ? {} : { storePath: options.path }),
    projection: "list",
    clone: false,
  } satisfies SessionEntryListScope;
  const entry = {
    sessionId: "session-a",
    updatedAt: 7,
    label: "original",
    visibility: "shared" as const,
    skillsSnapshot: { prompt: "saved prompt", skills: [] },
  };
  const seed = (selectedOptions = options) => {
    const database = openOpenClawAgentDatabase(selectedOptions);
    runOpenClawAgentWriteTransaction((current) => {
      writeSessionEntry(current, "agent:main:a", entry);
      writeSessionEntry(current, "agent:main:b", { ...entry, sessionId: "session-b" });
    }, selectedOptions);
    return database;
  };
  return { entry, options, scope, seed, stateDir };
}

function spyOnSqlitePrepare(
  observe: (database: DatabaseSync, sql: string, statement: StatementSync) => void,
) {
  const open = nodeSqlite.openNodeSqliteDatabase;
  const restoreConnections: Array<() => void> = [];
  const opening = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    const prepare = database.prepare.bind(database);
    const observer = vi.spyOn(database, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      observe(database, sql, statement);
      return statement;
    });
    restoreConnections.push(() => observer.mockRestore());
    return database;
  });
  return () => {
    opening.mockRestore();
    for (const restore of restoreConnections.splice(0)) {
      restore();
    }
  };
}

function observeSessionConnections() {
  const connections = new Set<DatabaseSync>();
  const restore = spyOnSqlitePrepare((database, sql) => {
    if (/\bsession_nodes\b/u.test(sql)) {
      connections.add(database);
    }
  });
  return { connections, restore };
}

describe("retained session listings", () => {
  it("reuses an unchanged cold read without registering a writable owner or rereading entries", () => {
    const { options, scope, seed } = fixture();
    seed();
    closeOpenClawAgentDatabaseByPath(options.path);
    const { connections, restore } = observeSessionConnections();
    const { reads, onRevoked } = retain();
    const first = reads.list(scope);
    expect(first.map(({ sessionKey }) => sessionKey)).toEqual(["agent:main:a", "agent:main:b"]);
    expect(first[0]?.entry.skillsSnapshot).toBeUndefined();
    expect(connections.size).toBe(1);
    const connection = [...connections][0]!;
    restore();
    const counter = trackSqliteStatementExecutions(connection, ["entries"], (sql) =>
      sql.startsWith("select ") && sql.includes('"session_nodes"') ? "entries" : null,
    );
    try {
      const second = reads.list({ ...scope, sessionKeys: ["agent:main:a"] });
      expect(second).toHaveLength(1);
      expect(second[0]?.entry).toBe(first[0]?.entry);
      expect(counter.rowCounts.entries).toBe(0);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expect(connection.isTransaction).toBe(false);
    } finally {
      counter.restore();
      reads.release();
    }
    reads.release();
    expect(connection.isOpen).toBe(false);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
  });

  it.each([
    { mutation: "malformed", selection: ["agent:main:a"] },
    { mutation: "malformed", selection: [] },
    { mutation: "noncanonical", selection: ["agent:main:a"] },
    { mutation: "noncanonical", selection: [] },
  ])(
    "revalidates a cold inventory after an external $mutation sibling write with selection $selection",
    ({ mutation, selection }) => {
      const { options, scope, seed } = fixture();
      seed();
      closeOpenClawAgentDatabaseByPath(options.path);
      const { connections } = observeSessionConnections();
      const { reads } = retain();
      expect(reads.list(scope)).toHaveLength(2);
      const writer = new DatabaseSync(options.path);
      try {
        if (mutation === "malformed") {
          writer
            .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
            .run("{", "agent:main:b");
        } else {
          writer
            .prepare(
              "INSERT INTO session_nodes(session_key, current_session_id, entry_json, updated_at) VALUES(?, ?, ?, ?)",
            )
            .run(
              "AGENT:MAIN:UNRELATED",
              "unrelated",
              JSON.stringify({ sessionId: "unrelated", updatedAt: 7 }),
              7,
            );
          writer
            .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
            .run("AGENT:MAIN:UNRELATED");
        }
        expect(() => reads.list({ ...scope, sessionKeys: selection })).toThrow(
          mutation === "malformed" ? /invalid persisted/u : /non-canonical persisted/u,
        );
        reads.release();
        expect([...connections].every((connection) => !connection.isOpen)).toBe(true);
        expect(writer.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({ busy: 0 });
      } finally {
        reads.release();
        writer.close();
      }
    },
  );

  it("does not bless a cold read with a data version changed during its canonical scan", () => {
    const { options, scope, seed } = fixture();
    seed();
    closeOpenClawAgentDatabaseByPath(options.path);
    const writer = new DatabaseSync(options.path);
    let changed = false;
    const restore = spyOnSqlitePrepare((_database, sql, statement) => {
      if (sql.includes('"retained_window"')) {
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
          yield* iterate(...args);
          if (!changed) {
            changed = true;
            writer
              .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
              .run("{", "agent:main:b");
          }
          return undefined;
        });
      }
    });
    const { reads, onRevoked } = retain();
    try {
      expect(reads.list(scope)[0]?.entry.sessionId).toBe("session-a");
      expect(changed).toBe(true);
      expect(() => reads.list({ ...scope, sessionKeys: ["agent:main:a"] })).toThrow(
        /invalid persisted/u,
      );
      expect(onRevoked).not.toHaveBeenCalled();
    } finally {
      reads.release();
      writer.close();
      restore();
    }
  });

  it("rechecks cold ownership when the opener's metadata changes before the first read stamp", () => {
    const { options, scope, seed } = fixture("canonical");
    const canonicalPath = options.path;
    seed();
    closeOpenClawAgentDatabaseByPath(canonicalPath);
    const writer = new DatabaseSync(canonicalPath);
    let changed = false;
    const restore = spyOnSqlitePrepare((database, sql, statement) => {
      if (
        database.location() === canonicalPath &&
        sql.startsWith("SELECT role, schema_version, agent_id FROM schema_meta")
      ) {
        const get = statement.get.bind(statement);
        vi.spyOn(statement, "get").mockImplementation(
          new Proxy(get, {
            apply(read, receiver, args) {
              const row = Reflect.apply(read, receiver, args);
              if (!changed) {
                changed = true;
                writer
                  .prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'")
                  .run("other");
              }
              return row;
            },
          }),
        );
      }
    });
    const { reads, onRevoked } = retain();
    try {
      expect(() => reads.list(scope)).toThrow(/belongs to agent other; requested agent main/u);
      expect(changed).toBe(true);
      expect(onRevoked).not.toHaveBeenCalled();
      reads.release();
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    } finally {
      reads.release();
      writer.prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'").run("main");
      writer.close();
      restore();
    }
  });

  it("observes tracked same-timestamp visibility changes while preserving the planning values", () => {
    const { entry, options, scope, seed } = fixture();
    const database = seed();
    const { reads, onRevoked } = retain();
    const planning = reads.list(scope);
    runOpenClawAgentWriteTransaction((current) => {
      writeSessionEntry(current, "agent:main:a", { ...entry, visibility: "draft" });
    }, options);
    const current = reads.list({ ...scope, sessionKeys: ["agent:main:a"] });
    expect(current[0]?.entry).toMatchObject({ updatedAt: 7, visibility: "draft" });
    expect(planning[0]?.entry.visibility).toBe("shared");
    expect(onRevoked).not.toHaveBeenCalled();
    reads.release();
    expect(database.db.isOpen).toBe(true);
  });

  it.each(["borrowed", "read-only"] as const)(
    "preserves planning values when a %s reader observes participant updates",
    (mode) => {
      const { options, scope, seed } = fixture();
      seed();
      if (mode === "read-only") {
        closeOpenClawAgentDatabaseByPath(options.path);
      }
      expect(Boolean(getOpenClawAgentDatabaseIfOpen(options))).toBe(mode === "borrowed");
      const { reads } = retain();
      const planning = reads.list(scope);
      const before = structuredClone(planning);
      const sessionKey = "agent:main:a";
      const identity = { type: "profile", id: "participant-a" } as const;
      expect(recordSessionParticipant({ ...scope, sessionKey }, { identity, promptedAt: 10 })).toBe(
        "inserted",
      );
      const current = reads.list({ ...scope, sessionKeys: [sessionKey] });
      expect(current).toHaveLength(1);
      expect(current[0]?.entry).toMatchObject({
        sessionId: "session-a",
        participants: [{ identity }],
        participantCount: 1,
      });
      expect(planning).toEqual(before);
    },
  );

  it.each([{ sessionKeys: [] }, { sessionKeys: ["agent:main:a"] }])(
    "validates a mutated borrowed sibling before applying selection $sessionKeys",
    ({ sessionKeys }) => {
      const { entry, options, scope, seed } = fixture();
      seed();
      const canonicalKey = "agent:main:matrix:channel:!MixedCase:example.org";
      const legacyKey = canonicalKey.toLowerCase();
      runOpenClawAgentWriteTransaction((current) => {
        writeSessionEntry(current, legacyKey, { ...entry, sessionId: "matrix" });
      }, options);
      const { reads } = retain();
      const rows = reads.list(scope);
      const borrowed = rows.find(({ sessionKey }) => sessionKey === legacyKey)!;
      borrowed.entry.delivery = normalizeSessionDeliveryState({
        context: { channel: "matrix", to: "!MixedCase:example.org" },
      });
      expect(() => reads.list({ ...scope, sessionKeys })).toThrow(
        `non-canonical persisted row resolves to session key ${canonicalKey}`,
      );
    },
  );

  it.each([false, true])(
    "preserves rollback visibility for existing and newly acquired readers (incognito=%s)",
    (incognito) => {
      const { entry, options, scope, seed } = fixture(incognito ? "incognito" : undefined);
      const database = seed();
      const retained = retain().reads;
      const reentrant = retain().reads;
      expect(retained.list(scope)[0]?.entry.label).toBe("original");
      const rollback = new Error("roll back unpublished label");
      expect(() =>
        runOpenClawAgentWriteTransaction((current) => {
          writeSessionEntry(current, "agent:main:a", { ...entry, label: "uncommitted" });
          const expected = incognito ? "uncommitted" : "original";
          expect(retained.list(scope)[0]?.entry.label).toBe(expected);
          expect(reentrant.list(scope)[0]?.entry.label).toBe(expected);
          expect(current.db.isTransaction).toBe(true);
          throw rollback;
        }, options),
      ).toThrow(rollback);
      expect(database.db.isTransaction).toBe(false);
      expect(retained.list(scope)[0]?.entry.label).toBe("original");
      expect(reentrant.list(scope)[0]?.entry.label).toBe("original");
      if (incognito) {
        expect(fs.existsSync(options.path)).toBe(false);
      }
    },
  );

  it.each(["database", "schema"] as const)(
    "retries a missing %s on the next delivery without creating it during the miss",
    (missing) => {
      const { options, scope, seed } = fixture();
      if (missing === "schema") {
        new DatabaseSync(options.path).close();
      }
      const { reads, onRevoked } = retain();
      expect(reads.list(scope)).toEqual([]);
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expect(fs.existsSync(options.path)).toBe(missing === "schema");
      seed();
      expect(reads.list(scope).map(({ sessionKey }) => sessionKey)).toEqual([
        "agent:main:a",
        "agent:main:b",
      ]);
      expect(onRevoked).not.toHaveBeenCalled();
    },
  );

  it("retries a missing table after its real schema is restored on the same owner", () => {
    const { options, scope, seed } = fixture();
    const database = openOpenClawAgentDatabase(options);
    const definitions = database.db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE tbl_name = 'session_nodes' AND sql IS NOT NULL ORDER BY type = 'table' DESC, name",
      )
      .all();
    database.db.exec("DROP TABLE session_nodes");
    const { reads, onRevoked } = retain();
    expect(reads.list(scope)).toEqual([]);
    for (const { sql } of definitions) {
      if (typeof sql !== "string") {
        throw new Error("Expected captured session table schema");
      }
      database.db.exec(sql);
    }
    seed();
    expect(reads.list(scope)).toHaveLength(2);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it.each(["between reads", "during a read"] as const)(
    "does not use a stale process-held path replaced %s",
    (timing) => {
      const { entry, options, scope, seed, stateDir } = fixture();
      const originalDirectory = path.join(stateDir, "original");
      const replacementDirectory = path.join(stateDir, "replacement");
      const aliasDirectory = path.join(stateDir, "selected");
      const original = seed({ ...options, path: path.join(originalDirectory, "sessions.sqlite") });
      const replacementOptions = {
        ...options,
        path: path.join(replacementDirectory, "sessions.sqlite"),
      };
      const replacement = seed(replacementOptions);
      runOpenClawAgentWriteTransaction((current) => {
        writeSessionEntry(current, "agent:main:a", {
          ...entry,
          sessionId: "replacement-a",
          label: "replacement",
        });
      }, replacementOptions);
      fs.symlinkSync(originalDirectory, aliasDirectory, "junction");
      const selectedOptions = { ...options, path: path.join(aliasDirectory, "sessions.sqlite") };
      const selected = openOpenClawAgentDatabase(selectedOptions);
      const { reads, onRevoked } = retain();
      const selectedScope = { ...scope, storePath: selectedOptions.path };
      let changed = false;
      const replacePath = () => {
        if (!changed) {
          changed = true;
          fs.rmSync(aliasDirectory, { recursive: true });
          fs.symlinkSync(replacementDirectory, aliasDirectory, "junction");
        }
      };
      try {
        expect(reads.list(selectedScope)[0]?.entry.label).toBe("original");
        if (timing === "during a read") {
          const prepare = selected.db.prepare.bind(selected.db);
          vi.spyOn(selected.db, "prepare").mockImplementation((sql) => {
            const statement = prepare(sql);
            if (sql === "PRAGMA schema_version") {
              const get = statement.get.bind(statement);
              vi.spyOn(statement, "get").mockImplementation(
                new Proxy(get, {
                  apply(read, receiver, args) {
                    const row = Reflect.apply(read, receiver, args);
                    replacePath();
                    return row;
                  },
                }),
              );
            }
            return statement;
          });
          expect(() => reads.list(selectedScope)).toThrow(/path changed during/u);
        } else {
          replacePath();
        }
        expect(changed).toBe(true);
        expect(getOpenClawAgentDatabaseIfOpen(selectedOptions)).toBe(selected);
        expect(reads.list(selectedScope)[0]?.entry).toMatchObject({
          sessionId: "replacement-a",
          label: "replacement",
        });
        expect(onRevoked).not.toHaveBeenCalled();
        expect(selected.db.isOpen).toBe(true);
        expect(original.db.isOpen).toBe(true);
        expect(replacement.db.isOpen).toBe(true);
      } finally {
        reads.release();
        fs.rmSync(aliasDirectory, { recursive: true });
        fs.symlinkSync(originalDirectory, aliasDirectory, "junction");
      }
    },
  );

  it.each(["warm", "cold"] as const)(
    "makes canonical resource revocation terminal for a %s reader",
    async (mode) => {
      const { options, scope, seed } = fixture();
      seed();
      if (mode === "cold") {
        closeOpenClawAgentDatabaseByPath(options.path);
      }
      const { reads, onRevoked } = retain();
      expect(reads.list(scope)).toHaveLength(2);
      await closeOpenClawAgentDatabaseByPathAsync(options.path);
      expect(onRevoked).toHaveBeenCalledOnce();
      expect(() => reads.list(scope)).toThrow();
      reads.release();
      reads.release();
      expect(onRevoked).toHaveBeenCalledOnce();
      expect(getOpenClawAgentDatabaseIfOpen(options)).toBeUndefined();
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    },
  );

  it("preserves schema errors after retention and releases its cold native connection", () => {
    const { options, scope, seed } = fixture();
    seed();
    closeOpenClawAgentDatabaseByPath(options.path);
    const { connections } = observeSessionConnections();
    const { reads } = retain();
    expect(reads.list(scope)).toHaveLength(2);
    const writer = new DatabaseSync(options.path);
    try {
      writer.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
      expect(() => reads.list(scope)).toThrow(/newer schema version/u);
      expect(() => listSessionEntriesReadOnly(scope)).toThrow(/newer schema version/u);
      reads.release();
      expect([...connections].every((connection) => !connection.isOpen)).toBe(true);
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    } finally {
      reads.release();
      writer.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION}`);
      writer.close();
    }
  });

  it("propagates a real lock error, closes the failed read, and recovers after rollback", () => {
    const { options, scope, seed } = fixture();
    seed();
    closeOpenClawAgentDatabaseByPath(options.path);
    const writer = new DatabaseSync(options.path);
    const { connections } = observeSessionConnections();
    const { reads, onRevoked } = retain();
    try {
      writer.exec("PRAGMA journal_mode = DELETE");
      expect(reads.list(scope)).toHaveLength(2);
      expect(connections.size).toBe(1);
      const connection = [...connections][0]!;
      // Exercise error classification without waiting on the production lock budget.
      connection.exec("PRAGMA busy_timeout = 0");
      writer.exec("BEGIN EXCLUSIVE");
      expect(() => reads.list(scope)).toThrow(/(?:busy|locked)/iu);
      expect(connection.isOpen).toBe(false);
      writer.exec("ROLLBACK");
      expect(reads.list(scope).map(({ sessionKey }) => sessionKey)).toEqual([
        "agent:main:a",
        "agent:main:b",
      ]);
      expect(onRevoked).not.toHaveBeenCalled();
    } finally {
      if (writer.isTransaction) {
        writer.exec("ROLLBACK");
      }
      reads.release();
      writer.close();
    }
  });
});

describe("retained listings across maintenance scopes", () => {
  it("keeps a replacement read alive when its predecessor's maintenance scope closes", async () => {
    const { options, scope, seed, stateDir } = fixture();
    const replacementOptions = { ...options, path: path.join(stateDir, "replacement.sqlite") };
    seed();
    seed(replacementOptions);
    closeOpenClawAgentDatabaseByPath(options.path);
    closeOpenClawAgentDatabaseByPath(replacementOptions.path);
    const maintenance = createOpenClawDatabaseMaintenanceScope(() => undefined);
    const { reads, onRevoked } = retain();
    const { connections, restore } = observeSessionConnections();
    try {
      expect(maintenance.run(() => reads.list(scope))).toHaveLength(2);
      const originalConnection = [...connections][0]!;
      const replacementScope = { ...scope, storePath: replacementOptions.path };
      const replacement = reads.list(replacementScope);
      expect(connections.size).toBe(2);
      const replacementConnection = [...connections][1]!;
      expect(originalConnection.isOpen).toBe(false);

      await maintenance.close();

      expect(onRevoked).not.toHaveBeenCalled();
      expect(replacementConnection.isOpen).toBe(true);
      expect(reads.list(replacementScope)[0]?.entry).toBe(replacement[0]?.entry);
    } finally {
      reads.release();
      await maintenance.close();
      restore();
    }
  });

  it("does not retire an empty reusable reader when a discarded leaf's scope closes", async () => {
    const { options, scope, seed, stateDir } = fixture();
    seed();
    closeOpenClawAgentDatabaseByPath(options.path);
    const maintenance = createOpenClawDatabaseMaintenanceScope(() => undefined);
    const { reads, onRevoked } = retain();
    try {
      expect(maintenance.run(() => reads.list(scope))).toHaveLength(2);
      expect(reads.list({ ...scope, storePath: path.join(stateDir, "missing.sqlite") })).toEqual(
        [],
      );
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);

      await maintenance.close();

      expect(onRevoked).not.toHaveBeenCalled();
      expect(reads.list(scope)).toHaveLength(2);
    } finally {
      reads.release();
      await maintenance.close();
    }
  });

  it("keeps normal release quiet when maintenance later closes the same resource", async () => {
    const { options, scope, seed } = fixture();
    seed();
    closeOpenClawAgentDatabaseByPath(options.path);
    const maintenance = createOpenClawDatabaseMaintenanceScope(() => undefined);
    const { reads, onRevoked } = retain();
    try {
      expect(maintenance.run(() => reads.list(scope))).toHaveLength(2);
      reads.release();
      await maintenance.close();
      reads.release();
      expect(onRevoked).not.toHaveBeenCalled();
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    } finally {
      reads.release();
      await maintenance.close();
    }
  });

  it.skipIf(!supportsQueryDiagnostics).each(["cold", "warm"] as const)(
    "settles native revocation during the pre-read stamp of a %s reader",
    async (mode) => {
      const { options, scope, seed } = fixture("canonical");
      const canonicalPath = options.path;
      seed();
      closeOpenClawAgentDatabaseByPath(canonicalPath);
      const maintenance = createOpenClawDatabaseMaintenanceScope(() => undefined);
      const { reads, onRevoked } = retain();
      const queryChannel = channel("sqlite.db.query");
      let closing: Promise<void> | undefined;
      let connection: DatabaseSync | undefined;
      let openDuringCallback: boolean | undefined;
      const onQuery = (message: unknown) => {
        const event = message as { database?: DatabaseSync; sql?: string };
        const database = event.database;
        if (
          closing ||
          event.sql !== "PRAGMA data_version" ||
          !database ||
          database.location() !== canonicalPath
        ) {
          return;
        }
        connection = database;
        closing = maintenance.close();
        openDuringCallback = database.isOpen;
      };
      try {
        if (mode === "warm") {
          expect(maintenance.run(() => reads.list(scope))).toHaveLength(2);
        }
        queryChannel.subscribe(onQuery);
        let readError: unknown;
        try {
          maintenance.run(() => reads.list(scope));
        } catch (error) {
          readError = error;
        }
        expect(closing).toBeDefined();
        await expect(closing).resolves.toBeUndefined();
        expect(openDuringCallback).toBe(true);
        expect(connection?.isOpen).toBe(false);
        expect(readError).toMatchObject({ message: expect.stringMatching(/no longer current/u) });
        expect(onRevoked).toHaveBeenCalledOnce();
        expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
      } finally {
        queryChannel.unsubscribe(onQuery);
        try {
          await closing?.catch(() => {});
          reads.release();
          await maintenance.close();
        } finally {
          // A failing regression must not leave the test-owned native handle open.
          if (connection?.isOpen) {
            connection.close();
          }
        }
      }
    },
  );

  it("revokes a current read immediately and closes SQLite after the synchronous read unwinds", async () => {
    const { options, scope, seed } = fixture();
    seed();
    closeOpenClawAgentDatabaseByPath(options.path);
    const maintenance = createOpenClawDatabaseMaintenanceScope(() => undefined);
    const { reads, onRevoked } = retain();
    let closing: Promise<void> | undefined;
    const connections = new Set<DatabaseSync>();
    const restore = spyOnSqlitePrepare((database, sql, statement) => {
      if (sql.includes('"retained_window"')) {
        connections.add(database);
        const closeAfterRows = () => {
          if (!closing) {
            closing = maintenance.close();
            expect(onRevoked).toHaveBeenCalledOnce();
            expect(database.isOpen).toBe(true);
            expect(() => reads.list(scope)).toThrow(/no longer current/u);
          }
        };
        const iterate = statement.iterate.bind(statement);
        vi.spyOn(statement, "iterate").mockImplementation(function* (...args) {
          yield* iterate(...args);
          closeAfterRows();
          return undefined;
        });
      }
    });
    try {
      expect(() => maintenance.run(() => reads.list(scope))).toThrow(/no longer current/u);
      expect(closing).toBeDefined();
      expect(connections.size).toBe(1);
      expect([...connections][0]?.isOpen).toBe(false);
      await closing;
      expect(onRevoked).toHaveBeenCalledOnce();
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    } finally {
      reads.release();
      await maintenance.close();
      restore();
    }
  });

  it("rejects detached work inheriting a closed scope without leaking a native read or resource", async () => {
    const { options, scope, seed } = fixture("canonical");
    const canonicalPath = options.path;
    seed();
    closeOpenClawAgentDatabaseByPath(canonicalPath);
    const maintenance = createOpenClawDatabaseMaintenanceScope(() => undefined);
    const { reads, onRevoked } = retain();
    const connections = new Set<DatabaseSync>();
    const restore = spyOnSqlitePrepare((database) => {
      if (database.location() === canonicalPath) {
        connections.add(database);
      }
    });
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    // Returning an object leaves this continuation outside the scope's joined work.
    const detached = maintenance.run(() => ({ result: gate.then(() => reads.list(scope)) }));
    try {
      await maintenance.close();
      resume();
      await expect(detached.result).rejects.toThrow(/maintenance resource scope is closed/u);
      expect([...connections].every((connection) => !connection.isOpen)).toBe(true);
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
      expect(onRevoked).not.toHaveBeenCalled();
    } finally {
      resume();
      await Promise.allSettled([detached.result]);
      reads.release();
      await closeOpenClawAgentDatabaseByPathAsync(canonicalPath);
      await maintenance.close();
      restore();
    }
  });
});

describe("retained listings during maintenance drainage", () => {
  it("rejects a detached read without discarding the leaf still owned by accepted work", async () => {
    const { options, scope, seed } = fixture("canonical");
    const canonicalPath = options.path;
    seed();
    closeOpenClawAgentDatabaseByPath(canonicalPath);
    const maintenance = createOpenClawDatabaseMaintenanceScope(() => undefined);
    const { reads, onRevoked } = retain();
    const { connections, restore } = observeSessionConnections();
    let resumeAccepted!: () => void;
    const acceptedGate = new Promise<void>((resolve) => {
      resumeAccepted = resolve;
    });
    let resumeDetached!: () => void;
    const detachedGate = new Promise<void>((resolve) => {
      resumeDetached = resolve;
    });
    const accepted = maintenance.run(async () => {
      const original = reads.list(scope);
      await acceptedGate;
      const current = reads.list(scope);
      expect(current[0]?.entry).toBe(original[0]?.entry);
      expect(onRevoked).not.toHaveBeenCalled();
      return current;
    });
    const detached = maintenance.run(() => ({
      result: detachedGate.then(() => reads.list(scope)),
    }));
    const closing = maintenance.close();
    try {
      resumeDetached();
      await expect(detached.result).rejects.toThrow(/maintenance resource admission is closed/u);
      expect(connections.size).toBe(1);
      expect([...connections][0]?.isOpen).toBe(true);
      expect(onRevoked).not.toHaveBeenCalled();

      resumeAccepted();
      await expect(accepted).resolves.toHaveLength(2);
      await closing;

      expect(onRevoked).toHaveBeenCalledOnce();
      expect([...connections].every((connection) => !connection.isOpen)).toBe(true);
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    } finally {
      resumeDetached();
      resumeAccepted();
      await Promise.allSettled([detached.result, accepted]);
      reads.release();
      await closing;
      restore();
    }
  });

  it("admits a first cold read from an accepted continuation while maintenance is draining", async () => {
    const { options, scope, seed } = fixture("canonical");
    const canonicalPath = options.path;
    seed();
    closeOpenClawAgentDatabaseByPath(canonicalPath);
    const maintenance = createOpenClawDatabaseMaintenanceScope(() => undefined);
    const { reads, onRevoked } = retain();
    const { connections, restore } = observeSessionConnections();
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let readCompleted = false;
    const accepted = maintenance.run(async () => {
      await gate;
      const rows = reads.list(scope);
      expect(rows.map(({ sessionKey }) => sessionKey)).toEqual(["agent:main:a", "agent:main:b"]);
      expect(onRevoked).not.toHaveBeenCalled();
      readCompleted = true;
      return rows;
    });
    const closing = maintenance.close();
    try {
      expect(readCompleted).toBe(false);
      expect(connections.size).toBe(0);
      resume();
      await expect(accepted).resolves.toHaveLength(2);
      await closing;
      expect(readCompleted).toBe(true);
      expect(connections.size).toBe(1);
      expect([...connections][0]?.isOpen).toBe(false);
      expect(onRevoked).toHaveBeenCalledOnce();
      expect(hasOpenClawAgentDatabaseAsyncResources()).toBe(false);
    } finally {
      resume();
      await Promise.allSettled([accepted]);
      reads.release();
      await closing;
      restore();
    }
  });
});

describe.skipIf(process.platform === "win32" || process.geteuid?.() === 0)(
  "retained listings after POSIX filesystem admission changes",
  () => {
    it.each(["main", "wal", "parent", "ancestor"] as const)(
      "reopens through native admission after %s permissions change",
      (target) => {
        const { options, scope, seed } = fixture("canonical");
        const canonicalPath = options.path;
        seed();
        closeOpenClawAgentDatabaseByPath(canonicalPath);
        const { reads, onRevoked } = retain();
        const opened: DatabaseSync[] = [];
        const open = agentReadOnly.openOpenClawAgentDatabaseReadOnly;
        let nativeFailure: unknown;
        const opening = vi
          .spyOn(agentReadOnly, "openOpenClawAgentDatabaseReadOnly")
          .mockImplementation((...args) => {
            try {
              const result = open(...args);
              if (result.found) {
                opened.push(result.database.db);
              }
              return result;
            } catch (error) {
              nativeFailure = error;
              throw error;
            }
          });
        const changedPath =
          target === "parent" || target === "ancestor"
            ? path.dirname(canonicalPath)
            : canonicalPath + (target === "wal" ? "-wal" : "");
        let writer: DatabaseSync | undefined;
        let originalMode: number | undefined;
        try {
          if (target === "wal") {
            writer = new DatabaseSync(canonicalPath);
            writer.exec(
              `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION};`,
            );
          }
          expect(reads.list(scope)).toHaveLength(2);
          const original = opened[0]!;
          expect(original.isOpen).toBe(true);
          originalMode = fs.statSync(changedPath).mode & 0o7777;
          const changedMode = target === "parent" ? 0o500 : 0;
          fs.chmodSync(changedPath, changedMode);
          let rows: ReturnType<typeof listSessionEntriesReadOnly> | undefined;
          let failure: unknown;
          try {
            rows = reads.list(scope);
          } catch (error) {
            failure = error;
          }
          if (target === "main" || target === "wal") {
            expect(failure).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 14 });
          }
          if (failure) {
            expect(failure).toBe(nativeFailure);
          } else {
            expect(rows).toHaveLength(target === "ancestor" ? 0 : 2);
          }
          expect(opening).toHaveBeenCalledTimes(2);
          expect(original.isOpen).toBe(false);
          expect(fs.statSync(changedPath).mode & 0o7777).toBe(changedMode);
          expect(onRevoked).not.toHaveBeenCalled();
        } finally {
          if (originalMode !== undefined) {
            fs.chmodSync(changedPath, originalMode);
          }
          reads.release();
          writer?.close();
          opening.mockRestore();
        }
      },
    );
  },
);

it("reopens through native admission when sidecar metadata is unavailable", () => {
  const { options, scope, seed } = fixture("canonical");
  const canonicalPath = options.path;
  seed();
  closeOpenClawAgentDatabaseByPath(canonicalPath);
  const { reads, onRevoked } = retain();
  const { connections, restore } = observeSessionConnections();
  const expected = reads.list(scope);
  const original = [...connections][0]!;
  expect(original.isOpen).toBe(true);
  const journalPath = `${original.location()}-journal`;
  const statSync = fs.statSync.bind(fs);
  let unavailable = 0;
  const metadata = vi.spyOn(fs, "statSync").mockImplementation(
    new Proxy(statSync, {
      apply(stat, receiver, args) {
        if (args[0] === journalPath) {
          unavailable += 1;
          throw Object.assign(new Error("Sidecar metadata is unavailable"), { code: "EIO" });
        }
        return Reflect.apply(stat, receiver, args);
      },
    }),
  );
  try {
    expect(reads.list(scope)).toEqual(expected);
    expect(unavailable).toBeGreaterThan(0);
    expect(original.isOpen).toBe(false);
    expect(connections.size).toBe(2);
    expect(onRevoked).not.toHaveBeenCalled();
  } finally {
    metadata.mockRestore();
    reads.release();
    restore();
  }
});
