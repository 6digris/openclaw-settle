import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readAgentProvenanceInDatabase } from "../state/agent-provenance.kernel.js";
import {
  readConfigMachineStateRowInDatabase,
  type ConfigMachineStateDatabase,
} from "../state/config-machine-state.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const isDigest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

/** Called only inside the catalog transaction, after its live-authority guard. */
export function consumeSessionGroupImport(
  database: DatabaseSync,
  agentId: string,
  importId: string,
  normalizedNames: readonly string[],
): string[] {
  // One legacy source keeps its identity across reconnects and changed defaults.
  // Do not scope the key by agent: that would silently retarget a replay.
  const key = "sessionGroups.clientImport:" + digest(importId);
  const owner = digest(
    JSON.stringify({
      agentId,
      provenance: readAgentProvenanceInDatabase(database, agentId) ?? null,
    }),
  );
  const row = readConfigMachineStateRowInDatabase(database, key);
  const consumed = new Set<string>();
  if (row) {
    const receipt: unknown = JSON.parse(row.value_json);
    if (
      !isRecord(receipt) ||
      receipt.version !== 1 ||
      !isDigest(receipt.owner) ||
      !Array.isArray(receipt.consumed) ||
      !receipt.consumed.every(isDigest)
    ) {
      throw new Error(
        "Invalid session group import receipt; restore the shared-state backup before retrying this import.",
      );
    }
    if (receipt.owner !== owner) {
      throw new Error(
        "This session group import belongs to its original agent; it cannot be moved to another or recreated agent.",
      );
    }
    for (const hash of receipt.consumed) {
      consumed.add(hash);
    }
  }
  const names = normalizedNames.filter((name) => !consumed.has(digest(name)));
  if (!row || names.length) {
    for (const name of names) {
      consumed.add(digest(name));
    }
    const value = JSON.stringify({ version: 1, owner, consumed: [...consumed].toSorted() });
    const now = Date.now();
    const db = getNodeSqliteKysely<ConfigMachineStateDatabase>(database);
    executeSqliteQuerySync(
      database,
      db
        .insertInto("config_machine_state")
        .values({ state_key: key, value_json: value, updated_at_ms: now })
        .onConflict((conflict) =>
          conflict.column("state_key").doUpdateSet({ value_json: value, updated_at_ms: now }),
        ),
    );
  }
  // Keep consumed-name hashes after rename/delete (including agent deletion).
  // A lost acknowledgement must never replay a deleted group into existence.
  // New source names can still be imported on the original destination.
  return names;
}
