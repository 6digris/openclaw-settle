import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isInternalSessionEffectsKey } from "../../../config/sessions/internal-session-key.js";
import {
  loadExactSessionEntryReadOnly,
  loadSessionEntryByIdReadOnly,
} from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { parseAgentSessionKey } from "../../../sessions/session-key-utils.js";

type PersistedSessionCapabilityEntry = Pick<
  SessionEntry,
  | "sessionId"
  | "spawnDepth"
  | "subagentRole"
  | "subagentControlScope"
  | "spawnedBy"
  | "completionOwnerSessionKey"
  | "inheritedToolPolicyVersion"
  | "inheritedToolAllow"
  | "inheritedToolDeny"
>;
export type SessionCapabilityEntry = {
  [Key in keyof PersistedSessionCapabilityEntry]?: unknown;
};

/** A complete store view; reads are memoized only for the current synchronous resolution. */
export type SessionCapabilityLookup = {
  /** Reuse this memo when depth fallback revisits the same logical store. */
  scope?: { storePath: string; agentId: string };
  get: (sessionKey: string) => SessionCapabilityEntry | undefined;
  getById: (sessionId: string, logicalAgentId: string) => SessionCapabilityEntry | undefined;
};

export type SessionCapabilityStore =
  | Record<string, SessionCapabilityEntry>
  | SessionCapabilityLookup;

/** Facts from an owning read in the same synchronous policy resolution. */
export type PreparedSessionCapabilityEntry = {
  sessionKey: string;
  entry: SessionCapabilityEntry;
};

export function isSessionCapabilityLookup(
  store: SessionCapabilityStore | undefined,
): store is SessionCapabilityLookup {
  return typeof store?.get === "function" && typeof store.getById === "function";
}

export function asSessionCapabilityLookup(store: SessionCapabilityStore): SessionCapabilityLookup {
  if (isSessionCapabilityLookup(store)) {
    return store;
  }
  return {
    get: (key) => store[key],
    getById: (id, logicalAgentId) => {
      const normalizedId = normalizeOptionalString(id);
      return normalizedId
        ? Object.entries(store).find(
            ([key, entry]) =>
              parseAgentSessionKey(key)?.agentId === logicalAgentId &&
              normalizeOptionalString(entry?.sessionId) === normalizedId,
          )?.[1]
        : undefined;
    },
  };
}

/** Lazily read metadata through the session owner, never a whole-store listing. */
export function createSubagentSessionStore(
  storePath: string,
  agentId: string,
  prepared?: PreparedSessionCapabilityEntry,
): SessionCapabilityLookup {
  const entries = new Map<string, SessionCapabilityEntry | undefined>();
  const ids = new Map<string, SessionCapabilityEntry | undefined>();
  if (prepared && !isInternalSessionEffectsKey(prepared.sessionKey)) {
    entries.set(prepared.sessionKey, prepared.entry);
  }
  return {
    scope: { storePath, agentId },
    get: (sessionKey) => {
      if (!entries.has(sessionKey)) {
        let entry: SessionCapabilityEntry | undefined;
        try {
          if (!isInternalSessionEffectsKey(sessionKey)) {
            entry = loadExactSessionEntryReadOnly({
              storePath,
              agentId,
              sessionKey,
              projection: "list",
            })?.entry;
          }
        } catch {
          // Preserve the depth/key fallback for missing or unavailable stores.
        }
        entries.set(sessionKey, entry);
      }
      return entries.get(sessionKey);
    },
    getById: (sessionId, logicalAgentId) => {
      const id = normalizeOptionalString(sessionId);
      if (!id) {
        return undefined;
      }
      const cacheKey = `${logicalAgentId}\0${id}`;
      if (!ids.has(cacheKey)) {
        let entry: SessionCapabilityEntry | undefined;
        try {
          const selected = loadSessionEntryByIdReadOnly({
            storePath,
            agentId,
            sessionId: id,
            logicalAgentId,
            projection: "list",
          });
          entry = selected?.entry;
          if (selected && !entries.has(selected.sessionKey)) {
            entries.set(selected.sessionKey, selected.entry);
          }
        } catch {
          // Preserve the depth/key fallback for missing or unavailable stores.
        }
        ids.set(cacheKey, entry);
      }
      return ids.get(cacheKey);
    },
  };
}
