// Memory schema data shared by validation and mutation owners.

export const MEMORY_INDEX_SOURCES_TABLE = "memory_index_sources";

export const MEMORY_INDEX_CHUNKS_TABLE = "memory_index_chunks";

export const MEMORY_INDEX_FTS_TABLE = "memory_index_chunks_fts";

export const MEMORY_INDEX_PATHS_FTS_TABLE = "memory_index_paths_fts";

/** Optional canonical triggers owned by the derived path FTS index. */
export const MEMORY_PATH_FTS_TRIGGER_DEFINITIONS = [
  {
    name: "memory_index_paths_fts_after_insert",
    sql: `
      CREATE TRIGGER IF NOT EXISTS main.memory_index_paths_fts_after_insert
      AFTER INSERT ON ${MEMORY_INDEX_SOURCES_TABLE}
      BEGIN
        INSERT INTO ${MEMORY_INDEX_PATHS_FTS_TABLE} (rowid, path, source)
        VALUES (NEW.id, NEW.path, NEW.source);
      END;
    `,
  },
  {
    name: "memory_index_paths_fts_after_update",
    sql: `
      CREATE TRIGGER IF NOT EXISTS main.memory_index_paths_fts_after_update
      AFTER UPDATE OF id, path, source ON ${MEMORY_INDEX_SOURCES_TABLE}
      BEGIN
        DELETE FROM ${MEMORY_INDEX_PATHS_FTS_TABLE}
        WHERE rowid = OLD.id;
        INSERT INTO ${MEMORY_INDEX_PATHS_FTS_TABLE} (rowid, path, source)
        VALUES (NEW.id, NEW.path, NEW.source);
      END;
    `,
  },
  {
    name: "memory_index_paths_fts_after_delete",
    sql: `
      CREATE TRIGGER IF NOT EXISTS main.memory_index_paths_fts_after_delete
      AFTER DELETE ON ${MEMORY_INDEX_SOURCES_TABLE}
      BEGIN
        DELETE FROM ${MEMORY_INDEX_PATHS_FTS_TABLE}
        WHERE rowid = OLD.id;
      END;
    `,
  },
] as const;

export const MEMORY_INDEX_CHUNK_PROVENANCE_TABLE = "memory_index_chunk_provenance";

export const MEMORY_INDEX_CHUNK_RECALL_METADATA_TABLE = "memory_index_chunk_recall_metadata";
