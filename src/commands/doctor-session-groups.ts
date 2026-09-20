/** Doctor/startup cutover; runtime never reads or repairs the global catalog. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { sql, type Selectable } from "kysely";
import { resolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveStateDir } from "../config/paths.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveConfiguredAgentDatabaseCandidatePaths,
  resolveConfiguredAgentDatabaseTargets,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
import { discoverAgentDatabaseMigrationTargets } from "../infra/state-migrations.media-persistence-targets.js";
import {
  readSessionGroupLegacyIndex,
  wasSessionGroupSourceImported,
} from "../infra/state-migrations.session-group-sources.js";
import type { MigrationMessages } from "../infra/state-migrations.types.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { readConfigMachineStateRowInDatabase } from "../state/config-machine-state.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { readOpenClawAgentDatabaseRegistryRows } from "../state/openclaw-agent-db-registry-listing.js";
import {
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "../state/openclaw-agent-db-schema-helpers.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  resolveOpenClawRegisteredAgentDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../state/openclaw-state-db.paths.js";
import {
  LEGACY_SESSION_GROUP_SECTION_ORDER_KEY,
  SESSION_GROUP_MIGRATION_KEY,
  sessionGroupSectionOrderKey,
} from "../state/session-group-ownership.js";
import {
  isSessionGroupCatalogReady,
  hasLegacySessionGroupClassification,
} from "../state/session-group-readiness.js";

type Group = Selectable<DB["session_groups"]>;
type GroupDatabase = Pick<DB, "session_groups" | "agent_session_groups" | "config_machine_state">;
type Member = { owner: string; key: string; category: string };
type Inventory = {
  owners: string[];
  members: Member[];
  sources: Array<{ path: string; identity: string }>;
};

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readDatabase<T>(pathname: string, run: (database: DatabaseSync) => T): T {
  const database = openNodeSqliteDatabase(pathname, { readOnly: true });
  try {
    return run(database);
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}

function sourceIdentity(pathname: string): string {
  const stat = fs.statSync(pathname);
  if (!stat.isFile()) {
    throw new Error(`Expected a regular session migration source at ${pathname}`);
  }
  return `${stat.dev}:${stat.ino}`;
}

/** Only category/key fields cross the SQLite boundary, never transcripts or saved prompts. */
function readMembers(database: DatabaseSync, pathname: string, physicalOwner: string): Member[] {
  const table = tableExists(database, "session_nodes")
    ? "session_nodes"
    : tableExists(database, "session_entries")
      ? "session_entries"
      : undefined;
  if (!table) {
    throw new Error(`Required session metadata table is missing at ${pathname}`);
  }
  // sqlite-allow-raw -- Migration reads both historical canonical table names and projects metadata in SQL.
  const rows = database
    .prepare(`SELECT session_key,
    CASE WHEN json_valid(entry_json) THEN json_type(entry_json) ELSE 'invalid' END AS entry_type,
    CASE WHEN json_valid(entry_json) THEN json_type(entry_json, '$.category') END AS category_type,
    CASE WHEN json_valid(entry_json) THEN json_extract(entry_json, '$.category') END AS category
    FROM ${table} ORDER BY session_key`)
    .all();
  return rows.map((row) => {
    if (
      typeof row.session_key !== "string" ||
      row.entry_type !== "object" ||
      (row.category_type !== null && row.category_type !== "null" && row.category_type !== "text")
    ) {
      throw new Error(
        `Invalid session category metadata at ${pathname}; repair the source before migrating groups.`,
      );
    }
    const parsed = parseAgentSessionKey(row.session_key);
    if (row.session_key.startsWith("agent:") && !parsed) {
      throw new Error(`Unresolved logical session owner at ${pathname}: ${row.session_key}`);
    }
    const owner = normalizeAgentId(parsed?.agentId ?? physicalOwner);
    return {
      owner,
      key: row.session_key,
      category: typeof row.category === "string" ? row.category.trim() : "",
    };
  });
}

