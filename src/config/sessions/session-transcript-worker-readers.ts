import type { SessionCostUsageCacheReadResult } from "../../infra/session-cost-usage-cache-read.js";
import type { SessionHistoryWorkerResult } from "./session-history-types.js";
import type { SessionMember } from "./session-sharing-store.kernel.js";
import type { SessionStoreTargetInventoryResult } from "./session-store-target-inventory.js";
import type {
  PreparedSessionTranscriptHydration,
  SessionIdentityEvidenceWorkerInput,
  SessionIdentityEvidenceWorkerResult,
  SessionTranscriptHistoryWorkerInput,
  SessionEntryListWorkerInput,
  SessionEntryListWorkerResult,
  SessionRowPresenceWorkerInput,
  SessionProjectionStatusWorkerInput,
  SessionMembersWorkerInput,
  SessionUsageCacheWorkerInput,
  SessionTranscriptHydrationWorkerInput,
} from "./session-transcript-worker.types.js";

export type SessionHistoryWorkerRequestRunner = <TResult>(
  prepare: () =>
    | Omit<SessionTranscriptHistoryWorkerInput, "database">
    | Omit<SessionRowPresenceWorkerInput, "database">
    | Omit<SessionProjectionStatusWorkerInput, "database">
    | Omit<SessionEntryListWorkerInput, "database">
    | Omit<SessionIdentityEvidenceWorkerInput, "database">
    | Omit<SessionMembersWorkerInput, "database">
    | Omit<SessionUsageCacheWorkerInput, "database">
    | Omit<SessionTranscriptHydrationWorkerInput, "database">,
  inputBytes: number,
  receive: (
    value:
      | SessionHistoryWorkerResult
      | boolean
      | SessionEntryListWorkerResult
      | SessionIdentityEvidenceWorkerResult
      | SessionStoreTargetInventoryResult
      | SessionMember[]
      | SessionCostUsageCacheReadResult
      | PreparedSessionTranscriptHydration,
  ) => TResult,
) => Promise<TResult>;

/** Decode domain results; database custody remains with the enclosing history owner. */
export function createSessionHistoryWorkerReaders(runRequest: SessionHistoryWorkerRequestRunner) {
  return {
    run: async (
      prepare: () => Omit<SessionTranscriptHistoryWorkerInput, "database">,
      inputBytes: number,
    ) =>
      await runRequest(prepare, inputBytes, (value) => {
        if (
          typeof value === "boolean" ||
          Array.isArray(value) ||
          (value.kind !== "rpc" && value.kind !== "http")
        ) {
          throw new Error("Session history worker returned metadata instead of history");
        }
        return value;
      }),
    readTranscript: async (
      input: Omit<SessionTranscriptHydrationWorkerInput, "kind" | "database">,
    ) =>
      await runRequest(
        () => ({ kind: "transcript-hydration", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            (value.kind !== "full" && value.kind !== "bounded")
          ) {
            throw new Error(
              "Session history worker returned another result instead of a transcript",
            );
          }
          return value;
        },
      ),
    readUsageCache: async (input: Omit<SessionUsageCacheWorkerInput, "kind" | "database">) =>
      await runRequest(
        () => ({ kind: "usage-cache", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "usage-refresh-lock"
          ) {
            throw new Error(
              "Session history worker returned another result instead of usage cache",
            );
          }
          return value;
        },
      ),
    readMembers: async (input: Omit<SessionMembersWorkerInput, "kind" | "database">) =>
      await runRequest(
        () => ({ kind: "session-members", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (!Array.isArray(value)) {
            throw new Error("Session history worker returned another result instead of members");
          }
          return value;
        },
      ),
    readEntries: async (scope: SessionEntryListWorkerInput["scope"]) =>
      await runRequest(
        () => ({ kind: "session-entry-list", scope }),
        JSON.stringify(scope).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-entry-list"
          ) {
            throw new Error("Session history worker returned another result instead of entries");
          }
          return value.entries;
        },
      ),
    readIdentityEvidence: async (
      input: Omit<SessionIdentityEvidenceWorkerInput, "kind" | "database">,
    ) =>
      await runRequest(
        () => ({ kind: "session-identity-evidence", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (
            typeof value === "boolean" ||
            Array.isArray(value) ||
            value.kind !== "session-identity-evidence"
          ) {
            throw new Error(
              "Session history worker returned another result instead of identity evidence",
            );
          }
          return value.evidence;
        },
      ),
    readProjectionStatus: async (
      input: Omit<SessionProjectionStatusWorkerInput, "kind" | "database">,
    ) =>
      await runRequest(
        () => ({ kind: "projection-status", ...input }),
        JSON.stringify(input).length * 2,
        (value) => {
          if (typeof value !== "boolean") {
            throw new Error("Session history worker returned history instead of projection status");
          }
          return value;
        },
      ),
    readEntryPresence: async (scope: SessionRowPresenceWorkerInput["scope"]) =>
      await runRequest(
        () => ({ kind: "session-row-presence", scope }),
        JSON.stringify(scope).length * 2,
        (value) => {
          if (typeof value !== "boolean") {
            throw new Error("Session history worker returned history instead of metadata presence");
          }
          return value;
        },
      ),
  };
}
