import type { DatabaseSync } from "node:sqlite";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
  MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
  MEMORY_INDEX_SOURCES_TABLE,
  MEMORY_PATH_FTS_TRIGGER_DEFINITIONS,
} from "../../packages/memory-host-sdk/src/host/memory-schema-contract.js";
import {
  assertSqliteSchemaContains,
  type SqliteSchemaCompatibility,
} from "../infra/sqlite-schema-contract.js";
import {
  createNewerSqliteSchemaVersionError,
  readSqliteUserVersion,
} from "../infra/sqlite-user-version.js";
import { FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS } from "./openclaw-agent-db-additive-columns.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  SESSION_PARTICIPANTS_TABLE,
  CONTEXT_ENGINE_TURN_OUTBOX_TABLE,
  SESSION_GOAL_OPERATIONS_TABLE,
  MESSAGE_TOOL_RUN_OUTCOMES_TABLE,
  SESSION_PENDING_INPUTS_TABLE,
  SESSION_INPUT_COMPLETIONS_TABLE,
  SESSION_PROGRESS_CARDS_TABLE,
  SESSION_TRANSCRIPT_ARCHIVES_TABLE,
  STANDING_INTENTS_TABLE,
  STANDING_INTENTS_FTS_TABLE,
  STANDING_INTENTS_FTS_SHADOW_TABLES,
  LEGACY_PARTICIPANT_OPTIONAL_COLUMNS,
} from "./openclaw-agent-db-contract.js";
import {
  readExistingAgentSchemaMeta,
  assertExistingAgentSchemaOwner,
} from "./openclaw-agent-db-schema-read.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

const AGENT_SCHEMA_COMPATIBILITY = {
  allowCompatibleAdditiveColumns: true,
  allowedMissingTables: [
    "memory_entry_origins",
    "memory_session_tombstones",
    MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
    MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE,
    CONTEXT_ENGINE_TURN_OUTBOX_TABLE,
    MESSAGE_TOOL_RUN_OUTCOMES_TABLE,
    SESSION_GOAL_OPERATIONS_TABLE,
    SESSION_PENDING_INPUTS_TABLE,
    SESSION_INPUT_COMPLETIONS_TABLE,
    SESSION_PARTICIPANTS_TABLE,
    SESSION_PROGRESS_CARDS_TABLE,
    SESSION_TRANSCRIPT_ARCHIVES_TABLE,
    STANDING_INTENTS_TABLE,
    STANDING_INTENTS_FTS_TABLE,
    ...STANDING_INTENTS_FTS_SHADOW_TABLES,
  ],
  allowedMissingColumns: [
    "session_pending_inputs.consumed_event_id",
    "session_transcript_active_events.context_eligible",
    "session_conversations.route_context_json",
    "standing_intents.creator_sender",
    ...FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS.map(
      ({ columnName, tableName }) => `${tableName}.${columnName}`,
    ),
  ],
  allowedColumnDefinitions: {
    "conversations.delivery_target": ["delivery_target TEXT NOT NULL DEFAULT ''"],
  },
  allowedMissingIndexes: ["idx_agent_transcript_context_pending", "idx_agent_session_nodes_label"],
  optionalCanonicalTriggerGroups: [
    {
      tableName: MEMORY_INDEX_SOURCES_TABLE,
      triggers: MEMORY_PATH_FTS_TRIGGER_DEFINITIONS,
    },
  ],
} satisfies SqliteSchemaCompatibility;

export function hasRetiredAgentStateLeaseSchema(database: DatabaseSync): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM main.sqlite_schema WHERE name = 'state_leases'").get(),
  );
}

function assertNoRetiredAgentStateLeaseSchema(database: DatabaseSync, pathname: string): void {
  if (hasRetiredAgentStateLeaseSchema(database)) {
    throw new Error(
      `OpenClaw agent database ${pathname} retains retired state_leases storage; run openclaw doctor --fix before using it.`,
    );
  }
}

