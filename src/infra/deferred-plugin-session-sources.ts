import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import {
  MigrationArtifactSchema,
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  type MigrationArtifactIdentity,
} from "../commands/doctor-session-sqlite-artifact.js";
import {
  filterRestoreManifestTargets,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
} from "../commands/doctor-session-sqlite-migration-run.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { readFileDescriptorBoundedSync } from "./boundary-file-read.js";
import type { DeferredPluginMigration } from "./deferred-plugin-migrations.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";

type SessionImportTarget = { agentId: string; storePath: string; sqlitePath: string };
const RECEIPT_KIND = "deferred-plugin-session-import";
const receiptSchema = z.object({
  databaseIdentity: z.string(),
  pluginIds: z.array(z.string()),
  sources: z.array(
    z.object({ path: z.string(), identity: MigrationArtifactSchema.shape.identity }),
  ),
});
export type DeferredPluginSessionImport = z.infer<typeof receiptSchema>;

export function deferredPluginSessionStoreIds(params: {
  target: { agentId: string; storePath: string };
  pending: readonly DeferredPluginMigration[];
}): string[] {
  if (params.target.storePath.endsWith(".sqlite")) {
    return [];
  }
  // The session owner selected this target. An unavailable plugin cannot yet narrow its inputs.
  return params.pending.map((pending) => pending.pluginId);
}

/** File-era repair must not rewrite an original that a deferred owner still needs. */
export function preserveDeferredPluginSessionSource(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  target: { agentId: string; storePath: string };
  pending: readonly DeferredPluginMigration[];
}): boolean {
  if (deferredPluginSessionStoreIds(params).length > 0) {
    return true;
  }
  const sqlite = resolveSqliteTargetFromSessionStorePath(params.target.storePath, {
    agentId: params.target.agentId,
    env: params.env,
  });
  return (
    readDeferredPluginSessionImport({
      target: { ...params.target, sqlitePath: sqlite.path },
      env: params.env,
    }) !== undefined
  );
}

function sourceKey(target: SessionImportTarget): string {
  return resolveLegacyMigrationSourceKey(
    RECEIPT_KIND,
    target.storePath,
    `${target.agentId}\0${path.resolve(target.sqlitePath)}`,
  );
}

function databaseIdentity(sqlitePath: string): string {
  const file = fs.lstatSync(sqlitePath, { bigint: true });
  if (!file.isFile()) {
    throw new Error("The imported session database is no longer a regular file.");
  }
  return `${file.dev}:${file.ino}`;
}

function sourceIsArchived(
  source: DeferredPluginSessionImport["sources"][number],
  target: SessionImportTarget,
  env: NodeJS.ProcessEnv,
): boolean {
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(env)) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    if (!manifest) {
      continue;
    }
    for (const candidate of filterRestoreManifestTargets(manifest, [target])) {
      for (const move of candidate.plannedMoves) {
        if (
          move.sourcePath === source.path &&
          move.artifact &&
          sameMigrationArtifact(move.artifact.identity, source.identity) &&
          fs.existsSync(move.archivePath) &&
          sameMigrationArtifact(readMigrationArtifactIdentity(move.archivePath), source.identity)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function matchesVerifiedSessionSource(
  source: DeferredPluginSessionImport["sources"][number],
  target: SessionImportTarget,
  env: NodeJS.ProcessEnv,
): boolean {
  return fs.existsSync(source.path)
    ? sameMigrationArtifact(readMigrationArtifactIdentity(source.path), source.identity)
    : sourceIsArchived(source, target, env);
}

/** A completed core import remains authoritative after canonical sessions change or are deleted. */
export function readDeferredPluginSessionImport(params: {
  target: SessionImportTarget;
  env: NodeJS.ProcessEnv;
  database?: DatabaseSync;
}): DeferredPluginSessionImport | undefined {
  const read = (db: DatabaseSync) =>
    tableExists(db, "migration_sources")
      ? readLegacyMigrationReceiptFromDatabase(db, sourceKey(params.target))
      : undefined;
  const receipt = params.database
    ? read(params.database)
    : withExistingOpenClawStateDatabaseReadOnly(({ db }) => read(db), { env: params.env });
  if (!receipt) {
    return undefined;
  }
  const recorded = receiptSchema.parse(JSON.parse(receipt.reportJson));
  if (recorded.databaseIdentity !== databaseIdentity(params.target.sqlitePath)) {
    throw new Error(
      "The verified session import database changed; retained source was not replayed.",
    );
  }
  for (const source of recorded.sources) {
    if (!matchesVerifiedSessionSource(source, params.target, params.env)) {
      throw new Error(
        `Retained session migration source changed: ${source.path}. Resolve the source conflict before running openclaw doctor --fix again; the verified import was not replayed.`,
      );
    }
  }
  return recorded;
}

/** Global file-era rows keep their original owner while each agent imports its partition. */
export function resolveLegacyGlobalSessionEntryAgentId(
  cfg: OpenClawConfig,
  sessionKey: string,
): string | undefined {
  const ownerAgentId =
    parseAgentSessionKey(sessionKey)?.agentId ??
    cfg.agents?.defaults?.sessionStore?.agentId?.trim() ??
    tryResolveLegacyCompatibilityAgentId(cfg);
  return ownerAgentId ? normalizeAgentId(ownerAgentId) : undefined;
}

function readVerifiedRetainedIndexKeys(
  source: DeferredPluginSessionImport["sources"][number],
): string[] {
  const fd = fs.openSync(
    source.path,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size !== source.identity.size) {
      throw new Error("Retained session migration index changed before admission.");
    }
    const bytes = readFileDescriptorBoundedSync(fd, source.identity.size);
    if (
      createHash("sha256").update(bytes).digest("hex") !== source.identity.sha256 ||
      !sameMigrationArtifact(readMigrationArtifactIdentity(source.path), source.identity)
    ) {
      throw new Error("Retained session migration index changed before admission.");
    }
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(value)) {
      throw new Error("Retained session migration index is not an object.");
    }
    return Object.keys(value);
  } finally {
    fs.closeSync(fd);
  }
}

/** Admit empty global partitions only from an existing import's exact verified source bytes. */
export function prepareRetainedLegacyGlobalSessionAdmission(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets: readonly SessionImportTarget[];
}): (target: SessionImportTarget) => boolean {
  const covered = new Set<string>();
  const indexes = new Map<string, DeferredPluginSessionImport["sources"][number]>();
  for (const target of params.targets) {
    const receipt = readDeferredPluginSessionImport({ target, env: params.env });
    if (!receipt) {
      continue;
    }
    covered.add(sourceKey(target));
    const index = receipt.sources.find((source) => source.path === path.resolve(target.storePath));
    if (index) {
      indexes.set(path.resolve(target.storePath), index);
    }
  }
  const ownersBySource = new Map<string, Set<string | undefined>>();
  for (const target of params.targets) {
    if (covered.has(sourceKey(target))) {
      continue;
    }
    const index = indexes.get(path.resolve(target.storePath));
    if (!index) {
      continue;
    }
    let owners = ownersBySource.get(index.path);
    if (!owners) {
      owners = new Set(
        readVerifiedRetainedIndexKeys(index).map((key) =>
          resolveLegacyGlobalSessionEntryAgentId(params.cfg, key),
        ),
      );
      ownersBySource.set(index.path, owners);
    }
    if (!owners.has(normalizeAgentId(target.agentId))) {
      covered.add(sourceKey(target));
    }
  }
  return (target) => covered.has(sourceKey(target));
}