function inventory(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  state: { db: DatabaseSync; path: string },
): Inventory {
  const registered = readOpenClawAgentDatabaseRegistryRows(state.db, state.path).map((row) => ({
    agentId: normalizeAgentId(row.agent_id),
    path: resolveOpenClawRegisteredAgentDatabasePath(state.path, row.path),
  }));
  const configured = resolveConfiguredAgentDatabaseTargets(config, {
    env,
    registeredDatabases: registered,
  });
  // The fixed-store family owner also finds retained suffixed stores without registry rows.
  for (const pathname of resolveConfiguredAgentDatabaseCandidatePaths(config, { env })) {
    const stat = fs.statSync(pathname, { throwIfNoEntry: false });
    if (!stat) {
      continue;
    }
    const metadata = readDatabase(pathname, readExistingAgentSchemaMeta);
    if (!metadata?.agentId) {
      throw new Error(`Missing session database owner at ${pathname}`);
    }
    configured.push({ agentId: metadata.agentId, path: pathname });
  }
  const discovery = discoverAgentDatabaseMigrationTargets({
    configuredAgentDatabaseTargets: configured,
    registeredAgentDatabases: registered,
    env,
  });
  // A registered source was once present. Its absence is not proof that its groups were empty.
  if (
    discovery.failures.length ||
    discovery.externalWarnings.length ||
    discovery.registryRemovals.length
  ) {
    throw new Error(
      [
        ...discovery.failures.map((failure) => failure.reason),
        ...discovery.externalWarnings,
        ...discovery.registryRemovals.map(
          (source) => `Unavailable registered session store: ${source.path}`,
        ),
      ].join("\n"),
    );
  }
  const owners = new Set(listConfiguredSessionStoreAgentIds(config));
  const members: Member[] = [];
  const sources: Inventory["sources"] = [];
  // Canonical metadata wins over retained legacy files, including an explicitly cleared category.
  const canonicalCategories = new Map<string, string>();
  for (const source of discovery.targets.toSorted((a, b) => a.path.localeCompare(b.path))) {
    sources.push({ path: source.path, identity: sourceIdentity(source.path) });
    const rows = readDatabase(source.path, (database) => {
      assertOpenClawAgentDatabaseOwner(database, {
        agentId: source.agentId,
        pathname: source.path,
      });
      assertSupportedAgentSchemaVersion(database, source.path);
      assertSqliteIntegrity(database, source.path);
      return readMembers(database, source.path, source.agentId);
    });
    owners.add(source.agentId);
    for (const row of rows) {
      owners.add(row.owner);
      const key = `${row.owner}\0${row.key}`;
      const previous = canonicalCategories.get(key);
      if (previous !== undefined && previous !== row.category) {
        throw new Error(
          `Conflicting canonical session categories for ${row.key}; repair duplicate session stores before migrating groups.`,
        );
      }
      canonicalCategories.set(key, row.category);
      members.push(row);
    }
  }
  const legacyTargets = [
    ...resolveAllAgentSessionStoreCandidateTargetsSync(config, {
      env,
      registeredDatabases: registered,
    }),
    // Discovery may skip unreadable locators. Retain explicit paths as required
    // probes, after its authoritative fixed-store owner selection.
    ...listConfiguredSessionStoreAgentIds(config).map((agentId) => ({
      agentId,
      storePath: resolveSessionStorePathCore(config.session?.store, { agentId, env }),
    })),
  ];
  const rootStore = path.join(resolveStateDir(env), "sessions", "sessions.json");
  if (fs.statSync(rootStore, { throwIfNoEntry: false })) {
    legacyTargets.push({ agentId: resolveAmbientOwnerAgentId(config), storePath: rootStore });
  }
  const seenLegacy = new Set<string>();
  for (const target of legacyTargets) {
    if (target.storePath.endsWith(".sqlite")) {
      continue;
    }
    const stat = fs.statSync(target.storePath, { throwIfNoEntry: false });
    if (!stat) {
      continue;
    }
    const real = fs.realpathSync.native(target.storePath);
    if (seenLegacy.has(real)) {
      continue;
    }
    seenLegacy.add(real);
    const legacy = readSessionGroupLegacyIndex(target.storePath);
    const sourceSha256 = legacy.sourceSha256;
    sources.push({ path: target.storePath, identity: legacy.identity });
    const importedOwners = new Map<string, boolean>();
    for (const { sessionKey, category } of legacy.entries) {
      const parsed = parseAgentSessionKey(sessionKey);
      if (sessionKey.startsWith("agent:") && !parsed) {
        throw new Error(`Unresolved logical session owner at ${target.storePath}: ${sessionKey}`);
      }
      const owner = normalizeAgentId(parsed?.agentId ?? target.agentId);
      owners.add(owner);
      let imported = importedOwners.get(owner);
      if (imported === undefined) {
        const sqlite = resolveSqliteTargetFromSessionStorePath(target.storePath, {
          agentId: owner,
          env,
          registeredDatabases: registered,
        });
        // Retained plugin source bytes may outlive an acknowledged core import and
        // explicit session deletion. Its existing receipt owner decides supersession.
        imported = wasSessionGroupSourceImported({
          agentId: owner,
          storePath: target.storePath,
          sqlitePath: sqlite.path,
          database: state.db,
          sourceSha256,
        });
        importedOwners.set(owner, imported);
      }
      if (!imported && !canonicalCategories.has(`${owner}\0${sessionKey}`)) {
        members.push({ owner, key: sessionKey, category });
      }
    }
  }
  return {
    owners: [...owners].toSorted(),
    members: members.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    sources: sources.toSorted((a, b) => a.path.localeCompare(b.path)),
  };
}

