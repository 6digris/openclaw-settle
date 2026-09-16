import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { STANDING_INTENTS_TABLE } from "./openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

type StandingIntentColumnInfo = { name?: unknown };

function ensureStandingIntentCreatorColumn(db: DatabaseSync): void {
  const columns = /* sqlite-allow-raw -- Canonical additive schema inspection only. */ db
    .prepare("PRAGMA table_info(standing_intents)")
    .all() as StandingIntentColumnInfo[];
  if (columns.some((column) => column.name === "creator_sender")) {
    return;
  }
  // sqlite-allow-raw -- Unreleased additive column migration.
  db.exec(
    "ALTER TABLE standing_intents ADD COLUMN creator_sender TEXT " +
      "CHECK (creator_sender IS NULL OR length(trim(creator_sender)) > 0)",
  );
}

/** Lazily add the canonical standing-intents tables on first feature use. */
export function ensureOpenClawAgentStandingIntentsSchema(db: DatabaseSync): void {
  const ensure = () => {
    // sqlite-allow-raw -- Canonical additive DDL only.
    db.exec(
      extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, STANDING_INTENTS_TABLE, {
        endMarker: "CREATE TABLE IF NOT EXISTS session_transcript_index_state (",
        includeEndMarker: false,
        errorMessage: "OpenClaw standing-intents schema markers are missing.",
      }),
    );
    ensureStandingIntentCreatorColumn(db);
  };
  if (db.isTransaction) {
    ensure();
    return;
  }
  runSqliteImmediateTransactionSync(db, ensure);
}
