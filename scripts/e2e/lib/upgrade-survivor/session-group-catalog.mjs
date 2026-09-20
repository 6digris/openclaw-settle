import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const receiptKey = "sessionGroups.agentOwnedCatalog";
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const open = (file, run, readOnly = true) => {
  const db = new DatabaseSync(file, { readOnly });
  try {
    return run(db);
  } finally {
    db.close();
  }
};
const rows = (db) =>
  db
    .prepare(
      "SELECT session_key, entry_json, updated_at FROM session_nodes WHERE session_key LIKE ? ORDER BY session_key",
    )
    .all("agent:%:group-survivor");

/** @param {string} stateDir @param {string} artifactRoot @param {string} baselineRoot */
export function seedSessionGroupCatalog(stateDir, artifactRoot, baselineRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(baselineRoot, "package.json"), "utf8"));
  // Earlier JSON-era baselines have a separate migration fixture; do not pretend
  // that an unexecuted modern SQLite fixture proves those published drivers.
  assert(manifest.openclaw?.schemaVersions?.state >= 15);
  const statePath = path.join(stateDir, "state/openclaw.sqlite");
  const agents = ["main", "ops"].map((agentId) => {
    const databasePath = path.join(stateDir, "agents", agentId, "agent/openclaw-agent.sqlite");
    assert(fs.existsSync(databasePath), `baseline must create the ${agentId} database`);
    const metadata = open(
      databasePath,
      (db) => {
        const sessionId = `group-survivor-${agentId}`;
        db.prepare(
          "INSERT INTO session_nodes(session_key,current_session_id,entry_json,updated_at) VALUES(?,?,?,?)",
        ).run(
          `agent:${agentId}:group-survivor`,
          sessionId,
          JSON.stringify({ sessionId, updatedAt: 123, category: "Shared" }),
          123,
        );
        return rows(db);
      },
      false,
    );
    return { agentId, databasePath, metadata };
  });
  const legacy = open(
    statePath,
    (db) => {
      for (const column of ["cwd TEXT", "worktree INTEGER"]) {
        if (
          !db
            .prepare("PRAGMA table_info(session_groups)")
            .all()
            .some((row) => row.name === column.split(" ")[0])
        )
          db.exec(`ALTER TABLE session_groups ADD COLUMN ${column}`);
      }
      assert.equal(db.prepare("SELECT count(*) AS n FROM session_groups").get().n, 0);
      db.prepare("INSERT INTO session_groups VALUES(?,?,?,?,?)").run(
        "Shared",
        3,
        42,
        "/synthetic/group-project",
        0,
      );
      db.prepare("INSERT INTO session_groups VALUES(?,?,?,?,?)").run("Empty", 8, 99, null, null);
      db.prepare(
        "INSERT INTO config_machine_state(state_key,value_json,updated_at_ms) VALUES(?,?,?)",
      ).run(
        "sidebar.sectionOrder",
        JSON.stringify(["work", "category:Empty", "category:Shared", "ungrouped"]),
        12,
      );
      return {
        version: db.prepare("PRAGMA user_version").get().user_version,
        groups: db.prepare("SELECT * FROM session_groups ORDER BY position").all(),
      };
    },
    false,
  );
  const fixture = { baselineVersion: manifest.version, statePath, agents, legacy };
  fs.writeFileSync(
    path.join(artifactRoot, "session-group-catalog.json"),
    JSON.stringify(fixture, null, 2),
    { mode: 0o600 },
  );
  return fixture;
}

/** @param {string} artifactRoot */
export function assertSessionGroupCatalog(artifactRoot) {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(artifactRoot, "session-group-catalog.json"), "utf8"),
  );
  const result = open(fixture.statePath, (db) => {
    const receipt = JSON.parse(
      db.prepare("SELECT value_json FROM config_machine_state WHERE state_key=?").get(receiptKey)
        ?.value_json ?? "null",
    );
    assert.equal(receipt?.version, 1, "installed updater did not complete group cutover");
    assert.match(receipt.sourceFingerprint, /^[a-f0-9]{64}$/);
    const groups = db
      .prepare(
        "SELECT * FROM agent_session_groups WHERE name IN ('Shared','Empty') ORDER BY agent_id,position",
      )
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(groups, [
      { agent_id: "main", ...fixture.legacy.groups[0] },
      { agent_id: "main", ...fixture.legacy.groups[1] },
      { agent_id: "ops", ...fixture.legacy.groups[0] },
    ]);
    const order = (id) =>
      JSON.parse(
        db
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key=?")
          .get(`sidebar.sectionOrder.agent:${id}`)?.value_json ?? "null",
      );
    assert.deepEqual(order("main"), ["work", "category:Empty", "category:Shared", "ungrouped"]);
    assert.deepEqual(order("ops"), ["work", "category:Shared", "ungrouped"]);
    assert.deepEqual(
      db
        .prepare("SELECT * FROM session_groups ORDER BY position")
        .all()
        .map((row) => ({ ...row })),
      fixture.legacy.groups,
    );
    assert(
      receipt.backupPath && fs.existsSync(receipt.backupPath),
      "verified group recovery snapshot missing",
    );
    open(receipt.backupPath, (backup) => {
      assert.equal(
        backup.prepare("PRAGMA user_version").get().user_version,
        fixture.legacy.version,
      );
      assert.deepEqual(
        backup
          .prepare("SELECT * FROM session_groups ORDER BY position")
          .all()
          .map((row) => ({ ...row })),
        fixture.legacy.groups,
      );
    });
    return {
      rows: groups.length,
      receiptFingerprint: receipt.sourceFingerprint,
      publishedVersion: db.prepare("PRAGMA user_version").get().user_version,
    };
  });
  for (const agent of fixture.agents)
    assert.equal(
      open(agent.databasePath, (db) => fingerprint(rows(db))),
      fingerprint(agent.metadata),
      `${agent.agentId} session bytes or timestamps changed`,
    );
  fs.writeFileSync(
    path.join(artifactRoot, "session-group-catalog-result.json"),
    JSON.stringify({ ...result, status: "passed", baselineVersion: fixture.baselineVersion }),
    { mode: 0o600 },
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "seed" && args.length === 3) seedSessionGroupCatalog(args[0], args[1], args[2]);
  else if (command === "assert" && args.length === 1) assertSessionGroupCatalog(args[0]);
  else
    throw new Error(
      "Expected session-group-catalog.mjs seed <state> <artifacts> <baseline-root> or assert <artifacts>",
    );
}
