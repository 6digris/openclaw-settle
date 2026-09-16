// Memory Core tests cover doctor migration of legacy dreaming state.
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  createPluginStateKeyedStoreForTests,
  getPluginStateCapacityForTests,
  importPluginStateEntriesForDoctorForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginDoctorStateMigrationContext,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { expect } from "vitest";
import { stateMigrations } from "./doctor-contract-api.js";
import { bm25RankToScore, buildFtsQuery } from "./src/memory/keyword-query.js";
import { runVectorKnnQuery } from "./src/memory/manager-search-knn.js";
import { searchKeyword, searchVector } from "./src/memory/manager-search.js";
// Memory Core tests cover doctor migration of legacy dreaming state.

export function createDoctorContext(env: NodeJS.ProcessEnv): PluginDoctorStateMigrationContext {
  return {
    getPluginStateCapacity() {
      return getPluginStateCapacityForTests("memory-core", env);
    },
    importPluginStateEntries(options, entries) {
      importPluginStateEntriesForDoctorForTests(
        "memory-core",
        { ...options, env: options.env ?? env },
        entries,
      );
    },
    openPluginStateKeyedStore<T>(options: OpenKeyedStoreOptions) {
      return createPluginStateKeyedStoreForTests<T>("memory-core", {
        ...options,
        env: options.env ?? env,
      });
    },
  };
}

export function legacyMemoryIndexMigration() {
  const migration = stateMigrations.find(
    (entry) => entry.id === "memory-core-legacy-sidecar-index-to-agent-sqlite",
  );
  if (!migration) {
    throw new Error("expected memory-core legacy sidecar migration");
  }
  return migration;
}

export function dreamingStateMigration() {
  const migration = stateMigrations.find(
    (entry) => entry.id === "memory-core-dreams-json-to-sqlite",
  );
  if (!migration) {
    throw new Error("expected memory-core dreaming state migration");
  }
  return migration;
}

export function hostEventsMigration() {
  const migration = stateMigrations.find(
    (entry) => entry.id === "memory-core-host-events-jsonl-to-sqlite",
  );
  if (!migration) {
    throw new Error("expected memory-core host events migration");
  }
  return migration;
}

export function qmdFileLockMigration() {
  const migration = stateMigrations.find(
    (entry) => entry.id === "memory-core-qmd-file-locks-to-sqlite-leases",
  );
  if (!migration) {
    throw new Error("expected memory-core QMD file-lock migration");
  }
  return migration;
}

export function qmdWorkspaceMigration() {
  const migration = stateMigrations.find(
    (entry) => entry.id === "memory-core-qmd-workspace-retired",
  );
  if (!migration) {
    throw new Error("expected memory-core retired QMD workspace migration");
  }
  return migration;
}

export function vectorToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

function insertCanonicalChunkProvenance(
  db: DatabaseSync,
  chunkId: string,
  observedAt: number,
): void {
  db.prepare(
    `INSERT INTO memory_index_chunk_provenance (
       chunk_id, origin_class, session_kind, observed_at
     ) VALUES (?, 'agent', 'unknown', ?)`,
  ).run(chunkId, observedAt);
}

