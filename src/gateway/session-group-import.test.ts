import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDoctorSessionGroups } from "../commands/doctor-session-groups.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { deleteSessionGroup, listSessionGroups, putSessionGroups } from "./session-groups.js";

describe("legacy client session group import", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  const cfg: OpenClawConfig = {};

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-session-groups-"));
    env = {
      ...process.env,
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    };
    await migrateDoctorSessionGroups(cfg, env);
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("does not resurrect a deleted imported name after an uncertain acknowledgement and reopen", async () => {
    const input = {
      cfg,
      agentId: "main",
      names: ["Legacy"],
      append: true,
      importId: "browser-import-one",
      env,
    };
    putSessionGroups(input);
    await deleteSessionGroup({ cfg, agentId: "main", name: "Legacy", env });
    closeOpenClawStateDatabaseForTest();
    expect(putSessionGroups(input)).toEqual([]);
    expect(putSessionGroups({ ...input, names: [" Legacy ", "New local name"] })).toEqual([
      { name: "New local name", position: 0 },
    ]);
    // Deliberate create is not a replay of the migration.
    expect(
      putSessionGroups({ cfg, agentId: "main", names: ["Legacy"], append: true, env }),
    ).toEqual([
      { name: "New local name", position: 0 },
      { name: "Legacy", position: 1 },
    ]);
  });

  it("binds an import to its first agent and refuses a recreated incarnation", () => {
    recordAgentProvenance("main", { createdVia: "operator" }, { env, nowMs: 10 });
    const input = {
      cfg,
      agentId: "main",
      names: ["Legacy"],
      append: true,
      importId: "native-import-one",
      env,
    };
    putSessionGroups(input);
    expect(() => putSessionGroups({ ...input, agentId: "other" })).toThrow(/original agent/);
    expect(listSessionGroups("other", env)).toEqual([]);
    recordAgentProvenance("main", { createdVia: "operator" }, { env, nowMs: 20 });
    expect(() => putSessionGroups({ ...input, names: ["New name"] })).toThrow(/original agent/);
    expect(listSessionGroups("main", env)).toEqual([{ name: "Legacy", position: 0 }]);
  });

  it("commits the import receipt and catalog atomically", () => {
    const db = openOpenClawStateDatabase({ env }).db;
    // Fail after the receipt is prepared, inside the same owning transaction.
    db.exec(
      "CREATE TRIGGER fail_import BEFORE INSERT ON agent_session_groups BEGIN SELECT RAISE(ABORT, 'catalog write rejected'); END",
    );
    const input = {
      cfg,
      agentId: "main",
      names: ["Legacy"],
      append: true,
      importId: "failed-import",
      env,
    };
    expect(() => putSessionGroups(input)).toThrow(/catalog write rejected/);
    db.exec("DROP TRIGGER fail_import");
    // A rolled-back attempt neither consumed the name nor bound another owner.
    expect(putSessionGroups({ ...input, agentId: "other" })).toEqual([
      { name: "Legacy", position: 0 },
    ]);
  });

  it("rejects import identifiers on replacement and malformed identifiers before mutation", () => {
    for (const input of [
      { importId: "source", append: false },
      { importId: " ", append: true },
      { importId: "x".repeat(129), append: true },
    ]) {
      expect(() =>
        putSessionGroups({ cfg, agentId: "main", names: ["Rejected"], ...input, env }),
      ).toThrow(/importId/);
    }
    expect(listSessionGroups("main", env)).toEqual([]);
  });
});
