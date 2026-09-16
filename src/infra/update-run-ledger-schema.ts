import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
const schemaStart = OPENCLAW_STATE_SCHEMA_SQL.indexOf("CREATE TABLE IF NOT EXISTS update_runs (");
const schemaEndMarker = "ON update_runs(status, created_at_ms DESC, run_id);";
const schemaEnd = OPENCLAW_STATE_SCHEMA_SQL.indexOf(schemaEndMarker, schemaStart);
if (schemaStart < 0 || schemaEnd < 0) {
  throw new Error("Update run schema markers are missing");
}
export const updateRunLedgerSchema = OPENCLAW_STATE_SCHEMA_SQL.slice(
  schemaStart,
  schemaEnd + schemaEndMarker.length,
);
