import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";

export function openSessionDatabase(agentId: string, env: NodeJS.ProcessEnv, storePath: string) {
  return openOpenClawAgentDatabase({
    agentId,
    env,
    path: resolveSqliteTargetFromSessionStorePath(storePath, { agentId, env }).path,
  });
}

export function insertLegacySession(params: {
  agentId: string;
  entry: SessionEntry;
  env: NodeJS.ProcessEnv;
  eventText?: string;
  sessionKey: string;
  storePath: string;
}): void {
  const database = openSessionDatabase(params.agentId, params.env, params.storePath);
  database.db
    .prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run(
      params.sessionKey,
      params.entry.sessionId,
      JSON.stringify(params.entry),
      params.entry.updatedAt,
    );
  database.db
    .prepare(
      "INSERT INTO session_windows (session_id, session_key, reason, session_scope, created_at, updated_at) VALUES (?, ?, 'initial', 'conversation', ?, ?)",
    )
    .run(params.entry.sessionId, params.sessionKey, params.entry.updatedAt, params.entry.updatedAt);
  if (!params.eventText) {
    return;
  }
  database.db
    .prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, ?)",
    )
    .run(
      params.entry.sessionId,
      JSON.stringify({
        id: `${params.entry.sessionId}-message`,
        message: { content: params.eventText, role: "user" },
        parentId: null,
        type: "message",
      }),
      params.entry.updatedAt,
    );
}

/** Preserve committed custody while constructing an on-disk legacy-key fixture. */
export function rekeyLegacySessionFixture(db: DatabaseSync, from: string, to: string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("PRAGMA defer_foreign_keys = ON");
    for (const table of [
      "session_nodes",
      "session_windows",
      "session_pending_inputs",
      "session_input_completions",
    ]) {
      if (tableExists(db, table)) {
        db.prepare(`UPDATE ${table} SET session_key = ? WHERE session_key = ?`).run(to, from);
      }
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
