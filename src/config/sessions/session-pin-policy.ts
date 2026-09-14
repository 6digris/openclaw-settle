import { isSubagentSessionKey } from "../../routing/session-key.js";

// Spawn lineage does not make a persistent conversation a subordinate run.
export function isPinnableSessionEntry(storeKey: string): boolean {
  return !isSubagentSessionKey(storeKey);
}
