import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readMigrationArtifactIdentity } from "../commands/doctor-session-sqlite-artifact.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { DeferredPluginSessionImport } from "./deferred-plugin-session-sources.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import {
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import {
  readSessionGroupLegacyIndex,
  wasSessionGroupSourceImported,
} from "./state-migrations.session-group-sources.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

describe("session group legacy index projection", () => {
  it("does not JSON-decode saved prompts and leaves the source unchanged", () => {
    const pathname = path.join(tempDirs.make("group-index-"), "sessions.json");
    const bytes = JSON.stringify({
      "agent:alpha:main": {
        sessionId: "fixture",
        category: " Work ",
        skillsSnapshot: { prompt: "must-not-decode" },
      },
      "agent:alpha:uncategorized": { sessionId: "uncategorized" },
      "agent:alpha:cleared": { sessionId: "cleared", category: null },
    });
    fs.writeFileSync(pathname, bytes);
    const parse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (text.includes("must-not-decode")) {
        throw new Error("saved prompt decoded");
      }
      return parse(text, reviver);
    });
    const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
    const source = fs.statSync(pathname);
    expect(readSessionGroupLegacyIndex(pathname)).toEqual({
      entries: [
        { sessionKey: "agent:alpha:cleared", category: "" },
        { sessionKey: "agent:alpha:main", category: "Work" },
        { sessionKey: "agent:alpha:uncategorized", category: "" },
      ],
      sourceSha256,
      identity: `${source.dev}:${source.ino}:${sourceSha256}`,
    });
    expect(fs.readFileSync(pathname, "utf8")).toBe(bytes);
  });

  it.each([
    "not json",
    "[]",
    '{"agent:alpha:main":null}',
    '{"agent:alpha:main":{"category":"Work"}}',
    '{"agent:alpha:main":{"sessionId":" ","category":"Work"}}',
    '{"agent:alpha:main":{"sessionId":"s","category":42}}',
  ])("rejects malformed metadata without changing it: %s", (bytes) => {
    const pathname = path.join(tempDirs.make("group-index-invalid-"), "sessions.json");
    fs.writeFileSync(pathname, bytes);
    expect(() => readSessionGroupLegacyIndex(pathname)).toThrow(/Invalid legacy session/);
    expect(fs.readFileSync(pathname, "utf8")).toBe(bytes);
  });
});

const corpusRoot = new URL(
  "../../test/fixtures/state-corpus/2026.9.3-95f3ed9/state/",
  import.meta.url,
);

function createReceiptFixture() {
  const root = tempDirs.make("group-index-receipt-");
  const databasePath = path.join(root, "state.sqlite");
  const sqlitePath = path.join(root, "agent.sqlite");
  const storePath = path.join(root, "sessions.json");
  // Released schema-17 state, not an ad hoc receipt schema or a schema-18 fixture.
  fs.copyFileSync(new URL("state/openclaw.sqlite", corpusRoot), databasePath);
  fs.copyFileSync(new URL("agents/main/agent/openclaw-agent.sqlite", corpusRoot), sqlitePath);
  fs.writeFileSync(storePath, '{"agent:main:fixture":{"sessionId":"fixture","category":"Work"}}');
  const index = readMigrationArtifactIdentity(storePath);
  const target = fs.lstatSync(sqlitePath, { bigint: true });
  const report: DeferredPluginSessionImport = {
    databaseIdentity: `${target.dev}:${target.ino}`,
    pluginIds: ["fixture-plugin"],
    sources: [{ path: storePath, identity: index }],
  };
  const sourceKey = resolveLegacyMigrationSourceKey(
    "deferred-plugin-session-import",
    storePath,
    `main\0${path.resolve(sqlitePath)}`,
  );
  return {
    root,
    databasePath,
    sqlitePath,
    storePath,
    sourceSha256: index.sha256,
    agentId: "main",
    receipt: {
      sourceKey,
      migrationKind: "deferred-plugin-session-import",
      sourcePath: storePath,
      targetTable: "session_nodes",
      sourceSha256: index.sha256,
      sourceSizeBytes: index.size,
      sourceRecordCount: 1,
      runId: sourceKey,
      now: 123,
      reportJson: JSON.stringify(report),
    },
  };
}

function seedReceipt(
  fixture: ReturnType<typeof createReceiptFixture>,
  reportJson = fixture.receipt.reportJson,
) {
  const database = openNodeSqliteDatabase(fixture.databasePath);
  try {
    runSqliteImmediateTransactionSync(database, () => {
      recordLegacyMigrationReceipt(database, { ...fixture.receipt, reportJson });
    });
  } finally {
    // Finish writer checkpoint/close before capturing whole-file preservation evidence.
    database.close();
  }
}