export function assertOpenClawAgentSchemaContains(
  database: DatabaseSync,
  pathname: string,
  schemaSql: string,
  participantSchema: "current" | "legacy" = "current",
): void {
  assertSqliteSchemaContains(database, pathname, schemaSql, {
    ...AGENT_SCHEMA_COMPATIBILITY,
    allowedMissingTables: [
      ...AGENT_SCHEMA_COMPATIBILITY.allowedMissingTables,
      // Legacy migration preflight precedes creation of the required v20 table.
      ...(participantSchema === "legacy" ? ["session_transcript_cold_archives"] : []),
    ],
    allowedMissingColumns: [
      ...AGENT_SCHEMA_COMPATIBILITY.allowedMissingColumns,
      ...(participantSchema === "legacy" ? LEGACY_PARTICIPANT_OPTIONAL_COLUMNS : []),
    ],
  });
}

export function assertOpenClawAgentCurrentRuntimeSchema(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): void {
  const agentId = normalizeAgentId(options.agentId);
  const metadata = readExistingAgentSchemaMeta(database);
  if (!metadata) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} has no schema ownership metadata.`,
    );
  }
  assertExistingAgentSchemaOwner(metadata, agentId, options.pathname);
  if (metadata.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match ${OPENCLAW_AGENT_SCHEMA_VERSION}; run openclaw doctor --fix before using it.`,
    );
  }
  assertNoRetiredAgentStateLeaseSchema(database, options.pathname);
  assertOpenClawAgentSchemaContains(database, options.pathname, OPENCLAW_AGENT_SCHEMA_SQL);
}

export function assertAgentSchemaVersion(
  db: DatabaseSync,
  options: { agentId: string; pathname: string; version: number },
  schemaSql: string,
): void {
  const metadata = readExistingAgentSchemaMeta(db);
  assertExistingAgentSchemaOwner(metadata, options.agentId, options.pathname);
  const userVersion = readSqliteUserVersion(db);
  if (userVersion !== options.version || metadata?.schemaVersion !== options.version) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} did not converge on schema version ${options.version}.`,
    );
  }
  assertOpenClawAgentSchemaContains(
    db,
    options.pathname,
    schemaSql,
    options.version < 18 ? "legacy" : "current",
  );
}

/** Require exact agent ownership without requiring the latest schema. */
export function assertOpenClawAgentDatabaseOwner(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): NonNullable<ReturnType<typeof readExistingAgentSchemaMeta>> {
  const agentId = normalizeAgentId(options.agentId);
  const metadata = readExistingAgentSchemaMeta(database);
  if (!metadata) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} has no schema ownership metadata.`,
    );
  }
  assertExistingAgentSchemaOwner(metadata, agentId, options.pathname);
  if (metadata.agentId !== agentId) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} belongs to agent ${metadata.agentId}; requested agent ${agentId}.`,
    );
  }
  return metadata;
}

/** Require the exact agent owner and schema before offline file maintenance. */
export function assertOpenClawAgentDatabaseForMaintenance(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): void {
  const metadata = assertOpenClawAgentDatabaseOwner(database, options);

  const userVersion = readSqliteUserVersion(database);
  if (userVersion > OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw createNewerSqliteSchemaVersionError(
      "OpenClaw agent database",
      options.pathname,
      userVersion,
      OPENCLAW_AGENT_SCHEMA_VERSION,
    );
  }
  if (userVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} uses schema version ${userVersion}; run openclaw doctor --fix before compacting it.`,
    );
  }
  if (metadata.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new Error(
      `OpenClaw agent database ${options.pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match ${OPENCLAW_AGENT_SCHEMA_VERSION}; run openclaw doctor --fix before compacting it.`,
    );
  }
  assertOpenClawAgentSchemaContains(database, options.pathname, OPENCLAW_AGENT_SCHEMA_SQL);
}

/** Check version markers and runtime schema compatibility on the caller's existing connection. */
export function assertOpenClawAgentDatabaseForRuntime(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): void {
  assertOpenClawAgentDatabaseForMaintenance(database, options);
  assertNoRetiredAgentStateLeaseSchema(database, options.pathname);
}
