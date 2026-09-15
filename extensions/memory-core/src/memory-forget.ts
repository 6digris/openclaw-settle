import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveAgentWorkspaceDir,
  resolveStateDir,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildSessionEntry,
  listSessionTranscriptCorpusEntriesForAgent,
  resolveMemorySessionTargets,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  isFileMissingError,
  listMemoryFiles,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { listMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import {
  borrowOpenClawAgentDatabase,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  resolveOpenClawAgentSqlitePath,
  tableExists,
  withOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { readMemoryPreimages } from "./dreaming-consolidation-artifacts.js";
import { DREAMS_FILENAMES } from "./dreaming-dreams-file.js";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import {
  deleteMemoryEntryOriginsInDatabase,
  readMemoryEntryOrigins,
  type MemoryEntryOrigin,
  recordMemorySessionTombstonesInDatabase,
} from "./memory-entry-origins.js";
import { collectTranscriptWrites } from "./memory-forget-curated-writes.js";
import {
  purgeMemoryIndex,
  referencesSession,
  selectMemoryIndex,
  type ForgetDatabase,
  type ForgetIndexPlan,
  type MemoryIndexSelection,
  type MemoryIndexPurgeResult,
} from "./memory-forget-index-sources.js";
import { summarizeParticipantMatches, type MemoryForgetReport } from "./memory-forget-report.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { isMemorySessionIndexable } from "./memory/manager-session-sync-state.js";
import {
  readSessionIngestionState,
  SESSION_CORPUS_RELATIVE_DIR,
  writeSessionIngestionState,
} from "./session-ingestion.js";
import { commitMemoryContent, hashMemoryContent } from "./short-term-promotion-memory-write.js";
import { readPhaseSignalStore, writePhaseSignalStore } from "./short-term-promotion-store.js";
import type { ShortTermRecallEntry } from "./short-term-promotion-types.js";

type MemoryRewrite = {
  absolutePath: string;
  relativePath: string;
  content: string;
  remove: boolean;
  expectedContent: string;
};

const PROMOTION_MARKER = /^\s*<!--\s*openclaw-memory-promotion:([^\n]*?)\s*-->\s*$/u;
const LINEAGE_MARKER = /^\s*<!--\s*openclaw-memory-lineage:[^\n]*?-->\s*$/u;

function scrubMemoryContent(params: {
  content: string;
  entryKeys: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
  corpusSnippets: ReadonlySet<string>;
  agentId: string;
}): { content: string; removedEntries: number; removedLines: number } {
  // Preserve surviving line endings so unrelated artifacts do not enter the purge plan.
  const lines = params.content.split("\n");
  const corpusSnippets = [...params.corpusSnippets];
  let removedEntries = 0;
  let removedLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const markerKey = PROMOTION_MARKER.exec(lines[index] ?? "")?.[1]?.trim();
    if (markerKey && params.entryKeys.has(markerKey)) {
      const start = index > 0 && LINEAGE_MARKER.test(lines[index - 1] ?? "") ? index - 1 : index;
      let end = index + 1;
      if (end < lines.length && !PROMOTION_MARKER.test(lines[end] ?? "")) {
        end += 1;
        while (end < lines.length && /^\s+\S/u.test(lines[end] ?? "")) {
          end += 1;
        }
      }
      lines.splice(start, end - start);
      removedEntries += 1;
      index = start - 1;
      continue;
    }
    if (corpusSnippets.some((snippet) => lines[index]?.includes(snippet))) {
      lines.splice(index, 1);
      removedLines += 1;
      index -= 1;
      continue;
    }
    if (!referencesSession(lines[index] ?? "", params.agentId, params.sessionIds)) {
      continue;
    }
    const heading = /^(#{1,6})\s/u.exec(lines[index] ?? "");
    const rowIndent = /^(\s*)[-*+]\s/u.exec(lines[index] ?? "")?.[1]?.length;
    if (!heading && !/\bSession ID:/iu.test(lines[index] ?? "")) {
      continue;
    }
    let end = index + 1;
    while (end < lines.length) {
      const nextHeading = /^(#{1,6})\s/u.exec(lines[end] ?? "");
      if (
        (rowIndent !== undefined && (lines[end] ?? "").search(/\S/u) <= rowIndent) ||
        (nextHeading && (!heading || nextHeading[1]!.length <= heading[1]!.length)) ||
        /\bSession ID:/iu.test(lines[end] ?? "")
      ) {
        break;
      }
      end += 1;
    }
    lines.splice(index, end - index);
    removedEntries += 1;
    index -= 1;
  }
  return { content: lines.join("\n"), removedEntries, removedLines };
}

async function planMemoryIndex(
  params: MemoryIndexSelection,
  options: Parameters<typeof withOpenClawAgentDatabaseWrite>[0],
): Promise<ForgetIndexPlan | undefined> {
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db, path: databasePath }) => ({
      plan: selectMemoryIndex(db, params, false),
      databasePath,
    }),
    options,
  );
  if (!result.found) {
    return undefined;
  }
  if (!result.value.plan.hasVectorTable || result.value.plan.chunks.length === 0) {
    return result.value.plan;
  }
  const probe = openNodeSqliteDatabase(":memory:", { allowExtension: true });
  let extensionPath: string;
  try {
    const loaded = await loadSqliteVecExtension({ db: probe });
    if (!loaded.ok || !loaded.extensionPath) {
      throw new Error(
        `memory forget cannot inspect vector index: ${loaded.error ?? "load failed"}`,
      );
    }
    extensionPath = loaded.extensionPath;
  } finally {
    probe.close();
  }
  // Preview does not create or migrate state. Refresh its selection after the
  // asynchronous extension probe on the original owner's read-only handle.
  const refreshed = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => {
      db.enableLoadExtension(true);
      db.loadExtension(extensionPath);
      return selectMemoryIndex(db, params, true);
    },
    { ...options, path: result.value.databasePath },
    { allowExtension: true },
  );
  return refreshed.found ? refreshed.value : undefined;
}

type MemoryForgetParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionIds?: string[];
  hookSources?: string[];
  participants?: string[];
  since?: string;
  dryRun?: boolean;
};

type MemoryForgetContext = {
  databaseOptions: Parameters<typeof withOpenClawAgentDatabaseWrite>[0];
  database?: ReturnType<typeof borrowOpenClawAgentDatabase> & { databasePath: string };
  targets: ReturnType<typeof resolveMemorySessionTargets>;
  sessionStore: { path: string; configuredPath?: string };
  origins: MemoryEntryOrigin[];
  tombstoned: boolean;
  vectorReady: boolean;
};

type ForgetWorkspaceResult =
  | { kind: "complete"; report: MemoryForgetReport }
  | { kind: "reprepare" };

function selectedLineageIdentity(origins: MemoryEntryOrigin[], sessionIds: ReadonlySet<string>) {
  const keys = new Set(
    origins.filter((origin) => sessionIds.has(origin.sessionId)).map((origin) => origin.entryKey),
  );
  // Other sessions matter only when their lineage makes a selected entry mixed.
  return JSON.stringify(
    origins
      .filter((origin) => keys.has(origin.entryKey))
      .map(({ entryKey, sessionId }) => [entryKey, sessionId]),
  );
}

export async function forgetMemoryEntries(params: MemoryForgetParams): Promise<MemoryForgetReport> {
  if (!params.sessionIds?.length && !params.hookSources?.length && !params.participants?.length) {
    throw new Error("memory forget requires a session, hook source, or participant selector");
  }
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const env = { ...process.env };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const databaseOptions = {
    agentId: params.agentId,
    env,
    path: resolveOpenClawAgentSqlitePath({ agentId: params.agentId, env }),
  };
  const sessionStore = {
    configuredPath: params.cfg.session?.store,
    path: resolveStorePath(params.cfg.session?.store, { agentId: params.agentId, env }),
  };
  const run = async (): Promise<MemoryForgetReport> => {
    const targets = resolveMemorySessionTargets({
      agentId: params.agentId,
      storePath: sessionStore.path,
      sessionIds: params.sessionIds,
      hookSources: params.hookSources,
      participants: params.participants,
      since: params.since,
    });
    const preview = withOpenClawAgentDatabaseReadOnly(
      ({ db }) => (params.dryRun ? readMemoryEntryOrigins(db, { agentId: params.agentId }) : []),
      databaseOptions,
    );
    const origins = !preview.found
      ? []
      : params.dryRun
        ? preview.value
        : await withOpenClawAgentDatabaseWrite(databaseOptions, ({ db }) =>
            readMemoryEntryOrigins(db, { agentId: params.agentId }),
          );
    const context: MemoryForgetContext = {
      databaseOptions,
      targets,
      sessionStore,
      origins,
      tombstoned: false,
      vectorReady: false,
    };
    try {
      for (;;) {
        const result = await forgetWorkspaceMemory(params, workspaceDir, context);
        if (result.kind === "complete") {
          return result.report;
        }
      }
    } finally {
      context.database?.release();
    }
  };
  // Repreparation retains the workspace lock and the exact borrow; preview never writes a lock.
  return params.dryRun ? run() : withMemoryWorkspaceLock(workspaceDir, run);
}

