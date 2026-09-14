import path from "node:path";
import type { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";

export type StateDatabaseBorrowers = {
  references: Set<object>;
  retiring: boolean;
  cleanupComplete: boolean;
  retirementRequested?: boolean;
  closeCoordinator?: ReturnType<typeof acquireStateDatabaseCoordinator>;
};

export function assertStateDatabaseBorrowersReleased(
  owner: StateDatabaseBorrowers | undefined,
  pathname: string,
): void {
  if (owner?.references.size) {
    throw new Error(`OpenClaw state database still has active native borrowers: ${pathname}`);
  }
}

/** The cache supplies native retirement; each reference owns only its release protocol. */
function retainStateDatabaseReference(params: {
  owner: StateDatabaseBorrowers;
  retireOnRelease?: boolean;
  retire(): void;
  retainFailedClose(): void;
}): { release(): void } {
  const { owner } = params;
  const reference = {};
  owner.references.add(reference);
  let released = false;
  return {
    release() {
      if (released || owner.cleanupComplete) {
        released = true;
        return;
      }
      owner.references.delete(reference);
      owner.retirementRequested ||= params.retireOnRelease !== false;
      if (owner.references.size > 0) {
        released = true;
        return;
      }
      if (!owner.retirementRequested && !owner.retiring) {
        released = true;
        return;
      }
      owner.retiring = true;
      try {
        params.retire();
      } catch (error) {
        // The released reference transfers failed cleanup to the canonical cache.
        params.retainFailedClose();
        throw error;
      }
      released = true;
    },
  };
}

/** Borrow references share the cache's maps and native retirement decisions. */
export function createStateDatabaseBorrowOwner(params: {
  borrowers: WeakMap<OpenClawStateDatabase["db"], StateDatabaseBorrowers>;
  cachedDatabases: Map<string, OpenClawStateDatabase>;
  assertOpenAllowed(pathname: string): void;
  assertReadCurrent(pathname: string): void;
  retire(database: OpenClawStateDatabase): void;
  retainFailedClose(database: OpenClawStateDatabase): void;
}) {
  const retain = (database: OpenClawStateDatabase, retireOnRelease = true) => {
    params.assertOpenAllowed(database.path);
    params.assertReadCurrent(database.path);
    if (params.cachedDatabases.get(database.path) !== database || !database.db.isOpen) {
      throw new Error("OpenClaw state database borrow requires its current canonical handle");
    }
    const owner = params.borrowers.get(database.db) ?? {
      references: new Set<object>(),
      retiring: false,
      cleanupComplete: false,
    };
    if (owner.retiring) {
      throw new Error("OpenClaw state database native owner is retiring");
    }
    params.borrowers.set(database.db, owner);
    return retainStateDatabaseReference({
      owner,
      retireOnRelease,
      retire: () => params.retire(database),
      retainFailedClose: () => params.retainFailedClose(database),
    });
  };
  return {
    retain,
    borrowForRead(this: void, pathname: string) {
      params.assertOpenAllowed(pathname);
      const database = params.cachedDatabases.get(path.resolve(pathname));
      if (!database?.db.isOpen) {
        return undefined;
      }
      if (database.db.isTransaction) {
        throw new Error("Asynchronous shared-state reads cannot run inside a native transaction");
      }
      const retained = retain(database, false);
      return {
        database,
        assertCurrent() {
          if (params.cachedDatabases.get(database.path) !== database || !database.db.isOpen) {
            throw new Error("Shared-state read lost its original native owner");
          }
        },
        release: () => retained.release(),
      };
    },
  };
}
