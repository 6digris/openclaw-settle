import fs from "node:fs";
import path from "node:path";
import { readSqliteDataVersion } from "../infra/node-sqlite.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { readSqliteSchemaCookie } from "../infra/sqlite-schema-contract.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db-contract.js";
import {
  isOpenClawAgentDatabasePathCurrent,
  readOpenClawAgentDatabaseIdentity,
} from "./openclaw-agent-db-identity.js";
import {
  assertOpenClawAgentDatabaseReadOnlySchema,
  hasOpenClawAgentReadOnlySchema,
  readOpenClawAgentDatabaseReadOnly,
  withFreshOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentDatabaseReadOnlyResult,
  type OpenClawAgentReadOnlyDatabase,
} from "./openclaw-agent-db-readonly-open.js";
import {
  findOpenClawAgentDatabaseForReadOnly,
  retainOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "./openclaw-agent-db-readonly.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "./openclaw-agent-db-resources.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";

type ReadOnlyStamp = {
  userVersion: number;
  schemaVersion: number;
  dataVersion: number;
  files: Array<fs.BigIntStats | undefined> | undefined;
};

type ReadDisposal = {
  close: (() => void) | undefined;
  unregister: () => void;
};

type RetainedRead = Extract<
  ReturnType<typeof retainOpenClawAgentDatabaseReadOnly>,
  { found: true }
> & {
  stamp?: ReadOnlyStamp;
  filePaths?: readonly string[];
  disposal: ReadDisposal;
};

function readFileStamp(filePaths: readonly string[] | undefined): ReadOnlyStamp["files"] {
  if (!filePaths) {
    return undefined;
  }
  try {
    return filePaths.map((file) => fs.statSync(file, { bigint: true, throwIfNoEntry: false }));
  } catch {
    // Metadata only decides reuse; the fresh SQLite opener owns access errors.
    return undefined;
  }
}

function canReuseReadPath(database: OpenClawAgentReadOnlyDatabase): boolean {
  try {
    return isOpenClawAgentDatabasePathCurrent(database);
  } catch {
    return false;
  }
}

function readStamp(read: RetainedRead): ReadOnlyStamp {
  const dataVersion = readSqliteDataVersion(read.database.db);
  const schemaVersion = readSqliteSchemaCookie(read.database.db);
  if (typeof schemaVersion !== "number") {
    throw new Error("SQLite did not return a numeric PRAGMA schema_version");
  }
  return {
    userVersion: readSqliteUserVersion(read.database.db),
    schemaVersion,
    dataVersion,
    files: readFileStamp(read.filePaths),
  };
}

function sameStamp(left: ReadOnlyStamp, right: ReadOnlyStamp): boolean {
  const leftFiles = left.files;
  const rightFiles = right.files;
  return (
    left.userVersion === right.userVersion &&
    left.schemaVersion === right.schemaVersion &&
    left.dataVersion === right.dataVersion &&
    leftFiles !== undefined &&
    rightFiles !== undefined &&
    leftFiles.length === rightFiles.length &&
    leftFiles.every((file, index) => {
      const other = rightFiles[index];
      if (!file || !other) {
        return file === other;
      }
      return (
        file.dev === other.dev &&
        file.ino === other.ino &&
        file.birthtimeNs === other.birthtimeNs &&
        file.mode === other.mode &&
        file.uid === other.uid &&
        file.gid === other.gid &&
        file.ctimeNs === other.ctimeNs
      );
    })
  );
}

/** Retain one read connection through its caller's asynchronous lifetime. */
export function retainOpenClawAgentDatabaseReads(options: {
  onRevoked: (reason: unknown) => void;
}): {
  read: <T>(
    operation: (database: OpenClawAgentReadOnlyDatabase) => T,
    databaseOptions: OpenClawAgentDatabaseOptions,
  ) => OpenClawAgentDatabaseReadOnlyResult<T>;
  release: () => void;
} {
  let released = false;
  let current: RetainedRead | undefined;
  let reading = false;
  let deferredClose: RetainedRead | undefined;

  const close = (disposal: ReadDisposal) => {
    const wasReading = reading;
    reading = true;
    try {
      disposal.close?.();
      disposal.close = undefined;
      disposal.unregister();
    } catch (error) {
      if (!released) {
        released = true;
        options.onRevoked(error);
      }
      throw error;
    } finally {
      reading = wasReading;
    }
  };
  const discard = () => {
    const read = current;
    current = undefined;
    if (read) {
      if (reading) {
        deferredClose = read;
      } else {
        close(read.disposal);
      }
    }
  };
  const release = () => {
    if (!released) {
      released = true;
      discard();
    }
  };
  const assertCurrent = () => {
    if (released) {
      throw new Error("OpenClaw agent database read retention is no longer current");
    }
  };

  return {
    read: (operation, databaseOptions) => {
      assertCurrent();
      getOpenClawDatabaseMaintenanceScope()?.assertAdmission();
      const agentId = normalizeAgentId(databaseOptions.agentId);
      const pathname = resolveOpenClawAgentSqlitePath({ ...databaseOptions, agentId });
      const selected = { ...databaseOptions, agentId, path: pathname };
      const wasReading = reading;
      let readFailed = false;
      try {
        if (
          !wasReading &&
          current &&
          (current.database.agentId !== agentId || current.database.path !== pathname)
        ) {
          discard();
        }
        if (isIncognitoOpenClawAgentSqlitePath(pathname, selected)) {
          // Incognito reads intentionally share their process-held transaction view.
          if (!wasReading) {
            discard();
          }
          reading = true;
          const result = withOpenClawAgentDatabaseReadOnly(operation, selected);
          assertCurrent();
          return result;
        }

        const opened = findOpenClawAgentDatabaseForReadOnly(selected);
        let freshOnly = opened !== undefined && !canReuseReadPath(opened);
        const inTransaction = opened?.db.isTransaction === true;
        if (wasReading || (inTransaction && !freshOnly)) {
          // Nested and transactional reads do not replace the active retained leaf.
          reading = true;
          const result = freshOnly
            ? withFreshOpenClawAgentDatabaseReadOnly(operation, selected)
            : withOpenClawAgentDatabaseReadOnly(operation, selected);
          assertCurrent();
          return result;
        }
        let before: ReadOnlyStamp | undefined;
        if (current) {
          const pathCurrent = canReuseReadPath(current.database);
          const ownerCurrent = current.kind === "read-only" || opened === current.database;
          const claimCurrent = current.claim.isCurrent();
          if (claimCurrent && pathCurrent && ownerCurrent && current.kind === "read-only") {
            // Native query observers can revoke the reader before a stamp call returns.
            reading = true;
            before = readStamp(current);
            assertCurrent();
            reading = false;
          }
          const unchanged =
            current.kind === "borrowed" ||
            (current.stamp !== undefined &&
              before !== undefined &&
              sameStamp(current.stamp, before));
          if (!claimCurrent || !pathCurrent || !ownerCurrent || !unchanged) {
            freshOnly ||= !pathCurrent || current.kind === "read-only";
            discard();
            before = undefined;
          }
        }
        if (!current) {
          reading = true;
          let read: RetainedRead | undefined;
          let opening = true;
          const disposal: ReadDisposal = { close: undefined, unregister: () => unregister() };
          const unregister: () => void = registerOpenClawAgentDatabaseAsyncResource({
            agentId,
            path: pathname,
            revoke: () => {
              // Maintenance can keep this callback after a newer leaf replaces its claim.
              if (!released && (read ? current === read : opening)) {
                try {
                  release();
                } catch {
                  // The registered exact-leaf closer retains failed native disposal below.
                }
                options.onRevoked(new Error("Agent database retained read was revoked"));
              }
            },
            // SQLite reads are synchronous; deferred native close runs before this microtask.
            close: () => Promise.resolve().then(() => close(disposal)),
          });
          try {
            const retained = retainOpenClawAgentDatabaseReadOnly(selected, {
              freshOnly,
              ownClose: (nativeClose) => {
                disposal.close = nativeClose;
              },
            });
            if (!retained.found) {
              return retained;
            }
            // Record the exact leaf before identity reads; opening can synchronously revoke it.
            read = { ...retained, disposal };
            current = read;
            disposal.close = () => {
              retained.claim.release();
              // Claim revocation is final; native disposal can still need the owner's retry.
              if (retained.kind === "read-only" && retained.database.db.isOpen) {
                retained.database.close();
              }
            };
            assertCurrent();
            const filename =
              read.kind === "read-only"
                ? readOpenClawAgentDatabaseIdentity(read.database).filename
                : undefined;
            read.filePaths = filename
              ? [...resolveSqliteDatabaseFilePaths(filename), path.dirname(filename)]
              : undefined;
          } catch (error) {
            readFailed = true;
            throw error;
          } finally {
            opening = false;
            if (!read) {
              if (readFailed) {
                try {
                  close(disposal);
                } catch {
                  // Keep validation primary; failed native disposal stays with this resource.
                }
              } else {
                close(disposal);
              }
            }
          }
        }
        const read = current;
        read.claim.assertCurrent();
        reading = true;
        if (read.kind === "read-only" && !before) {
          // The opener's owner check preceded this token; bracket that admission again.
          before = readStamp(read);
          assertCurrent();
          if (!hasOpenClawAgentReadOnlySchema(read.database)) {
            assertCurrent();
            discard();
            return { found: false, reason: "schema-missing" };
          }
        } else {
          assertOpenClawAgentDatabaseReadOnlySchema(read.database);
        }
        assertCurrent();
        const result = readOpenClawAgentDatabaseReadOnly(read.database, operation);
        assertCurrent();
        if (!result.found) {
          discard();
        } else if (before) {
          // Never bless an earlier read with a token captured after an intervening write.
          if (sameStamp(before, readStamp(read))) {
            read.stamp = before;
          } else {
            discard();
          }
        }
        if (!isOpenClawAgentDatabasePathCurrent(read.database)) {
          throw new Error("Agent database path changed during a retained read. Retry the request.");
        }
        return result;
      } catch (error) {
        readFailed = true;
        try {
          if (!wasReading) {
            discard();
          }
        } catch {
          // Keep the primary read error; failed native disposal remains resource-owned.
        }
        throw error;
      } finally {
        reading = wasReading;
        if (!wasReading && deferredClose) {
          const read = deferredClose;
          deferredClose = undefined;
          if (readFailed) {
            try {
              close(read.disposal);
            } catch {
              // Disposal stays registered without replacing the primary read failure.
            }
          } else {
            close(read.disposal);
          }
        }
      }
    },
    release,
  };
}