export async function writeLegacyMemorySidecar(
  legacyPath: string,
  params: {
    vector?: boolean | "vec0";
    chunkId?: string;
    chunkHash?: string;
    fileHash?: string;
    filePath?: string;
    text?: string;
    cacheEmbedding?: string;
    cacheDims?: number | null;
  } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  const db = new DatabaseSync(legacyPath, { allowExtension: params.vector === "vec0" });
  try {
    const filePath = params.filePath ?? "MEMORY.md";
    const fileHash = params.fileHash ?? "file-hash";
    const chunkId = params.chunkId ?? "chunk-1";
    const chunkHash = params.chunkHash ?? "chunk-hash";
    const text = params.text ?? "remember this";
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE embedding_cache (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_key TEXT NOT NULL,
        hash TEXT NOT NULL,
        embedding TEXT NOT NULL,
        dims INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model, provider_key, hash)
      );
      INSERT INTO meta VALUES ('memory_index_meta_v1', '{"vectorDims":3}');
    `);
    db.prepare("INSERT INTO files VALUES (?, 'memory', ?, 10, 20)").run(filePath, fileHash);
    db.prepare(
      "INSERT INTO chunks VALUES (?, ?, 'memory', 1, 2, ?, 'embed-model', ?, '[1,0,0]', 30)",
    ).run(chunkId, filePath, chunkHash, text);
    db.prepare(
      "INSERT INTO embedding_cache VALUES ('openai', 'embed-model', 'key', ?, ?, ?, 40)",
    ).run(
      chunkHash,
      params.cacheEmbedding ?? "[1,0,0]",
      params.cacheDims === undefined ? 3 : params.cacheDims,
    );
    if (params.vector === "vec0") {
      const loaded = await loadSqliteVecExtension({ db });
      expect(loaded.ok, loaded.error).toBe(true);
      db.exec(`
        CREATE VIRTUAL TABLE chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[3]
        )
      `);
      db.prepare("INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)").run(
        chunkId,
        vectorToBlob([1, 0, 0]),
      );
    } else if (params.vector) {
      db.exec("CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");
      db.prepare("INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)").run(
        chunkId,
        vectorToBlob([1, 0, 0]),
      );
    }
  } finally {
    db.close();
  }
}

export async function createCanonicalMemoryIndex(agentPath: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  const db = new DatabaseSync(agentPath);
  try {
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: true,
    });
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "memory_index_meta_v1",
      '{"vectorDims":3}',
    );
    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run("MEMORY.md", "memory", "canonical-file-hash", 11, 21);
    db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "canonical-chunk",
      "MEMORY.md",
      "memory",
      1,
      1,
      "canonical-hash",
      "embed-model",
      text,
      "[0,1,0]",
      31,
    );
    db.prepare(
      "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(text, "canonical-chunk", "MEMORY.md", "memory", "embed-model", 1, 1);
    insertCanonicalChunkProvenance(db, "canonical-chunk", 31);
  } finally {
    db.close();
  }
}

export async function createUnrelatedCanonicalMemoryIndex(
  agentPath: string,
  options: { vectorDims?: number } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  const db = new DatabaseSync(agentPath);
  try {
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: true,
    });
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "memory_index_meta_v1",
      JSON.stringify({ vectorDims: options.vectorDims ?? 3 }),
    );
    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run("OTHER.md", "memory", "canonical-other-file-hash", 11, 21);
    db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "canonical-other-chunk",
      "OTHER.md",
      "memory",
      1,
      1,
      "canonical-other-hash",
      "embed-model",
      "canonical unrelated memory",
      "[0,1,0]",
      31,
    );
    db.prepare(
      "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "canonical unrelated memory",
      "canonical-other-chunk",
      "OTHER.md",
      "memory",
      "embed-model",
      1,
      1,
    );
    insertCanonicalChunkProvenance(db, "canonical-other-chunk", 31);
  } finally {
    db.close();
  }
}

export async function createCanonicalLegacyMemoryRowsWithFts(agentPath: string, ftsText: string) {
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  const db = new DatabaseSync(agentPath);
  try {
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: true,
    });
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "memory_index_meta_v1",
      '{"vectorDims":3}',
    );
    db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)",
    ).run("MEMORY.md", "memory", "file-hash", 10, 20);
    db.prepare(
      "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "chunk-1",
      "MEMORY.md",
      "memory",
      1,
      2,
      "chunk-hash",
      "embed-model",
      "remember this",
      "[1,0,0]",
      30,
    );
    db.prepare(
      "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(ftsText, "chunk-1", "MEMORY.md", "memory", "embed-model", 1, 2);
    insertCanonicalChunkProvenance(db, "chunk-1", 30);
  } finally {
    db.close();
  }
}

export async function createMismatchedCanonicalVectorIndex(agentPath: string): Promise<void> {
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  const db = new DatabaseSync(agentPath, { allowExtension: true });
  try {
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: true,
    });
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    db.exec(`
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[4]
      )
    `);
  } finally {
    db.close();
  }
}

export async function createConflictingCanonicalVectorIndex(agentPath: string): Promise<void> {
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  const db = new DatabaseSync(agentPath, { allowExtension: true });
  try {
    ensureMemoryIndexSchema({
      db,
      cacheEnabled: true,
      ftsEnabled: true,
    });
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "memory_index_meta_v1",
      '{"vectorDims":3}',
    );
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    db.exec(`
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[3]
      )
    `);
    db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
      "chunk-1",
      vectorToBlob([0, 1, 0]),
    );
  } finally {
    db.close();
  }
}

export function readMemoryRows(agentPath: string) {
  const db = new DatabaseSync(agentPath);
  try {
    return {
      sources: db
        .prepare("SELECT path, source, hash FROM memory_index_sources ORDER BY path, source")
        .all(),
      chunks: db.prepare("SELECT id, text FROM memory_index_chunks ORDER BY id").all(),
      cache: db
        .prepare("SELECT provider, hash FROM memory_embedding_cache ORDER BY provider, hash")
        .all(),
    };
  } finally {
    db.close();
  }
}

export function readMemoryCacheRows(agentPath: string) {
  const db = new DatabaseSync(agentPath);
  try {
    return db
      .prepare(
        "SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM memory_embedding_cache ORDER BY provider, hash",
      )
      .all();
  } finally {
    db.close();
  }
}

export function readMemoryFtsSql(agentPath: string): string | undefined {
  const db = new DatabaseSync(agentPath);
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
      .get("memory_index_chunks_fts") as { sql?: unknown } | undefined;
    return typeof row?.sql === "string" ? row.sql : undefined;
  } finally {
    db.close();
  }
}

export async function searchMigratedVectorRows(agentPath: string) {
  const db = new DatabaseSync(agentPath, { allowExtension: true });
  try {
    const loaded = await loadSqliteVecExtension({ db });
    expect(loaded.ok, loaded.error).toBe(true);
    return await searchVector({
      db,
      vectorTable: "memory_index_chunks_vec",
      providerModel: "embed-model",
      queryVec: [1, 0, 0],
      limit: 1,
      snippetMaxChars: 200,
      ensureVectorReady: async () => true,
      runVectorKnn: async (request) => runVectorKnnQuery(db, request),
      sourceFilterVec: { sql: "", params: [] },
      sourceFilterChunks: { sql: "", params: [] },
    });
  } finally {
    db.close();
  }
}

export async function searchMigratedKeywordRows(agentPath: string, query: string) {
  const db = new DatabaseSync(agentPath);
  try {
    return await searchKeyword({
      db,
      ftsTable: "memory_index_chunks_fts",
      query,
      ftsTokenizer: "unicode61",
      limit: 10,
      snippetMaxChars: 200,
      sourceFilter: { sql: "", params: [] },
      buildFtsQuery,
      bm25RankToScore,
    });
  } finally {
    db.close();
  }
}

export async function resetDoctorPluginState() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
}