async function forgetWorkspaceMemory(
  params: MemoryForgetParams,
  workspaceDir: string,
  context: MemoryForgetContext,
): Promise<ForgetWorkspaceResult> {
  const targets = context.targets;
  const env = context.databaseOptions.env;
  const sessionIds = new Set(targets.map((target) => target.sessionId));
  const allOrigins = context.origins;
  const lineageIdentity = selectedLineageIdentity(allOrigins, sessionIds);
  const entryKeys = new Set(
    allOrigins
      .filter((origin) => sessionIds.has(origin.sessionId))
      .map((origin) => origin.entryKey),
  );
  const allOriginKeys = new Set(allOrigins.map((origin) => origin.entryKey));
  const mixedLineageEntryKeys = new Set(
    allOrigins
      .filter((origin) => entryKeys.has(origin.entryKey) && !sessionIds.has(origin.sessionId))
      .map((origin) => origin.entryKey),
  );
  const untargetableEntryKeys = new Set<string>();
  const refusals: string[] = [];
  const corpusDir = path.join(workspaceDir, SESSION_CORPUS_RELATIVE_DIR);
  const corpusFiles = await fs
    .readdir(corpusDir, { withFileTypes: true })
    .catch((error: unknown) => {
      if (isFileMissingError(error)) {
        return [];
      }
      throw error;
    });
  const corpusRewrites: MemoryRewrite[] = [];
  const corpusSnippets = new Set<string>();
  let removedCorpusLines = 0;
  for (const file of corpusFiles) {
    if (!file.isFile() || !/\.(?:txt|md)$/iu.test(file.name)) {
      continue;
    }
    const absolutePath = path.join(corpusDir, file.name);
    const content = await fs.readFile(absolutePath, "utf8");
    const lines = content.split("\n");
    const retained = lines.filter((line) => {
      if (!referencesSession(line, params.agentId, sessionIds)) {
        return true;
      }
      const snippet = /^\[[^\]]+#L\d+\]\s*(.+)$/u.exec(line.trimEnd())?.[1]?.trim();
      // Ingestion only admits snippets of at least 12 characters; shorter
      // malformed corpus rows must never trigger broad substring deletion.
      if (snippet && snippet.length >= 12) {
        corpusSnippets.add(snippet);
      }
      return false;
    });
    if (retained.length !== lines.length) {
      removedCorpusLines += lines.length - retained.length;
      const rewritten = retained.join("\n");
      corpusRewrites.push({
        absolutePath,
        relativePath: path.relative(workspaceDir, absolutePath).replaceAll("\\", "/"),
        content: rewritten,
        remove: rewritten.trim().length === 0,
        expectedContent: content,
      });
    }
  }

  const memoryRewrites: MemoryRewrite[] = [];
  const scrub = (content: string) =>
    scrubMemoryContent({ content, entryKeys, sessionIds, corpusSnippets, agentId: params.agentId });
  let removedMemoryEntries = 0;
  let removedMemoryLines = 0;
  const memoryFiles = await listMemoryFiles(
    workspaceDir,
    DREAMS_FILENAMES.map((name) => path.join(workspaceDir, name)),
  );
  for (const absolutePath of memoryFiles) {
    // Corpus evidence must survive until every dependent artifact is clean.
    if (path.dirname(absolutePath) === corpusDir) {
      continue;
    }
    const content = await fs.readFile(absolutePath, "utf8");
    for (const line of content.split(/\r?\n/u)) {
      const key = PROMOTION_MARKER.exec(line)?.[1]?.trim();
      if (key && !allOriginKeys.has(key)) {
        untargetableEntryKeys.add(key);
      }
    }
    const scrubbed = scrub(content);
    if (/^## Memory Consolidation History\r?$[\s\S]*^ {2}- `[+-] /mu.test(scrubbed.content)) {
      refusals.push(
        `Cannot trace historical consolidation highlights in ${path.relative(workspaceDir, absolutePath)}; review them manually.`,
      );
    }
    if (scrubbed.content !== content) {
      memoryRewrites.push({
        absolutePath,
        relativePath: path.relative(workspaceDir, absolutePath).replaceAll("\\", "/"),
        content: scrubbed.content,
        remove: false,
        expectedContent: content,
      });
      removedMemoryEntries += scrubbed.removedEntries;
      removedMemoryLines += scrubbed.removedLines;
    }
  }

  const nowIso = new Date().toISOString();
  const [
    shortTermEntries,
    phaseSignals,
    ingestionState,
    backups,
    artifactProvenance,
    sessionCorpusEntries,
  ] = await Promise.all([
    readMemoryCoreWorkspaceEntries<ShortTermRecallEntry>({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir,
      env,
    }),
    readPhaseSignalStore(workspaceDir, nowIso, env),
    readSessionIngestionState(workspaceDir, env),
    readMemoryPreimages(workspaceDir, env),
    listMemoryArtifactProvenance({ workspaceDir, env }),
    listSessionTranscriptCorpusEntriesForAgent(params.agentId, {
      env,
      resolvedStore: context.sessionStore,
    }),
  ]);
  const sessionKeys = new Set(targets.map((target) => target.sessionKey));
  const curatedWrites = new Map(
    artifactProvenance
      .filter(({ provenance }) =>
        provenance.sessionId
          ? sessionIds.has(provenance.sessionId)
          : Boolean(provenance.sessionKey && sessionKeys.has(provenance.sessionKey)),
      )
      .map(({ relativePath, provenance }) => [
        relativePath,
        { relativePath, observedAt: provenance.observedAt },
      ]),
  );
  const retainedShortTerm = shortTermEntries.filter(
    ({ key, value }) =>
      !entryKeys.has(key) &&
      !entryKeys.has(value.key) &&
      !referencesSession(`${value.path}\n${value.snippet}`, params.agentId, sessionIds),
  );
  const retainedShortTermSet = new Set(retainedShortTerm);
  const removedShortTermKeys = new Set(
    shortTermEntries
      .filter((entry) => !retainedShortTermSet.has(entry))
      .flatMap(({ key, value }) => [key, value.key]),
  );
  const removedPhaseSignalKeys = Object.keys(phaseSignals.entries).filter(
    (key) => entryKeys.has(key) || removedShortTermKeys.has(key),
  );
  const retainedSeenMessages = Object.entries(ingestionState.seenMessages).filter(
    ([scope]) => !referencesSession(scope, params.agentId, sessionIds),
  );
  const removedSeenScopes =
    Object.keys(ingestionState.seenMessages).length - retainedSeenMessages.length;
  const retainedFileStates = Object.fromEntries(
    Object.entries(ingestionState.files).filter(
      ([key]) => !referencesSession(key, params.agentId, sessionIds),
    ),
  );
  let rewrittenBackups = 0;
  const nextBackups = backups.map(({ key, value }) => {
    const scrubbed = scrub(value.content);
    if (scrubbed.content === value.content) {
      return { key, value };
    }
    rewrittenBackups += 1;
    return {
      key,
      value: {
        ...value,
        content: scrubbed.content,
        contentHash: createHash("sha256").update(scrubbed.content).digest("hex"),
      },
    };
  });

  const excludedSessionIds = new Set<string>();
  for (const entry of sessionCorpusEntries) {
    const selectedSession = sessionIds.has(entry.sessionId);
    if (!isMemorySessionIndexable(entry)) {
      excludedSessionIds.add(entry.sessionId);
      if (!selectedSession) {
        continue;
      }
    }
    if (
      selectedSession ||
      (entry.artifactKind === "archive-artifact" &&
        (!entry.sessionKind || entry.sessionKind === "unknown"))
    ) {
      const parsed = await buildSessionEntry(entry.sessionFile, {
        ...(entry.transcriptSource === "sqlite"
          ? { agentId: entry.agentId, sessionId: entry.sessionId, storePath: entry.storePath }
          : {}),
        ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
        ...(entry.sessionKind ? { sessionKind: entry.sessionKind } : {}),
        ...(selectedSession
          ? {
              onTranscriptMessage: (message: unknown, observedAt: number) =>
                collectTranscriptWrites({
                  message,
                  observedAt,
                  workspaceDir,
                  writes: curatedWrites,
                }),
            }
          : {}),
      });
      if (parsed && !isMemorySessionIndexable(parsed)) {
        excludedSessionIds.add(entry.sessionId);
      }
    }
  }

  const changedPaths = new Set(
    [...memoryRewrites, ...corpusRewrites].map((rewrite) => rewrite.relativePath),
  );
  const indexSelection: MemoryIndexSelection = {
    agentId: params.agentId,
    changedPaths,
    removedPaths: new Set(
      corpusRewrites.filter((rewrite) => rewrite.remove).map((rewrite) => rewrite.relativePath),
    ),
    sessionIds,
    excludedSessionIds,
    matchesMemory: (content) => scrub(content).content !== content,
  };
  const indexPlan = params.dryRun
    ? await planMemoryIndex(indexSelection, context.databaseOptions)
    : undefined;
  const report: MemoryForgetReport = {
    agentId: params.agentId,
    dryRun: params.dryRun === true,
    sessionIds: [...sessionIds].toSorted(),
    participantMatches: summarizeParticipantMatches(targets, params.participants),
    sessionResolutions: targets
      .map(({ sessionId, sessionKey, resolution }) =>
        sessionKey
          ? { sessionId, sessionKey, source: resolution }
          : { sessionId, source: resolution },
      )
      .toSorted((left, right) => left.sessionId.localeCompare(right.sessionId)),
    entryKeys: [...entryKeys].toSorted(),
    mixedLineageEntryKeys: [...mixedLineageEntryKeys].toSorted(),
    untargetableEntryKeys: [...untargetableEntryKeys].toSorted(),
    curatedWrites: [...curatedWrites.values()].toSorted((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    artifacts: {
      memoryFiles: memoryRewrites.length,
      memoryEntries: removedMemoryEntries,
      memoryLines: removedMemoryLines,
      sessionCorpusFiles: corpusRewrites.length,
      sessionCorpusLines: removedCorpusLines,
      indexChunks: indexPlan?.chunks.length ?? 0,
      indexSources: indexPlan?.sources.length ?? 0,
      ftsRows: indexPlan?.ftsRows ?? 0,
      vectorRows: indexPlan?.vectorRows ?? 0,
      embeddingCacheRows: indexPlan?.embeddingCacheRows ?? 0,
      shortTermEntries: shortTermEntries.length - retainedShortTerm.length,
      seenHashScopes: removedSeenScopes,
      backups: rewrittenBackups,
      originRows: allOrigins.filter((origin) => entryKeys.has(origin.entryKey)).length,
    },
    refusals,
  };
  if (params.dryRun || sessionIds.size === 0) {
    return { kind: "complete", report };
  }

  const options = context.databaseOptions;
  context.database ??= await withOpenClawAgentDatabaseWrite(options, (database) => ({
    ...borrowOpenClawAgentDatabase({ ...options, path: database.path }),
    databasePath: database.path,
  }));
  const { db, databasePath } = context.database;
  const databaseOptions = { ...options, path: databasePath };
  const kysely = getNodeSqliteKysely<ForgetDatabase>(db);
  const lineageIsCurrent = () => {
    const origins = readMemoryEntryOrigins(db, { agentId: params.agentId });
    if (selectedLineageIdentity(origins, sessionIds) === lineageIdentity) {
      return true;
    }
    context.origins = origins;
    return false;
  };
  for (;;) {
    const purged = await withOpenClawAgentDatabaseWrite(
      databaseOptions,
      (): MemoryIndexPurgeResult => {
        if (!lineageIsCurrent()) {
          return { kind: "reprepare" };
        }
        if (!context.vectorReady && tableExists(db, "memory_index_chunks_vec")) {
          const current = selectMemoryIndex(db, indexSelection, false);
          if (current.hasVectorTable && current.chunks.length > 0) {
            return { kind: "prepare-vector" };
          }
        }
        if (!context.tombstoned) {
          // Commit durable admission policy before the separate purge. A late
          // vector preparation must not repeat this logical forget operation.
          const recorded = recordMemorySessionTombstonesInDatabase(db, {
            agentId: params.agentId,
            sessionIds: [...sessionIds],
          });
          if (recorded === 0) {
            executeSqliteQuerySync(
              db,
              kysely
                .updateTable("memory_index_state")
                .set((expression) => ({ revision: expression("revision", "+", 1) }))
                .where("id", "=", 1),
            );
          }
          context.tombstoned = true;
        }
        // The transaction rereads current rows, including publications from
        // another workspace or process before this writer acquired the lock.
        return purgeMemoryIndex(db, indexSelection, context.vectorReady, lineageIsCurrent);
      },
      db,
    );
    if (purged.kind === "reprepare") {
      return purged;
    }
    if (purged.kind === "complete") {
      const { plan } = purged;
      Object.assign(report.artifacts, {
        indexChunks: plan.chunks.length,
        indexSources: plan.sources.length,
        ftsRows: plan.ftsRows,
        vectorRows: plan.vectorRows,
        embeddingCacheRows: plan.embeddingCacheRows,
      });
      break;
    }
    const loaded = await loadSqliteVecExtension({ db });
    if (!loaded.ok) {
      throw new Error(`memory forget cannot purge vector index: ${loaded.error ?? "load failed"}`);
    }
    context.vectorReady = true;
  }
  if (removedPhaseSignalKeys.length > 0) {
    for (const key of removedPhaseSignalKeys) {
      delete phaseSignals.entries[key];
    }
    phaseSignals.updatedAt = nowIso;
    // Phase signals are derived from recall rows. Remove them first so a
    // later failure leaves the authoritative recall evidence for a retry.
    await writePhaseSignalStore(workspaceDir, phaseSignals, env);
  }
  if (retainedShortTerm.length !== shortTermEntries.length) {
    await writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir,
      env,
      entries: retainedShortTerm,
    });
  }
  if (
    removedSeenScopes > 0 ||
    Object.keys(retainedFileStates).length !== Object.keys(ingestionState.files).length
  ) {
    await writeSessionIngestionState(
      workspaceDir,
      {
        ...ingestionState,
        files: retainedFileStates,
        seenMessages: Object.fromEntries(retainedSeenMessages),
      },
      env,
    );
  }
  if (rewrittenBackups > 0) {
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
      workspaceDir,
      env,
      entries: nextBackups,
    });
  }
  for (const rewrite of [...memoryRewrites, ...corpusRewrites]) {
    await commitMemoryContent({
      filePath: rewrite.absolutePath,
      tempPrefix: `${path.basename(rewrite.absolutePath)}.forget`,
      expectedHash: hashMemoryContent(rewrite.expectedContent),
      expectedContent: rewrite.expectedContent,
      allowInPlaceFallback: true,
      conflictMessage: `${path.basename(rewrite.absolutePath)} changed before the memory forget rewrite could commit`,
      content: rewrite.remove ? null : rewrite.content,
    });
  }
  await withOpenClawAgentDatabaseWrite(
    databaseOptions,
    () =>
      deleteMemoryEntryOriginsInDatabase(db, {
        agentId: params.agentId,
        entryKeys: [...entryKeys],
      }),
    db,
  );
  return { kind: "complete", report };
}
