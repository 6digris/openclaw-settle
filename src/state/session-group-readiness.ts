import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { readConfigMachineStateRowInDatabase } from "./config-machine-state.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  SESSION_GROUP_MIGRATION_KEY,
  LEGACY_SESSION_GROUP_SECTION_ORDER_KEY,
} from "./session-group-ownership.js";

/** A schema-only open must not expose an empty replacement for an unmigrated catalog. */
export function isSessionGroupCatalogReady(database: DatabaseSync): boolean {
  const row = readConfigMachineStateRowInDatabase(database, SESSION_GROUP_MIGRATION_KEY);
  if (!row) {
    return false;
  }
  const receipt: unknown = JSON.parse(row.value_json);
  if (
    !isRecord(receipt) ||
    receipt.version !== 1 ||
    typeof receipt.sourceFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(receipt.sourceFingerprint) ||
    typeof receipt.completedAtMs !== "number" ||
    !Number.isSafeInteger(receipt.completedAtMs)
  ) {
    throw new Error(
      "Invalid session group ownership migration receipt; run openclaw doctor --fix.",
    );
  }
  return true;
}

export function assertSessionGroupCatalogReady(database: DatabaseSync): void {
  if (!isSessionGroupCatalogReady(database)) {
    throw new Error(
      "Session group ownership migration is incomplete; run openclaw doctor --fix before using session groups.",
    );
  }
}

/** Empty fresh catalogs carry no shared defaults whose owner deletion could reassign. */
export function hasLegacySessionGroupClassification(database: DatabaseSync): boolean {
  const hasLegacyGroups =
    tableExists(database, "session_groups") &&
    executeSqliteQuerySync(
      database,
      getNodeSqliteKysely<Pick<DB, "session_groups">>(database)
        .selectFrom("session_groups")
        .select("name")
        .limit(1),
    ).rows.length > 0;
  return (
    hasLegacyGroups ||
    Boolean(readConfigMachineStateRowInDatabase(database, LEGACY_SESSION_GROUP_SECTION_ORDER_KEY))
  );
}

export function assertSessionGroupMigrationSafeForDeletion(database: DatabaseSync): void {
  if (!isSessionGroupCatalogReady(database) && hasLegacySessionGroupClassification(database)) {
    assertSessionGroupCatalogReady(database);
  }
}