/** Reuse verified source bytes only within one uninterrupted synchronous migration loop. */
export function prepareDeferredPluginSessionImportReader(params: {
  storePath: string;
  env: NodeJS.ProcessEnv;
}) {
  const verified = new Map<
    string,
    { receipt: LegacyMigrationReceipt | null; imported: DeferredPluginSessionImport | undefined }
  >();
  return (database: DatabaseSync, agentId: string): SessionImportTarget | undefined => {
    const sqlite = resolveSqliteTargetFromSessionStorePath(params.storePath, {
      agentId,
      env: params.env,
    });
    const target = { agentId, storePath: params.storePath, sqlitePath: sqlite.path };
    const key = sourceKey(target);
    const receipt = readLegacyMigrationReceiptFromDatabase(database, key);
    let prepared = verified.get(key);
    if (!prepared || !isDeepStrictEqual(prepared.receipt, receipt)) {
      prepared = {
        receipt,
        imported: readDeferredPluginSessionImport({ target, env: params.env, database }),
      };
      verified.set(key, prepared);
    }
    if (!prepared.imported) {
      return undefined;
    }
    if (prepared.imported.databaseIdentity !== databaseIdentity(target.sqlitePath)) {
      throw new Error(
        "The verified session import database changed; retained source was not replayed.",
      );
    }
    return target;
  };
}

/** Called after full core import validation, before any original can be retired. */
export function recordDeferredPluginSessionImport(params: {
  target: SessionImportTarget;
  env: NodeJS.ProcessEnv;
  pluginIds: string[];
  sources: Array<{ path: string; identity: MigrationArtifactIdentity }>;
  recordCount: number;
}): void {
  const report: DeferredPluginSessionImport = {
    databaseIdentity: databaseIdentity(params.target.sqlitePath),
    pluginIds: params.pluginIds,
    sources: params.sources,
  };
  const index = params.sources.find(
    (source) => source.path === path.resolve(params.target.storePath),
  );
  if (!index) {
    throw new Error("A deferred session import requires its verified original index.");
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      for (const source of params.sources) {
        if (!matchesVerifiedSessionSource(source, params.target, params.env)) {
          throw new Error(
            "Session migration source changed before its import receipt was recorded.",
          );
        }
      }
      if (report.databaseIdentity !== databaseIdentity(params.target.sqlitePath)) {
        throw new Error("Session import database changed before its receipt was recorded.");
      }
      const key = sourceKey(params.target);
      recordLegacyMigrationReceipt(db, {
        sourceKey: key,
        migrationKind: RECEIPT_KIND,
        sourcePath: path.resolve(params.target.storePath),
        targetTable: "session_nodes",
        sourceSha256: index.identity.sha256,
        sourceSizeBytes: index.identity.size,
        sourceRecordCount: params.recordCount,
        runId: key,
        reportJson: JSON.stringify(report),
        now: Date.now(),
      });
    },
    { env: params.env },
    { operationLabel: "state.retain-plugin-session-source" },
  );
}
