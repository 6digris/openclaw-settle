import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-schema-validation.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { assertOpenClawAgentDatabaseForRuntime } from "./sqlite-agent-schema.js";

describe("SQLite agent schema entrypoint", () => {
  it("keeps connection lifecycle and schema mutation owners outside its import closure", () => {
    expect(
      findSourceImportBackedges("src/plugin-sdk/sqlite-agent-schema.ts", [
        "src/state/openclaw-agent-db.ts",
        "src/state/openclaw-agent-db-maintenance.ts",
        "src/state/openclaw-agent-db-schema.ts",
        "src/state/openclaw-agent-db-lease.ts",
        "src/state/openclaw-state-db.ts",
        "src/infra/sqlite-transaction.ts",
      ]),
    ).toEqual([]);
  });

  it.each([
    {
      name: "retired storage still accepted for maintenance",
      sql: "CREATE TABLE state_leases (legacy TEXT);",
      expected: /retains retired state_leases storage/,
      maintenanceCompatible: true,
    },
    {
      name: "a newer physical version with current metadata",
      sql: `PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`,
      expected: /uses newer schema version/,
      maintenanceCompatible: false,
    },
  ])("rejects $name without changing the caller's transaction", (fault) => {
    const database = new DatabaseSync(":memory:");
    const options = { agentId: "main", pathname: "agent.sqlite" };
    try {
      database.exec(OPENCLAW_AGENT_SCHEMA_SQL);
      database.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION};`);
      database
        .prepare(
          "INSERT INTO schema_meta(meta_key,role,schema_version,agent_id,created_at,updated_at) VALUES('primary','agent',?,'main',1,1)",
        )
        .run(OPENCLAW_AGENT_SCHEMA_VERSION);
      expect(() => assertOpenClawAgentDatabaseForRuntime(database, options)).not.toThrow();
      database.exec(fault.sql);
      if (fault.maintenanceCompatible) {
        expect(() => assertOpenClawAgentDatabaseForMaintenance(database, options)).not.toThrow();
      }
      const changes = database.prepare("SELECT total_changes() AS n").get();
      database.exec("PRAGMA query_only=ON; BEGIN;");
      expect(() => assertOpenClawAgentDatabaseForRuntime(database, options)).toThrow(
        fault.expected,
      );
      expect(database.isTransaction).toBe(true);
      expect(database.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
    } finally {
      database.close();
    }
  });
});
