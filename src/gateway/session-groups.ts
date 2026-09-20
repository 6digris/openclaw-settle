// Gateway-owned custom session groups. Catalog identity is (agent, name);
// membership remains the category on that agent's session entry.
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Insertable } from "kysely";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import {
  applySessionEntryReplacements,
  listSessionEntriesReadOnly,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { createOpenClawAgentDatabasePathMatcher } from "../state/openclaw-agent-db-registry.js";
import type { DB as StateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { sessionGroupSectionOrderKey } from "../state/session-group-ownership.js";
import { assertSessionGroupCatalogReady } from "../state/session-group-readiness.js";
import { consumeSessionGroupImport } from "./session-group-import.js";
import {
  SessionMutationAuthorizationChangedError,
  type SessionMutationTarget,
} from "./session-mutation-authorization-error.js";

type SessionGroupRecord = { name: string; position: number };
type SessionGroupDefaultsRecord = { name: string; cwd?: string; worktree?: boolean };
type SessionGroupsDatabase = Pick<StateDatabase, "agent_session_groups" | "config_machine_state">;
type GroupInsert = Omit<Insertable<StateDatabase["agent_session_groups"]>, "agent_id">;

export class SessionGroupNotFoundError extends Error {
  constructor(name: string) {
    super(`unknown session group: ${name}`);
    this.name = "SessionGroupNotFoundError";
  }
}
export class SessionGroupNotEmptyError extends Error {
  constructor(readonly groups: ReadonlyArray<{ name: string; memberSessions: number }>) {
    super(
      `sessions.groups.put cannot drop groups that still have member sessions: ${groups.map((group) => `"${group.name}" (${group.memberSessions})`).join(", ")}; include them in names or remove them via sessions.groups.delete`,
    );
    this.name = "SessionGroupNotEmptyError";
  }
}

const dbFor = (env: NodeJS.ProcessEnv) => openOpenClawStateDatabase({ env }).db;
const kyselyFor = (db: DatabaseSync) => getNodeSqliteKysely<SessionGroupsDatabase>(db);
// Keep the owner predicate on every catalog read/update/delete, including empty puts.
function catalogFor(db: DatabaseSync, agentId: string) {
  assertSessionGroupCatalogReady(db);
  const k = kyselyFor(db);
  return {
    select: k.selectFrom("agent_session_groups").where("agent_id", "=", agentId),
    update: k.updateTable("agent_session_groups").where("agent_id", "=", agentId),
    remove: k.deleteFrom("agent_session_groups").where("agent_id", "=", agentId),
  };
}
function insertGroup(db: DatabaseSync, agentId: string, group: GroupInsert) {
  return executeSqliteQuerySync(
    db,
    kyselyFor(db)
      .insertInto("agent_session_groups")
      .values({ ...group, agent_id: agentId }),
  );
}

function updateSidebarSectionOrder(
  db: DatabaseSync,
  agentId: string,
  update: (current: string[] | undefined) => string[] | undefined,
): void {
  const k = kyselyFor(db);
  const key = sessionGroupSectionOrderKey(agentId);
  const row = executeSqliteQuerySync(
    db,
    k.selectFrom("config_machine_state").select("value_json").where("state_key", "=", key),
  ).rows[0];
  // SAFETY: The group owner and its migration write only string arrays to this key.
  const next = update(row ? (JSON.parse(row.value_json) as string[]) : undefined);
  if (!next) {
    return;
  }
  const valueJson = JSON.stringify(next);
  const updatedAtMs = Date.now();
  executeSqliteQuerySync(
    db,
    k
      .insertInto("config_machine_state")
      .values({ state_key: key, value_json: valueJson, updated_at_ms: updatedAtMs })
      .onConflict((c) =>
        c.column("state_key").doUpdateSet({ value_json: valueJson, updated_at_ms: updatedAtMs }),
      ),
  );
}

export function normalizeGroupNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of names) {
    const name = normalizeOptionalString(raw);
    if (name && !seen.has(name)) {
      seen.add(name);
      normalized.push(name);
    }
  }
  return normalized;
}
function normalizeSidebarSectionOrder(
  sectionOrder: readonly string[],
  groupNames: readonly string[],
): string[] {
  const groups = new Set(groupNames);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of sectionOrder) {
    const sectionId = raw.trim();
    let canonical: string | null = null;
    if (sectionId === "ungrouped" || sectionId === "groups" || sectionId === "work") {
      canonical = sectionId;
    } else if (sectionId.startsWith("category:")) {
      const name = normalizeOptionalString(sectionId.slice("category:".length));
      if (name && groups.has(name)) {
        canonical = "category:" + name;
      }
    } else if (sectionId.startsWith("catalog:")) {
      const id = normalizeOptionalString(sectionId.slice("catalog:".length));
      if (id) {
        canonical = "catalog:" + id;
      }
    }
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      normalized.push(canonical);
    }
  }
  return normalized;
}
export function listSessionGroups(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionGroupRecord[] {
  const db = dbFor(env);
  return executeSqliteQuerySync(
    db,
    catalogFor(db, agentId).select.select(["name", "position"]).orderBy("position").orderBy("name"),
  ).rows;
}
export function listSessionGroupDefaults(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): SessionGroupDefaultsRecord[] {
  const db = dbFor(env);
  return executeSqliteQuerySync(
    db,
    catalogFor(db, agentId)
      .select.select(["name", "cwd", "worktree"])
      .orderBy("position")
      .orderBy("name"),
  ).rows.map((row) => {
    const record: SessionGroupDefaultsRecord = { name: row.name };
    if (row.cwd) {
      record.cwd = row.cwd;
    }
    if (row.worktree !== null) {
      record.worktree = row.worktree === 1;
    }
    return record;
  });
}
export function listSidebarSectionOrder(
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  assertSessionGroupCatalogReady(dbFor(env));
  return readConfigMachineState<string[]>(sessionGroupSectionOrderKey(agentId), { env }) ?? [];
}

/** Replace one owner's catalog, or atomically append names without overwriting newer state. */
export function putSessionGroups(params: {
  agentId: string;
  cfg: OpenClawConfig;
  names: readonly string[];
  sectionOrder?: readonly string[];
  append?: boolean;
  importId?: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  assertTargetCurrent?: (target: { agentId?: string; sessionKey: string }) => void;
}): SessionGroupRecord[] {
  const { agentId, cfg, names, sectionOrder, env = process.env } = params;
  if (params.append && sectionOrder !== undefined) {
    throw new Error("append cannot replace sectionOrder");
  }
  if (
    params.importId !== undefined &&
    (!params.append || !params.importId.trim() || params.importId.length > 128)
  ) {
    throw new Error(
      "importId requires append:true and a non-empty identifier of at most 128 characters",
    );
  }
  const normalized = normalizeGroupNames(names);
  const normalizedOrder =
    sectionOrder === undefined ? undefined : normalizeSidebarSectionOrder(sectionOrder, normalized);
  params.assertCurrent?.();
  const dropped = params.append
    ? []
    : listSessionGroups(agentId, env).filter((g) => !normalized.includes(g.name));
  if (dropped.length) {
    const targets = resolveSessionGroupMutationTargetsByName(cfg, agentId, env);
    for (const { name } of dropped) {
      for (const target of targets.get(name) ?? []) {
        params.assertTargetCurrent?.(target);
      }
    }
    const nonEmpty = dropped
      .map(({ name }) => ({ name, memberSessions: targets.get(name)?.length ?? 0 }))
      .filter((g) => g.memberSessions > 0);
    if (nonEmpty.length) {
      throw new SessionGroupNotEmptyError(nonEmpty);
    }
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      params.assertCurrent?.();
      const catalog = catalogFor(db, agentId);
      const existing = new Map(
        executeSqliteQuerySync(
          db,
          catalog.select.select(["name", "position", "created_at"]),
        ).rows.map((row) => [row.name, row]),
      );
      if (!params.append) {
        executeSqliteQuerySync(
          db,
          normalized.length ? catalog.remove.where("name", "not in", normalized) : catalog.remove,
        );
      }
      let tail = 0;
      for (const row of existing.values()) {
        tail = Math.max(tail, row.position + 1);
      }
      const now = Date.now();
      const admittedNames =
        params.importId === undefined
          ? normalized
          : consumeSessionGroupImport(db, agentId, params.importId, normalized);
      admittedNames.forEach((name, position) => {
        const prior = existing.get(name);
        if (prior) {
          if (!params.append) {
            executeSqliteQuerySync(db, catalog.update.set({ position }).where("name", "=", name));
          }
        } else {
          insertGroup(db, agentId, {
            name,
            position: params.append ? tail++ : position,
            created_at: now,
          });
        }
      });
      if (normalizedOrder) {
        updateSidebarSectionOrder(db, agentId, () => normalizedOrder);
      }
    },
    { env },
  );
  return listSessionGroups(agentId, env);
}

