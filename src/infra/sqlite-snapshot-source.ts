// Keep source lifetime pinned while the snapshot owner consumes live or private bytes.
import fs, { type BigIntStats } from "node:fs";
import {
  createPrivateSqliteTempDirectorySync,
  resolvePrivateSqliteSnapshotStagingRoot,
} from "./sqlite-private-directory.js";
import {
  adoptPreparedLocation,
  removeTempDirectory,
  removeTempDirectoryAsync,
  SqliteSnapshotCleanupError,
} from "./sqlite-readonly-location-cleanup.js";
import {
  createSqliteSnapshotStagingDirectory,
  prepareSqliteReadOnlyLocationInProcess,
  prepareSqliteReadOnlyLocationSyncInProcess,
  SQLITE_SNAPSHOT_STAGING_PREFIX,
} from "./sqlite-readonly-location.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import { runSqliteReadOnlyWorker, runSqliteReadOnlyWorkerSync } from "./sqlite-readonly-worker.js";
import {
  readSqliteSchemaHeaderFromSnapshotAsync,
  type SqliteSchemaHeader,
} from "./sqlite-schema-header.js";
import { withSqliteSourceHandleAsync } from "./sqlite-source-handle.js";
import {
  hasStateDatabaseSourceExclusion,
  prepareStateDatabaseMutationSnapshot,
  prepareStateDatabaseCanonicalMutation,
} from "./state-database-coordinator.js";
// Keep source lifetime pinned while the snapshot owner consumes live or private bytes.

/** Inspect metadata without copying the payload. Exclusive task-local scopes
 * must use their snapshot owner: a child cannot borrow that source authority. */
export async function inspectSqliteSchemaHeader(
  pathname: string,
  options: { signal?: AbortSignal; agentSchemaVersionForOwnership?: number } = {},
) {
  options.signal?.throwIfAborted();
  if (
    prepareStateDatabaseCanonicalMutation(pathname) ||
    hasStateDatabaseSourceExclusion(pathname)
  ) {
    const prepared = await prepareSqliteReadOnlyLocation(pathname, options);
    return readSqliteSchemaHeaderFromSnapshotAsync(
      prepared,
      options.signal,
      options.agentSchemaVersionForOwnership,
    );
  }
  // Reserve cleanup ownership before launch even if only journal recovery will
  // need a copy. Cancellation joins the child before deleting unpublished bytes.
  const stagingRoot = await createSqliteSnapshotStagingDirectory();
  let header: SqliteSchemaHeader;
  try {
    options.signal?.throwIfAborted();
    header = await runSqliteReadOnlyWorker(pathname, {
      mode: "schema-header",
      stagingRoot,
      signal: options.signal,
      agentSchemaVersionForOwnership: options.agentSchemaVersionForOwnership,
    });
    options.signal?.throwIfAborted();
  } catch (error) {
    if (!(await removeTempDirectoryAsync(stagingRoot))) {
      throw new Error(`SQLite read-only worker snapshot cleanup failed: ${stagingRoot}`, {
        cause: error,
      });
    }
    throw error;
  }
  if (!(await removeTempDirectoryAsync(stagingRoot))) {
    throw new Error(`SQLite read-only worker snapshot cleanup failed: ${stagingRoot}`);
  }
  options.signal?.throwIfAborted();
  return header;
}

