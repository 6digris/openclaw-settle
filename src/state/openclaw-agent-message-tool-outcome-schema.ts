import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { MESSAGE_TOOL_RUN_OUTCOMES_TABLE } from "./openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

const ENSURED_DATABASES = new WeakSet<DatabaseSync>();

/** Lazily installs the additive outcome table on first use. */
export function ensureMessageToolRunOutcomeSchema(db: DatabaseSync): void {
  if (ENSURED_DATABASES.has(db)) {
    return;
  }
  runSqliteImmediateTransactionSync(db, () => {
    // sqlite-allow-raw -- Canonical additive DDL only.
    db.exec(
      extractSqliteTableSchema(OPENCLAW_AGENT_SCHEMA_SQL, MESSAGE_TOOL_RUN_OUTCOMES_TABLE, {
        endMarker: "CREATE TABLE IF NOT EXISTS session_goal_operations (",
        includeEndMarker: false,
        errorMessage: "OpenClaw message-tool run outcome schema markers are missing.",
      }),
    );
  });
  ENSURED_DATABASES.add(db);
}
