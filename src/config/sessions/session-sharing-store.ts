import { collectErrorGraphCandidates } from "../../infra/errors.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { isSqliteWorkerError, type SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionAccessScope } from "./session-accessor.sqlite-contract.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import {
  addSessionMemberInDatabase,
  removeSessionMemberInDatabase,
  hasSessionMemberInDatabase,
  listSessionMembersInDatabase,
  type SessionMember,
} from "./session-sharing-store.kernel.js";
import type {
  SessionMemberWriteOperations,
  SessionMemberWriteOutcome,
} from "./session-sharing-store.operations.js";

function resolveDatabaseOptions(scope: SessionAccessScope): OpenClawAgentDatabaseOptions {
  return toDatabaseOptions(resolveSqliteScope(scope));
}

function readSessionMembers<T>(
  scope: SessionAccessScope,
  fallback: T,
  operation: (database: Pick<OpenClawAgentDatabase, "db">) => T,
): T {
  const result = withOpenClawAgentDatabaseReadOnly(operation, resolveDatabaseOptions(scope));
  return result.found ? result.value : fallback;
}

export function listSessionMembers(scope: SessionAccessScope): SessionMember[] {
  return readSessionMembers(scope, [], (database) =>
    listSessionMembersInDatabase(database, resolveSqliteScope(scope).sessionKey),
  );
}

export function isSessionMember(scope: SessionAccessScope, identityId: string): boolean {
  const normalizedIdentityId = identityId.trim();
  if (!normalizedIdentityId) {
    return false;
  }
  return readSessionMembers(scope, false, (database) =>
    hasSessionMemberInDatabase(
      database,
      resolveSqliteScope(scope).sessionKey,
      normalizedIdentityId,
    ),
  );
}

type SessionMemberWriteOptions = { assertCurrent?: () => void };

async function writeSessionMember<T>(
  scope: SessionAccessScope,
  options: SessionMemberWriteOptions | undefined,
  native: (database: OpenClawAgentDatabase, sessionKey: string) => SessionMemberWriteOutcome<T>,
  worker: (
    store: Pick<SqliteWorkerStore<SessionMemberWriteOperations>, "execute">,
    sessionKey: string,
  ) => Promise<SessionMemberWriteOutcome<T>>,
): Promise<T> {
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const resolved = resolveSqliteScope({ ...scope, env });
  const databaseOptions = toDatabaseOptions(resolved);
  options?.assertCurrent?.();
  const database = openOpenClawAgentDatabase(databaseOptions);
  const change = {
    agentId: resolved.agentId,
    storePath: database.path,
    sessionKey: resolved.sessionKey,
  };
  if (typeof readOpenClawAgentDatabaseIdentity(database).identity === "symbol") {
    return runOpenClawAgentWriteTransaction((current) => {
      options?.assertCurrent?.();
      const result = native(current, resolved.sessionKey);
      if (result.changed) {
        sessionChanges.emit(change, current.db);
      }
      return result.value;
    }, databaseOptions);
  }
  const publication = await openOpenClawAgentSqliteWorkerStore<SessionMemberWriteOperations>(
    databaseOptions,
    database.db,
    {
      moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionSharingStore),
      input: undefined,
    },
  );
  try {
    return await publication.run(
      async (store) => {
        let result: SessionMemberWriteOutcome<T>;
        try {
          result = await worker(store, resolved.sessionKey);
        } catch (error) {
          if (
            collectErrorGraphCandidates(error, (current) =>
              current instanceof AggregateError ? [current.cause] : [],
            ).some((current) => isSqliteWorkerError(current, "outcome-unknown"))
          ) {
            sessionChanges.emit(change);
          }
          throw error;
        }
        if (result.changed) {
          sessionChanges.emit(change);
        }
        return result.value;
      },
      () => options?.assertCurrent?.(),
    );
  } finally {
    await publication.close();
  }
}

export async function addSessionMember(
  scope: SessionAccessScope,
  params: Parameters<typeof addSessionMemberInDatabase>[2],
  options?: SessionMemberWriteOptions,
): Promise<ReturnType<typeof addSessionMemberInDatabase>> {
  const identityId = params.identityId.trim();
  const addedBy = params.addedBy.trim();
  if (!identityId || !addedBy) {
    throw new Error("session member identity and actor are required");
  }
  const captured = { ...params, identityId, addedBy, addedAt: params.addedAt ?? Date.now() };
  return await writeSessionMember(
    scope,
    options,
    (database, sessionKey) => {
      const value = addSessionMemberInDatabase(database, sessionKey, captured);
      return { value, changed: value.inserted };
    },
    (store, sessionKey) =>
      store.execute({ type: "members.add", input: { sessionKey, params: captured } }),
  );
}

export async function removeSessionMember(
  scope: SessionAccessScope,
  identityId: string,
  expected?: Pick<SessionMember, "addedBy" | "addedAt">,
  expectedSessionId?: string,
  options?: SessionMemberWriteOptions,
): Promise<SessionMember | null> {
  const normalizedIdentityId = identityId.trim();
  if (!normalizedIdentityId) {
    return null;
  }
  const captured = expected ? { ...expected } : undefined;
  return await writeSessionMember(
    scope,
    options,
    (database, sessionKey) => {
      const value = removeSessionMemberInDatabase(
        database,
        sessionKey,
        normalizedIdentityId,
        captured,
        expectedSessionId,
      );
      return { value, changed: value !== null };
    },
    (store, sessionKey) =>
      store.execute({
        type: "members.remove",
        input: {
          sessionKey,
          identityId: normalizedIdentityId,
          expected: captured,
          expectedSessionId,
        },
      }),
  );
}