function readReceiptRows(database: DatabaseSync) {
  const query = getNodeSqliteKysely<DB>(database);
  return {
    runs: executeSqliteQuerySync(
      database,
      query.selectFrom("migration_runs").selectAll().orderBy("id"),
    ).rows,
    sources: executeSqliteQuerySync(
      database,
      query.selectFrom("migration_sources").selectAll().orderBy("source_key"),
    ).rows,
  };
}

function expectReadOnlyClassification(
  fixture: ReturnType<typeof createReceiptFixture>,
  verify: (database: DatabaseSync) => void,
) {
  const files = fs.readdirSync(fixture.root).toSorted();
  const hashes = () =>
    files.map((file) =>
      createHash("sha256")
        .update(fs.readFileSync(path.join(fixture.root, file)))
        .digest("hex"),
    );
  const before = hashes();
  const database = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(fixture.databasePath), {
    readOnly: true,
  });
  try {
    expect(readSqliteUserVersion(database)).toBe(17);
    const rows = readReceiptRows(database);
    verify(database);
    expect(readReceiptRows(database)).toEqual(rows);
  } finally {
    database.close();
  }
  // Compare closed files so SQLite WAL housekeeping cannot masquerade as adapter writes.
  expect(fs.readdirSync(fixture.root).toSorted()).toEqual(files);
  expect(hashes()).toEqual(before);
  for (const file of [fixture.databasePath, fixture.sqlitePath]) {
    expect(fs.existsSync(file + "-wal")).toBe(false);
    expect(fs.existsSync(file + "-shm")).toBe(false);
  }
}

describe("session group retained import classification", () => {
  it("reports an absent receipt without probing or creating a destination", () => {
    const fixture = createReceiptFixture();
    fs.unlinkSync(fixture.sqlitePath);
    expectReadOnlyClassification(fixture, (database) => {
      expect(wasSessionGroupSourceImported({ ...fixture, database })).toBe(false);
    });
    expect(fs.existsSync(fixture.sqlitePath)).toBe(false);
  });

  it("matches the source hash and physical target without reading transcript content", () => {
    const fixture = createReceiptFixture();
    seedReceipt(fixture);
    expectReadOnlyClassification(fixture, (database) => {
      const readFile = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
        throw new Error("Receipt classification must not read source or transcript content");
      });
      try {
        expect(wasSessionGroupSourceImported({ ...fixture, database })).toBe(true);
        expect(wasSessionGroupSourceImported({ ...fixture, database, agentId: "other" })).toBe(
          false,
        );
        expect(
          wasSessionGroupSourceImported({
            ...fixture,
            database,
            sqlitePath: path.join(fixture.root, "other.sqlite"),
          }),
        ).toBe(false);
        expect(readFile).not.toHaveBeenCalled();
      } finally {
        readFile.mockRestore();
      }
    });
  });

  it("refuses a changed retained source hash without changing its receipt", () => {
    const fixture = createReceiptFixture();
    seedReceipt(fixture);
    fs.writeFileSync(
      fixture.storePath,
      '{"agent:main:fixture":{"sessionId":"fixture","category":"Changed"}}',
    );
    const sourceSha256 = readSessionGroupLegacyIndex(fixture.storePath).sourceSha256;
    expect(sourceSha256).not.toBe(fixture.sourceSha256);
    expectReadOnlyClassification(fixture, (database) => {
      expect(() => wasSessionGroupSourceImported({ ...fixture, database, sourceSha256 })).toThrow(
        /Retained imported session index changed/,
      );
    });
  });

  it("refuses a byte-identical replacement destination with a different physical identity", () => {
    const fixture = createReceiptFixture();
    seedReceipt(fixture);
    const retainedPath = path.join(fixture.root, "retained-agent.sqlite");
    fs.renameSync(fixture.sqlitePath, retainedPath);
    fs.copyFileSync(retainedPath, fixture.sqlitePath);
    expect(fs.statSync(fixture.sqlitePath, { bigint: true }).ino).not.toBe(
      fs.statSync(retainedPath, { bigint: true }).ino,
    );
    expectReadOnlyClassification(fixture, (database) => {
      expect(() => wasSessionGroupSourceImported({ ...fixture, database })).toThrow(
        /Retained imported session index changed/,
      );
    });
  });

  it.each(["not json", "null", "[]", "{}", '{"databaseIdentity":42}'])(
    "rejects malformed receipt metadata without repairing it: %s",
    (reportJson) => {
      const fixture = createReceiptFixture();
      seedReceipt(fixture, reportJson);
      expectReadOnlyClassification(fixture, (database) => {
        expect(() => wasSessionGroupSourceImported({ ...fixture, database })).toThrow();
      });
    },
  );
});
