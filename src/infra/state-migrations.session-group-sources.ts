/** Metadata-only projection of the existing deferred-import receipt contract. */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import { readLegacyMigrationSourceSnapshotSync } from "./state-migrations.source-snapshot.js";

/**
 * Group migration consumes only the index, not transcript import/cleanup authority.
 * The exact source hash and destination identity prove the retained index was
 * acknowledged; checking every transcript here would read history to find categories.
 * Keep this adapter aligned with deferred-plugin-session-sources.ts's sourceKey contract.
 */
export function wasSessionGroupSourceImported(params: {
  database: DatabaseSync;
  agentId: string;
  storePath: string;
  sqlitePath: string;
  sourceSha256: string;
}): boolean {
  const key = resolveLegacyMigrationSourceKey(
    "deferred-plugin-session-import",
    params.storePath,
    `${params.agentId}\0${path.resolve(params.sqlitePath)}`,
  );
  const receipt = readLegacyMigrationReceiptFromDatabase(params.database, key);
  if (!receipt) {
    return false;
  }
  const report: unknown = JSON.parse(receipt.reportJson);
  const target = fs.lstatSync(params.sqlitePath, { bigint: true });
  if (
    !isRecord(report) ||
    !target.isFile() ||
    report.databaseIdentity !== `${target.dev}:${target.ino}` ||
    receipt.sourceSha256 !== params.sourceSha256
  ) {
    throw new Error(
      `Retained imported session index changed: ${params.storePath}; repair its import before migrating groups.`,
    );
  }
  return true;
}

/** SQLite projects the retired index without allocating saved prompt objects in JavaScript. */
export function readSessionGroupLegacyIndex(storePath: string) {
  const snapshot = readLegacyMigrationSourceSnapshotSync({
    sourcePath: storePath,
    label: "session group index",
    followSymlinks: true,
  });
  const database = openNodeSqliteDatabase(":memory:");
  try {
    // sqlite-allow-raw -- Ephemeral migration projection, not an alternate persisted store.
    const root = database
      .prepare(
        "SELECT json_valid(?) AS valid, CASE WHEN json_valid(?) THEN json_type(?) END AS kind",
      )
      .get(snapshot.raw, snapshot.raw, snapshot.raw);
    if (root?.valid !== 1 || root.kind !== "object") {
      throw new Error(`Invalid legacy session index at ${storePath}`);
    }
    // sqlite-allow-raw -- Only metadata fields cross the query boundary; no transcript or prompt decode.
    const rows = database
      .prepare(`SELECT key AS session_key, type AS entry_type,
      CASE WHEN type='object' THEN json_type(value, '$.sessionId') END AS id_type,
      CASE WHEN type='object' THEN json_extract(value, '$.sessionId') END AS session_id,
      CASE WHEN type='object' THEN json_type(value, '$.category') END AS category_type,
      CASE WHEN type='object' THEN json_extract(value, '$.category') END AS category
      FROM json_each(?) ORDER BY key`)
      .all(snapshot.raw);
    const entries = rows.map((row) => {
      if (
        typeof row.session_key !== "string" ||
        row.entry_type !== "object" ||
        row.id_type !== "text" ||
        typeof row.session_id !== "string" ||
        !row.session_id.trim() ||
        (row.category_type !== null && row.category_type !== "null" && row.category_type !== "text")
      ) {
        throw new Error(`Invalid legacy session category metadata at ${storePath}`);
      }
      return {
        sessionKey: row.session_key,
        category: typeof row.category === "string" ? row.category.trim() : "",
      };
    });
    return {
      entries,
      sourceSha256: snapshot.sha256,
      identity: `${snapshot.dev}:${snapshot.ino}:${snapshot.sha256}`,
    };
  } finally {
    database.close();
  }
}