/** Register only in the committed session's owner, never the caller's selected view. */
export function ensureSessionGroupRegistered(
  agentId: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const normalized = normalizeOptionalString(name);
  if (!normalized) {
    return false;
  }
  const readDb = dbFor(env);
  if (
    executeSqliteQuerySync(
      readDb,
      catalogFor(readDb, agentId).select.select("name").where("name", "=", normalized).limit(1),
    ).rows[0]
  ) {
    return false;
  }
  let inserted = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const catalog = catalogFor(db, agentId);
      if (
        executeSqliteQuerySync(
          db,
          catalog.select.select("name").where("name", "=", normalized).limit(1),
        ).rows[0]
      ) {
        return;
      }
      const last = executeSqliteQuerySync(
        db,
        catalog.select.select("position").orderBy("position", "desc").limit(1),
      ).rows[0];
      insertGroup(db, agentId, {
        name: normalized,
        position: (last?.position ?? -1) + 1,
        created_at: Date.now(),
      });
      inserted = true;
    },
    { env },
  );
  return inserted;
}
function readCatalogEntry(db: DatabaseSync, agentId: string, name: string) {
  return executeSqliteQuerySync(
    db,
    catalogFor(db, agentId).select.selectAll().where("name", "=", name).limit(1),
  ).rows[0];
}
function prepareCatalogRename(
  agentId: string,
  from: string,
  to: string,
  env: NodeJS.ProcessEnv,
  assertCurrent?: () => void,
) {
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent?.();
      const source = readCatalogEntry(db, agentId, from);
      if (!source) {
        throw new SessionGroupNotFoundError(from);
      }
      // Preserve both names through the guarded session sweep. Existing targets keep defaults.
      if (!readCatalogEntry(db, agentId, to)) {
        insertGroup(db, agentId, { ...source, name: to });
      }
      return source;
    },
    { env },
  );
}
function retireCatalogEntry(
  agentId: string,
  from: string,
  to: string | undefined,
  source: ReturnType<typeof readCatalogEntry>,
  env: NodeJS.ProcessEnv,
  assertCurrent?: () => void,
): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent?.();
      if (!isDeepStrictEqual(readCatalogEntry(db, agentId, from), source)) {
        throw new Error(`session group ${JSON.stringify(from)} changed before completion`);
      }
      if (to !== undefined && !readCatalogEntry(db, agentId, to)) {
        throw new SessionGroupNotFoundError(to);
      }
      executeSqliteQuerySync(db, catalogFor(db, agentId).remove.where("name", "=", from));
      const fromId = "category:" + from;
      const toId = to === undefined ? undefined : "category:" + to;
      updateSidebarSectionOrder(db, agentId, (current) =>
        !current?.includes(fromId)
          ? undefined
          : toId === undefined || current.includes(toId)
            ? current.filter((id) => id !== fromId)
            : current.map((id) => (id === fromId ? toId : id)),
      );
    },
    { env },
  );
}
export function updateSessionGroupDefaults(
  agentId: string,
  name: string,
  defaults: { cwd: string | null; worktree: boolean },
  env: NodeJS.ProcessEnv = process.env,
  assertCurrent?: () => void,
): SessionGroupDefaultsRecord[] | null {
  const normalized = normalizeOptionalString(name);
  if (!normalized) {
    throw new Error("group defaults update requires a non-empty name");
  }
  let updated = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      assertCurrent?.();
      const result = executeSqliteQuerySync(
        db,
        catalogFor(db, agentId)
          .update.set({
            cwd: normalizeOptionalString(defaults.cwd) ?? null,
            worktree: defaults.worktree ? 1 : 0,
          })
          .where("name", "=", normalized),
      );
      updated = result.numAffectedRows === 1n;
    },
    { env },
  );
  return updated ? listSessionGroupDefaults(agentId, env) : null;
}

