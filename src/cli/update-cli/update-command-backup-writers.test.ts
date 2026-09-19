import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  AGENT_DATABASE_MAINTENANCE_LEASE,
  claimOpenClawAgentDatabaseLease,
  releaseOpenClawAgentDatabaseLease,
} from "../../state/openclaw-agent-db-lease.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withUpdateBackupWriterExclusion } from "./update-command-backup-writers.js";

it("holds transactional writer admission through deletion and releases it afterwards", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    const params = { agentId: "late", path: state.path("late.sqlite"), env: state.env };
    await withUpdateBackupWriterExclusion(
      { root: state.root, env: state.env },
      async (assertOwned) => {
        await Promise.resolve();
        assertOwned();
        expect(() => claimOpenClawAgentDatabaseLease(params)).toThrow("maintenance is in progress");
        assertOwned();
      },
    );
    const lease = claimOpenClawAgentDatabaseLease(params);
    releaseOpenClawAgentDatabaseLease(lease, { env: state.env });
  });
});

it("revokes deletion authority if its maintenance lease is replaced across an await", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    await expect(
      withUpdateBackupWriterExclusion({ root: state.root, env: state.env }, async (assertOwned) => {
        assertOwned();
        const db = new DatabaseSync(resolveOpenClawStateSqlitePath(state.env));
        try {
          db.prepare("UPDATE state_leases SET owner = ? WHERE scope = ? AND lease_key = ?").run(
            "replacement",
            AGENT_DATABASE_MAINTENANCE_LEASE.scope,
            AGENT_DATABASE_MAINTENANCE_LEASE.key,
          );
        } finally {
          db.close();
        }
        await Promise.resolve();
        assertOwned();
      }),
    ).rejects.toThrow(/lost|owner/i);
  });
});
