import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  enableNodeSqliteKyselyStatementCache,
  executeWithCachedStatement,
} from "./kysely-sync-cache-state.js";
import { readSqliteDataVersion } from "./node-sqlite.js";

const databases: DatabaseSync[] = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0).reverse()) {
    if (database.isOpen) {
      database.close();
    }
  }
});

function openDatabase(location = ":memory:") {
  const database = new DatabaseSync(location);
  databases.push(database);
  return database;
}

describe("SQLite data-version statement reuse", () => {
  it.each([false, true])("executes every read with owner caching %s", (owned) => {
    const database = openDatabase();
    if (owned) {
      enableNodeSqliteKyselyStatementCache(database);
    }
    let prepares = 0;
    const executions = trackSqliteStatementExecutions(database, ["version"], (sql) => {
      if (sql !== "PRAGMA data_version") {
        return null;
      }
      prepares += 1;
      return "version";
    });
    try {
      const version = readSqliteDataVersion(database);
      for (let index = 0; index < 5; index += 1) {
        expect(readSqliteDataVersion(database)).toBe(version);
      }
      expect(executions.counts.version).toBe(6);
      expect(prepares).toBe(owned ? 2 : 6);
    } finally {
      executions.restore();
    }
  });

  it("rereads external commits while preserving own commits, rollbacks, and read snapshots", () => {
    const pathname = path.join(tempDirs.make("sqlite-version-"), "state.sqlite");
    const reader = openDatabase(pathname);
    reader.exec("PRAGMA journal_mode = WAL; CREATE TABLE probe (value TEXT NOT NULL) STRICT");
    const writer = openDatabase(pathname);
    enableNodeSqliteKyselyStatementCache(reader);
    enableNodeSqliteKyselyStatementCache(writer);
    const initial = readSqliteDataVersion(reader);
    for (let index = 0; index < 3; index += 1) {
      expect(readSqliteDataVersion(reader)).toBe(initial);
    }

    reader.exec("INSERT INTO probe VALUES ('own commit')");
    expect(readSqliteDataVersion(reader)).toBe(initial);
    reader.exec("BEGIN; INSERT INTO probe VALUES ('rolled back'); ROLLBACK");
    expect(readSqliteDataVersion(reader)).toBe(initial);

    const writerVersion = readSqliteDataVersion(writer);
    writer.exec("INSERT INTO probe VALUES ('external commit')");
    expect(readSqliteDataVersion(writer)).toBe(writerVersion);
    const committed = readSqliteDataVersion(reader);
    expect(committed).not.toBe(initial);

    reader.exec("BEGIN");
    try {
      expect(reader.prepare("SELECT count(*) AS count FROM probe").get()?.count).toBe(2);
      expect(readSqliteDataVersion(reader)).toBe(committed);
      writer.exec("INSERT INTO probe VALUES ('after snapshot')");
      expect(readSqliteDataVersion(reader)).toBe(committed);
      expect(reader.prepare("SELECT count(*) AS count FROM probe").get()?.count).toBe(2);
    } finally {
      reader.exec("ROLLBACK");
    }
    expect(readSqliteDataVersion(reader)).not.toBe(committed);
    expect(reader.prepare("SELECT count(*) AS count FROM probe").get()?.count).toBe(3);
  });

  it.runIf(typeof DatabaseSync.prototype.setAuthorizer === "function")(
    "honors a dynamic authorizer after warming and after its removal",
    () => {
      const database = openDatabase();
      enableNodeSqliteKyselyStatementCache(database);
      const prepare = vi.spyOn(database, "prepare");
      const version = readSqliteDataVersion(database);
      expect(readSqliteDataVersion(database)).toBe(version);
      expect(readSqliteDataVersion(database)).toBe(version);
      expect(prepare).toHaveBeenCalledTimes(2);

      let allow = true;
      database.setAuthorizer(() => (allow ? constants.SQLITE_OK : constants.SQLITE_DENY));
      for (let index = 0; index < 3; index += 1) {
        expect(readSqliteDataVersion(database)).toBe(version);
      }
      expect(prepare).toHaveBeenCalledTimes(5);
      allow = false;
      expect(() => readSqliteDataVersion(database)).toThrow(/not authorized/iu);
      allow = true;
      expect(readSqliteDataVersion(database)).toBe(version);
      expect(prepare).toHaveBeenCalledTimes(7);

      database.setAuthorizer(null);
      for (let index = 0; index < 3; index += 1) {
        expect(readSqliteDataVersion(database)).toBe(version);
      }
      expect(prepare).toHaveBeenCalledTimes(9);
    },
  );

  it("readmits an evicted scalar and retires it with its physical connection", () => {
    const pathname = path.join(tempDirs.make("sqlite-version-close-"), "state.sqlite");
    const database = openDatabase(pathname);
    enableNodeSqliteKyselyStatementCache(database);
    const prepare = vi.spyOn(database, "prepare");
    const version = readSqliteDataVersion(database);
    expect(readSqliteDataVersion(database)).toBe(version);
    expect(readSqliteDataVersion(database)).toBe(version);
    expect(prepare.mock.calls.filter(([sql]) => sql === "PRAGMA data_version")).toHaveLength(2);

    for (let index = 0; index < 32; index += 1) {
      const sql = `SELECT ${index} AS value`;
      for (let admission = 0; admission < 2; admission += 1) {
        expect(
          executeWithCachedStatement(database, sql, [], (statement) => statement.get()),
        ).toEqual({
          value: index,
        });
      }
    }
    for (let index = 0; index < 3; index += 1) {
      expect(readSqliteDataVersion(database)).toBe(version);
    }
    expect(prepare.mock.calls.filter(([sql]) => sql === "PRAGMA data_version")).toHaveLength(4);
    database.close();
    expect(() => readSqliteDataVersion(database)).toThrow();

    const reopened = openDatabase(pathname);
    enableNodeSqliteKyselyStatementCache(reopened);
    const reopenedPrepare = vi.spyOn(reopened, "prepare");
    const reopenedVersion = readSqliteDataVersion(reopened);
    expect(readSqliteDataVersion(reopened)).toBe(reopenedVersion);
    expect(readSqliteDataVersion(reopened)).toBe(reopenedVersion);
    expect(reopenedPrepare).toHaveBeenCalledTimes(2);
  });
});
