import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readSessionEntryInstanceId } from "./session-accessor.sqlite-entry-identity.js";

export type SessionMember = {
  identityId: string;
  addedBy: string;
  addedAt: number;
};

export function listSessionMembersInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
): SessionMember[] {
  return executeSqliteQuerySync(
    database.db,
    getSessionMemberKysely(database)
      .selectFrom("session_members")
      .select(["identity_id", "added_by", "added_at"])
      .where("session_key", "=", sessionKey)
      .orderBy("identity_id"),
  ).rows.map((row) => ({
    identityId: row.identity_id,
    addedBy: row.added_by,
    addedAt: row.added_at,
  }));
}

type SessionMemberDatabase = Pick<OpenClawAgentKyselyDatabase, "session_members">;

function getSessionMemberKysely(database: Pick<OpenClawAgentDatabase, "db">) {
  return getNodeSqliteKysely<SessionMemberDatabase>(database.db);
}

export function hasSessionMemberInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  normalizedIdentityId: string,
): boolean {
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      database.db,
      getSessionMemberKysely(database)
        .selectFrom("session_members")
        .select("identity_id")
        .where("session_key", "=", sessionKey)
        .where("identity_id", "=", normalizedIdentityId),
    ),
  );
}

// Membership is bound to a live session entry, never a transcript placeholder.
// Authorization is rechecked before these transactions, but a reset/recreate
// can replace the row under the same key in between; the optional expected id
// adds a caller snapshot check after the canonical node/entry check.
function assertAuthorizedSessionInstance(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  expectedSessionId: string | undefined,
): void {
  const sessionId = readSessionEntryInstanceId(database, sessionKey);
  if (
    sessionId === undefined ||
    (expectedSessionId !== undefined && sessionId !== expectedSessionId)
  ) {
    throw new Error("session changed before sharing mutation");
  }
}

export function addSessionMemberInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  params: { identityId: string; addedBy: string; addedAt?: number; expectedSessionId?: string },
): { member: SessionMember; inserted: boolean } {
  const identityId = params.identityId.trim();
  const addedBy = params.addedBy.trim();
  if (!identityId || !addedBy) {
    throw new Error("session member identity and actor are required");
  }
  const addedAt = params.addedAt ?? Date.now();
  assertAuthorizedSessionInstance(database, sessionKey, params.expectedSessionId);
  const db = getSessionMemberKysely(database);
  const result = executeSqliteQuerySync(
    database.db,
    db
      .insertInto("session_members")
      .values({
        session_key: sessionKey,
        identity_id: identityId,
        added_by: addedBy,
        added_at: addedAt,
      })
      .onConflict((conflict) => conflict.columns(["session_key", "identity_id"]).doNothing()),
  );
  const inserted = (result.numAffectedRows ?? 0n) > 0n;
  return { member: { identityId, addedBy, addedAt }, inserted };
}

export function removeSessionMemberInDatabase(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionKey: string,
  identityId: string,
  expected?: Pick<SessionMember, "addedBy" | "addedAt">,
  expectedSessionId?: string,
): SessionMember | null {
  const normalizedIdentityId = identityId.trim();
  if (!normalizedIdentityId) {
    return null;
  }

  assertAuthorizedSessionInstance(database, sessionKey, expectedSessionId);
  const db = getSessionMemberKysely(database);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("session_members")
      .select(["identity_id", "added_by", "added_at"])
      .where("session_key", "=", sessionKey)
      .where("identity_id", "=", normalizedIdentityId),
  );
  if (
    !row ||
    (expected && (row.added_by !== expected.addedBy || row.added_at !== expected.addedAt))
  ) {
    return null;
  }
  executeSqliteQuerySync(
    database.db,
    db
      .deleteFrom("session_members")
      .where("session_key", "=", sessionKey)
      .where("identity_id", "=", normalizedIdentityId),
  );
  return { identityId: row.identity_id, addedBy: row.added_by, addedAt: row.added_at };
}
