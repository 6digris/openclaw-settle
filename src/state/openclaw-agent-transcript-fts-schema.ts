import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldBetweenBatches } from "node:timers/promises";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { assertAgentDatabaseMaintenanceAuthority } from "./openclaw-agent-db-lease.js";
import type { DB } from "./openclaw-agent-db.generated.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

type TranscriptFtsDatabase = Pick<
  DB,
  "session_transcript_fts_rows" | "session_transcript_index_state"
> & {
  session_transcript_fts: DB["session_transcript_fts"] & { rowid: number };
};
const FTS_PREPARATION_ROWS = 512;

function pendingMappings(database: DatabaseSync) {
  return getNodeSqliteKysely<TranscriptFtsDatabase>(database)
    .selectFrom("session_transcript_index_state")
    .select("session_id")
    .where("needs_rebuild", "!=", 0)
    .where("fts_row_count", "is", null);
}

/** This is mapping coverage, not transcript freshness; only reconciliation clears dirtiness. */
export function hasPendingTranscriptFtsMappings(database: DatabaseSync): boolean {
  return (
    tableHasColumn(database, "session_transcript_index_state", "fts_row_count") &&
    executeSqliteQuerySync(database, pendingMappings(database).limit(1)).rows.length > 0
  );
}

/** Prepare legacy ownership once under offline maintenance, rather than scanning FTS per session. */
export async function prepareTranscriptFtsMappingsForMaintenance(
  database: DatabaseSync,
  pathname: string,
  maintenance: OpenClawStateLeaseContext,
): Promise<void> {
  const assertOwned = () => {
    maintenance.signal.throwIfAborted();
    assertAgentDatabaseMaintenanceAuthority(maintenance);
  };
  assertOwned();
  if (!hasPendingTranscriptFtsMappings(database)) {
    return;
  }
  const identity = readDatabasePathIdentitySync(pathname).key;
  const kysely = getNodeSqliteKysely<TranscriptFtsDatabase>(database);
  const commit = <T>(operation: () => T): T => {
    assertOwned();
    assertExistingDatabaseIdentity(pathname, identity);
    return runSqliteImmediateTransactionSync(
      database,
      () => {
        assertOwned();
        const result = operation();
        assertOwned();
        return result;
      },
      { databaseLabel: pathname, operationLabel: "agent.transcript-fts.prepare" },
    );
  };
  let afterRowId: number | undefined;
  while (true) {
    const last = commit(() => {
      let query = kysely
        .selectFrom("session_transcript_fts")
        .select(["rowid", "session_id"])
        .orderBy("rowid")
        .limit(FTS_PREPARATION_ROWS);
      if (afterRowId !== undefined) {
        query = query.where("rowid", ">", afterRowId);
      }
      const rows = executeSqliteQuerySync(database, query).rows;
      if (!rows.length) {
        return undefined;
      }
      const mappings = executeSqliteQuerySync(
        database,
        kysely
          .selectFrom("session_transcript_fts_rows")
          .select(["fts_rowid", "session_id"])
          .where(
            "fts_rowid",
            "in",
            rows.map((row) => row.rowid),
          ),
      ).rows;
      const owners = new Map(mappings.map((row) => [row.fts_rowid, row.session_id]));
      const ids = [
        ...new Set(
          [...rows, ...mappings].flatMap((row) =>
            row.session_id === null ? [] : [row.session_id],
          ),
        ),
      ];
      const pending = new Set(
        executeSqliteQuerySync(
          database,
          pendingMappings(database).where("session_id", "in", ids),
        ).rows.map((row) => row.session_id),
      );
      const missing: Array<{ session_id: string; fts_rowid: number }> = [];
      for (const row of rows) {
        const owner = owners.get(row.rowid);
        // A conflicting mapping into a complete sibling must not become deletion authority.
        if (
          owner !== undefined &&
          owner !== row.session_id &&
          (pending.has(owner) || (row.session_id !== null && pending.has(row.session_id)))
        ) {
          throw new Error("Legacy transcript FTS mapping has conflicting session ownership");
        }
        if (owner === undefined && row.session_id !== null && pending.has(row.session_id)) {
          missing.push({ session_id: row.session_id, fts_rowid: row.rowid });
        }
      }
      if (missing.length) {
        executeSqliteQuerySync(
          database,
          kysely.insertInto("session_transcript_fts_rows").values(missing),
        );
      }
      return rows.at(-1)!.rowid;
    });
    if (last === undefined) {
      break;
    }
    afterRowId = last;
    await yieldBetweenBatches();
  }
  // Counts remain unknown until the entire FTS keyspace has been visited under this
  // same exclusive owner. Interrupted passes retain exact mappings and restart safely.
  let afterSessionId: string | undefined;
  while (true) {
    const sessions = commit(() => {
      let query = pendingMappings(database).orderBy("session_id").limit(FTS_PREPARATION_ROWS);
      if (afterSessionId !== undefined) {
        query = query.where("session_id", ">", afterSessionId);
      }
      return executeSqliteQuerySync(database, query).rows;
    });
    if (!sessions.length) {
      break;
    }
    for (const { session_id: sessionId } of sessions) {
      let count = 0;
      let afterMapping: number | undefined;
      while (true) {
        const last = commit(() => {
          // Bound rows, not just sessions: one transcript can own millions of mappings.
          let query = kysely
            .selectFrom("session_transcript_fts_rows")
            .select("fts_rowid")
            .where("session_id", "=", sessionId)
            .orderBy("fts_rowid")
            .limit(FTS_PREPARATION_ROWS);
          if (afterMapping !== undefined) {
            query = query.where("fts_rowid", ">", afterMapping);
          }
          const rows = executeSqliteQuerySync(database, query).rows;
          count += rows.length;
          if (!rows.length) {
            executeSqliteQuerySync(
              database,
              kysely
                .updateTable("session_transcript_index_state")
                .set({ fts_row_count: count })
                .where("session_id", "=", sessionId),
            );
          }
          return rows.at(-1)?.fts_rowid;
        });
        if (last === undefined) {
          break;
        }
        afterMapping = last;
        await yieldBetweenBatches();
      }
    }
    afterSessionId = sessions.at(-1)!.session_id;
    await yieldBetweenBatches();
  }
}