function* sessionGroupStores(cfg: OpenClawConfig, agentId: string, env: NodeJS.ProcessEnv) {
  const visited: string[] = [];
  const isSamePath = createOpenClawAgentDatabasePathMatcher();
  for (const target of resolveAgentSessionStoreTargetsSync(cfg, agentId, { env })) {
    const resolved = resolveSqliteTargetFromSessionStorePath(target.storePath, {
      agentId,
      defaultAgentId: tryResolveLegacyCompatibilityAgentId(cfg),
      env,
    });
    if (visited.some((pathname) => isSamePath(pathname, resolved.path))) {
      continue;
    }
    visited.push(resolved.path);
    const entries = listSessionEntriesReadOnly({
      agentId,
      storePath: target.storePath,
      env,
      projection: "list",
      clone: false,
    }).filter(
      ({ sessionKey }) =>
        normalizeAgentId(
          parseAgentSessionKey(sessionKey)?.agentId ?? resolved.agentId ?? agentId,
        ) === agentId,
    );
    yield { storePath: target.storePath, entries };
  }
}
export function resolveSessionGroupMutationTargetsByName(
  cfg: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): Map<string, SessionMutationTarget[]> {
  const result = new Map<string, SessionMutationTarget[]>();
  for (const { entries } of sessionGroupStores(cfg, agentId, env)) {
    for (const { sessionKey, entry } of entries) {
      const name = normalizeOptionalString(entry.category);
      if (!name) {
        continue;
      }
      const targets = result.get(name) ?? [];
      targets.push({ agentId, sessionKey });
      result.set(name, targets);
    }
  }
  return result;
}
async function updateMemberCategories(
  cfg: OpenClawConfig,
  agentId: string,
  from: string,
  to: string | undefined,
  env: NodeJS.ProcessEnv,
  assertTargetCurrent?: (target: { agentId: string; sessionKey: string }) => void,
  assertCurrent?: () => void,
): Promise<number> {
  let updated = 0;
  for (const target of sessionGroupStores(cfg, agentId, env)) {
    const sessionKeys = target.entries
      .filter(({ entry }) => entry.category?.trim() === from)
      .map(({ sessionKey }) => sessionKey);
    if (!sessionKeys.length) {
      continue;
    }
    let changedSessionKeys: string[] = [];
    updated += await applySessionEntryReplacements<number>({
      storePath: target.storePath,
      agentId,
      sessionKeys,
      assertCommitAllowed: () => {
        assertCurrent?.();
        for (const sessionKey of changedSessionKeys) {
          assertTargetCurrent?.({ agentId, sessionKey });
        }
        if (to !== undefined && !readCatalogEntry(dbFor(env), agentId, to)) {
          throw new SessionGroupNotFoundError(to);
        }
      },
      update: (entries) => {
        const replacements = entries.flatMap(({ sessionKey, entry }) => {
          if (entry.category?.trim() !== from) {
            return [];
          }
          assertTargetCurrent?.({ agentId, sessionKey });
          const next = { ...entry };
          if (to === undefined) {
            delete next.category;
          } else {
            next.category = to;
          }
          return [{ sessionKey, entry: next }];
        });
        changedSessionKeys = replacements.map(({ sessionKey }) => sessionKey);
        return { replacements, result: replacements.length };
      },
    });
  }
  return updated;
}
type SessionGroupMutationParams = {
  agentId: string;
  cfg: OpenClawConfig;
  name: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  assertTargetCurrent?: (target: { agentId: string; sessionKey: string }) => void;
};
async function mutateSessionGroup(
  params: SessionGroupMutationParams & { to?: string },
  action: "rename" | "delete",
): Promise<{ groups: SessionGroupRecord[]; sectionOrder: string[]; updatedSessions: number }> {
  const env = params.env ?? process.env;
  const { agentId } = params;
  const from = normalizeOptionalString(params.name);
  const to = action === "rename" ? normalizeOptionalString(params.to) : undefined;
  if (!from || (action === "rename" && !to)) {
    throw new Error(
      action === "rename"
        ? "group rename requires non-empty names"
        : "group delete requires a non-empty name",
    );
  }
  let updatedSessions = 0;
  if (from !== to) {
    params.assertCurrent?.();
    const source =
      to === undefined
        ? readCatalogEntry(dbFor(env), agentId, from)
        : prepareCatalogRename(agentId, from, to, env, params.assertCurrent);
    try {
      updatedSessions = await updateMemberCategories(
        params.cfg,
        agentId,
        from,
        to,
        env,
        params.assertTargetCurrent,
        params.assertCurrent,
      );
      params.assertCurrent?.();
      if (resolveSessionGroupMutationTargetsByName(params.cfg, agentId, env).get(from)?.length) {
        throw new Error(`session group ${JSON.stringify(from)} still has members`);
      }
      retireCatalogEntry(agentId, from, to, source, env, params.assertCurrent);
    } catch (error) {
      const message = `${formatErrorMessage(error)}. Group changes may be partial; reload groups and retry the same operation.`;
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw new SessionMutationAuthorizationChangedError({ ...error.error, message });
      }
      throw new Error(message, { cause: error });
    }
  }
  return {
    groups: listSessionGroups(agentId, env),
    sectionOrder: listSidebarSectionOrder(agentId, env),
    updatedSessions,
  };
}
export async function renameSessionGroup(params: SessionGroupMutationParams & { to: string }) {
  return await mutateSessionGroup(params, "rename");
}
export async function deleteSessionGroup(params: SessionGroupMutationParams) {
  return await mutateSessionGroup(params, "delete");
}
