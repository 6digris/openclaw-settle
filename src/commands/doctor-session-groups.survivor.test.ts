import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  assertSessionGroupCatalog,
  seedSessionGroupCatalog,
} from "../../scripts/e2e/lib/upgrade-survivor/session-group-catalog.mjs";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { migrateDoctorSessionGroups } from "./doctor-session-groups.js";

const roots: string[] = [];
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(roots);
});

it("qualifies the published-updater group observer without claiming a published driver ran", async () => {
  const root = makeTempDir(roots, "group-survivor-observer-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: root };
  for (const agentId of ["main", "ops"]) {
    openOpenClawAgentDatabase({ env, agentId });
  }
  closeOpenClawAgentDatabasesForTest();
  const statePath = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  const state = openNodeSqliteDatabase(statePath);
  state.exec(
    "DROP TABLE agent_session_groups; PRAGMA user_version=17; UPDATE schema_meta SET schema_version=17 WHERE meta_key='primary'; DELETE FROM config_machine_state WHERE state_key='state.schema.contentVersion';",
  );
  state.close();
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ version: "2026.9.4", openclaw: { schemaVersions: { state: 17 } } }),
  );
  seedSessionGroupCatalog(root, root, root);
  expect(() => assertSessionGroupCatalog(root)).toThrow();
  await migrateDoctorSessionGroups(
    {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {} },
        defaults: { systemAgent: { agentId: "main" } },
      },
    },
    env,
  );
  expect(() => assertSessionGroupCatalog(root)).not.toThrow();
  expect(
    JSON.parse(fs.readFileSync(path.join(root, "session-group-catalog-result.json"), "utf8")),
  ).toMatchObject({ status: "passed", rows: 3 });
  const db = openOpenClawStateDatabase({ env }).db;
  db.prepare("UPDATE agent_session_groups SET cwd='/wrong' WHERE agent_id='ops'").run();
  expect(() => assertSessionGroupCatalog(root)).toThrow();
});
