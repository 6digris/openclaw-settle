import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { migrateDoctorSessionGroups } from "../commands/doctor-session-groups.js";
import {
  claimCompletedAgentDeletionJournal,
  readAgentDeletionJournal,
} from "./agent-deletion-journal.js";
import { readAgentProvenance, recordAgentProvenance } from "./agent-provenance.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  SESSION_GROUP_MIGRATION_KEY,
  sessionGroupSectionOrderKey,
} from "./session-group-ownership.js";

const roots: string[] = [];
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(roots);
});

async function fixture() {
  const root = fs.realpathSync(makeTempDir(roots, "agent-delete-groups-"));
  const options = { env: { OPENCLAW_STATE_DIR: root } };
  await migrateDoctorSessionGroups({ agents: { entries: { removed: {}, kept: {} } } }, options.env);
  const state = openOpenClawStateDatabase(options);
  state.db.prepare("INSERT INTO session_groups VALUES('Legacy',0,1,NULL,NULL)").run();
  state.db
    .prepare(
      "INSERT INTO config_machine_state VALUES('sidebar.sectionOrder','[\"category:Legacy\"]',1)",
    )
    .run();
  for (const agentId of ["removed", "kept"]) {
    recordAgentProvenance(agentId, { createdVia: "operator" }, options);
    state.db
      .prepare("INSERT INTO agent_session_groups VALUES(?,?,0,12,NULL,0)")
      .run(agentId, "Shared");
    state.db
      .prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?")
      .run('["category:Shared"]', sessionGroupSectionOrderKey(agentId));
  }
  const entry = {
    agentId: "removed",
    agentDir: path.join(root, "agents", "removed", "agent"),
    sessionsDir: path.join(root, "agents", "removed", "sessions"),
    workspaceDir: path.join(root, "workspace-removed"),
  };
  const rows = () => state.db.prepare("SELECT * FROM agent_session_groups ORDER BY agent_id").all();
  const order = (agentId: string) =>
    state.db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key=?")
      .get(sessionGroupSectionOrderKey(agentId));
  return { root, options, state, entry, rows, order };
}

describe("agent deletion owns group cleanup", () => {
  it("refuses deletion before the legacy catalog has classified its owners", async () => {
    const f = await fixture();
    f.state.db
      .prepare("DELETE FROM config_machine_state WHERE state_key=?")
      .run(SESSION_GROUP_MIGRATION_KEY);
    let entered = false;
    expect(() =>
      withAgentDeletion(
        "removed",
        async () => {
          entered = true;
        },
        f.options,
      ),
    ).toThrow("migration is incomplete");
    expect(entered).toBe(false);
    expect(readAgentDeletionJournal("removed", f.options)).toBeUndefined();
    expect(f.rows()).toHaveLength(2);
  });
  it("preserves failed purge state; successful recovery removes only its agent and cannot affect a recreated id", async () => {
    const f = await fixture();
    const before = f.rows();
    const receipt = f.state.db
      .prepare("SELECT value_json FROM config_machine_state WHERE state_key=?")
      .get(SESSION_GROUP_MIGRATION_KEY);
    let stale: { finish(): void } | undefined;
    await expect(
      withAgentDeletion(
        "removed",
        async (begin) => {
          stale = begin(f.entry);
          throw new Error("purge failed");
        },
        f.options,
      ),
    ).rejects.toThrow("purge failed");
    expect(f.rows()).toEqual(before);
    expect(f.order("removed")).toBeDefined();
    expect(readAgentDeletionJournal("removed", f.options)?.cleanupCompleted).toBe(false);

    const completed = await withAgentDeletion(
      "removed",
      async (begin) => {
        const deletion = begin(f.entry);
        expect(() => stale?.finish()).toThrow(/no longer owns/);
        runOpenClawStateWriteTransaction(deletion.completeInTransaction, f.options);
        return deletion;
      },
      f.options,
    );
    expect(f.rows()).toEqual(before.filter((row) => row.agent_id === "kept"));
    expect(f.order("removed")).toBeUndefined();
    expect(f.order("kept")).toEqual({ value_json: '["category:Shared"]' });
    expect(f.state.db.prepare("SELECT name FROM session_groups").all()).toEqual([
      { name: "Legacy" },
    ]);
    expect(
      f.state.db
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key='sidebar.sectionOrder'",
        )
        .get(),
    ).toEqual({ value_json: '["category:Legacy"]' });
    expect(
      f.state.db
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key=?")
        .get(SESSION_GROUP_MIGRATION_KEY),
    ).toEqual(receipt);
    expect(readAgentProvenance("removed", f.options)).toBeUndefined();
    expect(readAgentProvenance("kept", f.options)).toBeDefined();

    expect(
      claimCompletedAgentDeletionJournal("removed", completed.entry.operationId, f.options),
    ).toBe(true);
    f.state.db
      .prepare("INSERT INTO agent_session_groups VALUES('removed','Recreated',0,20,NULL,NULL)")
      .run();
    expect(() => completed.finish()).toThrow(/no longer owns/);
    expect(f.rows().some((row) => row.name === "Recreated")).toBe(true);
  });

  it("rolls catalog, scoped order, provenance and completion back together when cleanup fails", async () => {
    const f = await fixture();
    const before = f.rows();
    f.state.db
      .exec(`CREATE TEMP TRIGGER fail_group_order_cleanup BEFORE DELETE ON config_machine_state
      WHEN OLD.state_key='sidebar.sectionOrder.agent:removed' BEGIN SELECT RAISE(ABORT,'order cleanup failed'); END;`);
    await withAgentDeletion(
      "removed",
      async (begin) => {
        const deletion = begin(f.entry);
        expect(() =>
          runOpenClawStateWriteTransaction(deletion.completeInTransaction, f.options),
        ).toThrow("order cleanup failed");
        expect(f.rows()).toEqual(before);
        expect(f.order("removed")).toBeDefined();
        expect(readAgentProvenance("removed", f.options)).toBeDefined();
        expect(readAgentDeletionJournal("removed", f.options)?.cleanupCompleted).toBe(false);
        f.state.db.exec("DROP TRIGGER fail_group_order_cleanup");
        runOpenClawStateWriteTransaction(deletion.completeInTransaction, f.options);
      },
      f.options,
    );
    expect(f.rows()).toEqual(before.filter((row) => row.agent_id === "kept"));
  });
});
