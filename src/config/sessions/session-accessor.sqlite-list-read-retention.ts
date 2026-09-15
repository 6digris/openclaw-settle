import { retainOpenClawAgentDatabaseReads } from "../../state/openclaw-agent-db-readonly-retention.js";
import { listSqliteSessionEntriesFromDatabase } from "./session-accessor.sqlite-entry.js";
import { resolveSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryListScope, SessionEntrySummary } from "./session-accessor.types.js";

export type SessionEntryListReadRetention = {
  list: (scope: SessionEntryListScope) => SessionEntrySummary[];
  release: () => void;
};

/** Retain only the connection; each listing obtains and validates its current snapshot. */
export function retainSessionEntryListReads(options: {
  onRevoked: (reason: unknown) => void;
}): SessionEntryListReadRetention {
  const reads = retainOpenClawAgentDatabaseReads(options);
  return {
    list: (scope) => {
      const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
      const result = reads.read(
        (database) => listSqliteSessionEntriesFromDatabase(database, resolved, scope),
        toDatabaseOptions(resolved),
      );
      return result.found ? result.value : [];
    },
    release: reads.release,
  };
}