function readLegacyCatalog(database: DatabaseSync): { groups: Group[]; order: string[] } {
  const groups = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<GroupDatabase>(database)
      .selectFrom("session_groups")
      .select(["name", "position", "created_at"])
      .select(tableHasColumn(database, "session_groups", "cwd") ? "cwd" : sql<null>`NULL`.as("cwd"))
      .select(
        tableHasColumn(database, "session_groups", "worktree")
          ? "worktree"
          : sql<null>`NULL`.as("worktree"),
      )
      .orderBy("position")
      .orderBy("name"),
  ).rows;
  if (
    groups.some(
      (group) =>
        !group.name ||
        group.name !== group.name.trim() ||
        (group.worktree !== null && group.worktree !== 0 && group.worktree !== 1),
    )
  ) {
    throw new Error(
      "Legacy session group metadata is invalid; repair the source before migration.",
    );
  }
  const row = readConfigMachineStateRowInDatabase(database, LEGACY_SESSION_GROUP_SECTION_ORDER_KEY);
  const order: unknown = row ? JSON.parse(row.value_json) : [];
  if (!Array.isArray(order) || order.some((item) => typeof item !== "string")) {
    throw new Error("Legacy session group section order must be a string array.");
  }
  return { groups, order };
}

/** Old audit-only schemas have no group catalog and remain with schema bootstrap. */
export function hasPendingLegacySessionGroupCatalog(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => !isSessionGroupCatalogReady(db) && hasLegacySessionGroupClassification(db),
      { env },
    ) ?? false
  );
}

/** Preserve unavailable source evidence before another Doctor owner cleans stale registrations. */
export function assertSessionGroupMigrationSourcesAvailable(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  withExistingOpenClawStateDatabaseReadOnly(
    (database) => {
      if (
        !isSessionGroupCatalogReady(database.db) &&
        hasLegacySessionGroupClassification(database.db)
      ) {
        inventory(config, env, database);
      }
    },
    { env },
  );
}

