import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrityInWorker } from "../infra/sqlite-integrity-worker.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { assertAgentDatabaseMaintenanceAuthority } from "./openclaw-agent-db-lease.js";
import {
  assertExistingAgentSchemaOwner,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import { ensureOpenClawAgentDatabaseSchemaSteps } from "./openclaw-agent-db-schema.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-schema-validation.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

/** Upgrade or repair a supported owned schema before strict offline maintenance. */
export async function migrateOpenClawAgentDatabaseForMaintenance(
  options: { agentId: string; pathname: string },
  maintenance: OpenClawStateLeaseContext,
): Promise<void> {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = options.pathname;
  const env = { ...process.env };
  const assertOwned = () => {
    maintenance.signal.throwIfAborted();
    assertAgentDatabaseMaintenanceAuthority(maintenance);
  };
  assertOwned();
  const database = openNodeSqliteDatabase(pathname);
  try {
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    const metadata = readExistingAgentSchemaMeta(database);
    if (!metadata) {
      return;
    }
    assertExistingAgentSchemaOwner(metadata, agentId, pathname);
    assertSupportedAgentSchemaVersion(database, pathname);
    const userVersion = readSqliteUserVersion(database);
    const metadataVersion = metadata.schemaVersion;
    const hasCurrentVersion =
      userVersion === OPENCLAW_AGENT_SCHEMA_VERSION &&
      metadataVersion === OPENCLAW_AGENT_SCHEMA_VERSION;
    const hasSupportedOlderVersion =
      userVersion >= 1 &&
      userVersion < OPENCLAW_AGENT_SCHEMA_VERSION &&
      metadataVersion !== null &&
      metadataVersion === userVersion &&
      metadataVersion >= 1 &&
      metadataVersion < OPENCLAW_AGENT_SCHEMA_VERSION;
    if (!hasCurrentVersion && !hasSupportedOlderVersion) {
      return;
    }
    const operation = ensureOpenClawAgentDatabaseSchemaSteps(database, {
      agentId,
      path: pathname,
      env,
    });
    try {
      let step = operation.next();
      while (!step.done) {
        assertOwned();
        try {
          // The maintenance fence and connection survive until native Worker exit.
          // Revalidate before either resume path can repair indexes or mutate schema.
          await assertSqliteIntegrityInWorker(
            step.value.databaseLabel,
            OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
            maintenance.signal,
          );
        } catch (error) {
          assertOwned();
          assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(database), agentId, pathname);
          assertSupportedAgentSchemaVersion(database, pathname);
          step = operation.throw(error);
          continue;
        }
        assertOwned();
        assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(database), agentId, pathname);
        assertSupportedAgentSchemaVersion(database, pathname);
        step = operation.next();
      }
    } finally {
      operation.return();
    }
    assertOwned();
    assertOpenClawAgentDatabaseForMaintenance(database, {
      agentId,
      pathname,
    });
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}

export {
  assertOpenClawAgentDatabaseOwner,
  assertOpenClawAgentDatabaseForMaintenance,
} from "./openclaw-agent-schema-validation.js";
