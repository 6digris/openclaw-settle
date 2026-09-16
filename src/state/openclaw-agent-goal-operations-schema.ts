import type { DatabaseSync } from "node:sqlite";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { SESSION_GOAL_OPERATIONS_TABLE } from "./openclaw-agent-db-contract.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

const ensuredDatabases = new WeakSet<DatabaseSync>();

/** First typed Goal use installs the additive receipt table, without a version bump. */
export function ensureSessionGoalOperationsSchema(db: DatabaseSync): void {
  if (ensuredDatabases.has(db)) {
    return;
  }
  const schema = extractSqliteTableSchema(
    OPENCLAW_AGENT_SCHEMA_SQL,
    SESSION_GOAL_OPERATIONS_TABLE,
    {
      endMarker: "CREATE TABLE IF NOT EXISTS transcript_events (",
      includeEndMarker: false,
      errorMessage: "OpenClaw Goal operation schema markers are missing.",
    },
  );
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(schema); // sqlite-allow-raw -- Canonical additive DDL only.
  });
  ensuredDatabases.add(db);
}

export { SESSION_GOAL_OPERATIONS_TABLE } from "./openclaw-agent-db-contract.js";