/** Idempotent: one shared transaction publishes all catalogs, orders, and the completion receipt. */
export async function migrateDoctorSessionGroups(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MigrationMessages> {
  const ready = withExistingOpenClawStateDatabaseReadOnly(
    ({ db }) => isSessionGroupCatalogReady(db),
    { env },
  );
  if (ready) {
    return { changes: [], warnings: [] };
  }
  // Existing-schema lease admission must not advance the schema before source
  // verification and recovery capture. A genuinely absent database can bootstrap.
  return withAgentDatabaseMaintenanceLease(
    { env, ...(ready === undefined ? {} : { schemaPolicy: "existing" }) },
    async (maintenance) => {
      maintenance.assertOwned();
      const prepared = withExistingOpenClawStateDatabaseReadOnly(
        (database) => {
          if (isSessionGroupCatalogReady(database.db)) {
            return undefined;
          }
          return {
            before: inventory(config, env, database),
            legacyCatalog: readLegacyCatalog(database.db),
          };
        },
        { env },
      );
      if (!prepared) {
        return { changes: [], warnings: [] };
      }
      const { before, legacyCatalog } = prepared;
      const fingerprint = digest({ inventory: before, legacyCatalog });
      const pathname = resolveOpenClawStateSqlitePath(env);
      // The shared file is the only mutation target. Session stores and legacy files
      // remain byte-identical; retain a WAL-aware, verified recovery snapshot before cutover.
      let backupPath: string | undefined;
      if (
        legacyCatalog.groups.length ||
        legacyCatalog.order.length ||
        before.members.some((member) => member.category)
      ) {
        const backupDir = path.join(resolveStateDir(env), "backups", "session-group-migration");
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        backupPath = path.join(backupDir, `${randomUUID()}.sqlite`);
        await createVerifiedSqliteSnapshot({
          sourcePath: pathname,
          targetPath: backupPath,
          preserveRowIds: true,
          beforePublish: () => maintenance.assertOwned(),
        });
        maintenance.assertOwned();
      }
      // Recheck the exact prepared facts before the opener can publish schema 18.
      withExistingOpenClawStateDatabaseReadOnly(
        (database) => {
          if (
            digest({
              inventory: inventory(config, env, database),
              legacyCatalog: readLegacyCatalog(database.db),
            }) !== fingerprint
          ) {
            throw new Error("Session group migration sources changed before commit; rerun Doctor.");
          }
        },
        { env },
      );
      const database = openOpenClawStateDatabase({ env });
      const changed = runOpenClawStateWriteTransaction(
        ({ db }) => {
          maintenance.assertOwnedInTransaction(db);
          if (isSessionGroupCatalogReady(db)) {
            return false;
          }
          const k = getNodeSqliteKysely<GroupDatabase>(db);
          if (
            executeSqliteQuerySync(
              db,
              k.selectFrom("agent_session_groups").select("agent_id").limit(1),
            ).rows.length
          ) {
            throw new Error(
              "Owned session group rows exist without their migration receipt; refusing to overwrite them.",
            );
          }
          const currentInventory = inventory(config, env, { db, path: database.path });
          const currentCatalog = readLegacyCatalog(db);
          if (
            digest({ inventory: currentInventory, legacyCatalog: currentCatalog }) !== fingerprint
          ) {
            throw new Error("Session group migration sources changed before commit; rerun Doctor.");
          }
          const { groups, order } = currentCatalog;
          const destinations = new Map<string, Group[]>(before.owners.map((owner) => [owner, []]));
          const members = new Map<string, Set<string>>();
          for (const member of before.members) {
            if (!member.category) {
              continue;
            }
            const owners = members.get(member.category) ?? new Set<string>();
            owners.add(member.owner);
            members.set(member.category, owners);
          }
          const append = (owner: string, group: Group) => {
            const rows = destinations.get(owner) ?? [];
            rows.push(group);
            destinations.set(owner, rows);
          };
          for (const group of groups) {
            for (const owner of members.get(group.name) ?? [resolveAmbientOwnerAgentId(config)]) {
              append(owner, group);
            }
          }
          let position = groups.reduce((max, group) => Math.max(max, group.position), -1) + 1;
          const names = new Set(groups.map((group) => group.name));
          for (const [name, owners] of [...members].toSorted(([a], [b]) => a.localeCompare(b))) {
            if (names.has(name)) {
              continue;
            }
            const group: Group = {
              name,
              position: position++,
              created_at: 0,
              cwd: null,
              worktree: null,
            };
            for (const owner of owners) {
              append(owner, group);
            }
          }
          const now = Date.now();
          for (const [owner, rows] of destinations) {
            const key = sessionGroupSectionOrderKey(owner);
            if (readConfigMachineStateRowInDatabase(db, key)) {
              throw new Error(
                `Owned session group order already exists for ${owner} without its migration receipt.`,
              );
            }
            for (const row of rows) {
              executeSqliteQuerySync(
                db,
                k.insertInto("agent_session_groups").values({ ...row, agent_id: owner }),
              );
            }
            const ownedNames = new Set(rows.map((row) => row.name));
            const scopedOrder = [
              ...new Set(
                order.filter(
                  (id) =>
                    !id.startsWith("category:") || ownedNames.has(id.slice("category:".length)),
                ),
              ),
            ];
            executeSqliteQuerySync(
              db,
              k.insertInto("config_machine_state").values({
                state_key: key,
                value_json: JSON.stringify(scopedOrder),
                updated_at_ms: now,
              }),
            );
          }
          maintenance.assertOwnedInTransaction(db);
          executeSqliteQuerySync(
            db,
            k.insertInto("config_machine_state").values({
              state_key: SESSION_GROUP_MIGRATION_KEY,
              value_json: JSON.stringify({
                version: 1,
                sourceFingerprint: fingerprint,
                completedAtMs: now,
                ...(backupPath ? { backupPath } : {}),
              }),
              updated_at_ms: now,
            }),
          );
          return true;
        },
        { env, database },
      );
      return {
        changes: changed
          ? ["Migrated session groups to independent agent-owned catalogs (state schema 18)"]
          : [],
        warnings: [],
      };
    },
  );
}