function transcriptFtsRowsSchemaSql(schema: string): string {
  return extractSqliteTableSchema(schema, "session_transcript_fts_rows", {
    endMarker: "CREATE VIRTUAL TABLE IF NOT EXISTS session_transcript_fts USING fts5(",
    includeEndMarker: false,
  });
}

/** Older migration preflights must compare the schema before exact FTS row ownership. */
export function withoutTranscriptFtsRowSchema(schema: string): string {
  if (!schema.includes("CREATE TABLE IF NOT EXISTS session_transcript_fts_rows (")) {
    return schema;
  }
  return schema
    .replace(transcriptFtsRowsSchemaSql(schema), "")
    .replace("  fts_row_count INTEGER,\n", "");
}

/** Leave existing FTS bytes intact; the projection owner heals each session lazily. */
export function migrateTranscriptFtsRowSchema(database: DatabaseSync): void {
  // sqlite-allow-raw -- Install canonical DDL in the versioned schema migration.
  database.exec(transcriptFtsRowsSchemaSql(OPENCLAW_AGENT_SCHEMA_SQL));
  if (!tableHasColumn(database, "session_transcript_index_state", "fts_row_count")) {
    // sqlite-allow-raw -- Add the migration-owned nullable completeness fact.
    database.exec("ALTER TABLE session_transcript_index_state ADD COLUMN fts_row_count INTEGER;");
  }
  // sqlite-allow-raw -- Invalidate legacy derived state once during schema migration.
  database.exec(
    "UPDATE session_transcript_index_state SET needs_rebuild = 1, fts_row_count = NULL;",
  );
}