// Keep parent launch orchestration out of the native snapshot child's import graph.
export async function prepareSqliteReadOnlyLocation(
  pathname: string,
  options: { preserveSourceArtifacts?: boolean; signal?: AbortSignal; stagingRoot?: string } = {},
): Promise<PreparedSqliteReadOnlyLocation> {
  let stagingRoot: string | undefined;
  try {
    options.signal?.throwIfAborted();
    if (options.stagingRoot && prepareStateDatabaseCanonicalMutation(pathname)) {
      throw new Error(
        "Caller-owned SQLite snapshot staging requires a drained canonical mutation owner.",
      );
    }
    const ownedSnapshot = prepareStateDatabaseMutationSnapshot(pathname);
    if (ownedSnapshot) {
      const prepared = await ownedSnapshot;
      try {
        options.signal?.throwIfAborted();
        return prepared;
      } catch (error) {
        await prepared.cleanupAsync();
        throw error;
      }
    }
    if (hasStateDatabaseSourceExclusion(pathname)) {
      const prepared = options.preserveSourceArtifacts
        ? prepareSqliteReadOnlyLocationSyncInProcess(pathname, options.stagingRoot)
        : await prepareSqliteReadOnlyLocationInProcess(pathname, options.stagingRoot);
      try {
        options.signal?.throwIfAborted();
        return prepared;
      } catch (error) {
        await prepared.cleanupAsync();
        throw error;
      }
    }
    // A stopped worker may never publish its random snapshot path. Allocate its
    // private parent first so cancellation can join the child and remove all copies.
    stagingRoot = await createSqliteSnapshotStagingDirectory(options.stagingRoot);
    options.signal?.throwIfAborted();
    const location = await runSqliteReadOnlyWorker(pathname, {
      mode: options.preserveSourceArtifacts ? "sync" : "async",
      signal: options.signal,
      stagingRoot,
    });
    options.signal?.throwIfAborted();
    // Cancellable maintenance must retain its fence on cleanup failure; ordinary
    // read-only handles report false so their owner can retry close.
    return adoptPreparedLocation(location, stagingRoot, options.signal !== undefined);
  } catch (error) {
    if (stagingRoot && !(await removeTempDirectoryAsync(stagingRoot))) {
      throw new Error(`SQLite read-only worker snapshot cleanup failed: ${stagingRoot}`, {
        cause: error,
      });
    }
    options.signal?.throwIfAborted();
    throw error;
  }
}

export function prepareSqliteReadOnlyLocationSync(
  pathname: string,
): PreparedSqliteReadOnlyLocation {
  if (hasStateDatabaseSourceExclusion(pathname)) {
    return prepareSqliteReadOnlyLocationSyncInProcess(pathname);
  }
  const stagingRoot = createPrivateSqliteTempDirectorySync(
    resolvePrivateSqliteSnapshotStagingRoot(),
    SQLITE_SNAPSHOT_STAGING_PREFIX,
  );
  try {
    return adoptPreparedLocation(runSqliteReadOnlyWorkerSync(pathname, stagingRoot), stagingRoot);
  } catch (error) {
    if (!removeTempDirectory(stagingRoot)) {
      throw new SqliteSnapshotCleanupError(
        `SQLite read-only worker snapshot cleanup failed: ${stagingRoot}`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

async function prepareSqliteSnapshotSource(
  pathname: string,
  stagingRoot?: string,
): Promise<PreparedSqliteReadOnlyLocation | undefined> {
  const canonicalPath = fs.realpathSync.native(pathname);
  const journalPath = `${canonicalPath}-journal`;
  let journal: BigIntStats;
  try {
    journal = fs.lstatSync(journalPath, { bigint: true });
  } catch (error) {
    // SAFETY: lstatSync on this canonical string path reports Node errno failures.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!journal.isFile()) {
    throw new Error(`SQLite rollback journal must be a regular file: ${journalPath}`);
  }
  return await prepareSqliteReadOnlyLocation(canonicalPath, { stagingRoot });
}

export async function withSqliteSnapshotSource<T>(
  pathname: string,
  operation: (sourcePath: string) => Promise<T>,
  options: { stagingRoot?: string } = {},
): Promise<T> {
  let prepared = await prepareSqliteSnapshotSource(pathname, options.stagingRoot);
  try {
    try {
      return prepared
        ? await operation(prepared.location)
        : await withSqliteSourceHandleAsync(pathname, () => operation(pathname));
    } catch (error) {
      if (prepared) {
        throw error;
      }
      prepared = await prepareSqliteSnapshotSource(pathname, options.stagingRoot);
      if (!prepared) {
        throw error;
      }
      return await operation(prepared.location);
    }
  } finally {
    await prepared?.cleanupAsync();
  }
}
