import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOpenClawDatabaseQuarantine,
  recordOpenClawDatabaseQuarantine,
} from "../state/openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  clearOpenClawStateDatabaseOpenFailure,
  isOpenClawStateDatabaseOpen,
  openOpenClawStateDatabase,
  recordOpenClawStateDatabaseOpenFailure,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createPluginBlobStoreForTests,
  resetPluginBlobStoreForTests,
} from "./plugin-blob-store.js";

afterEach(() => resetPluginBlobStoreForTests());

function createStore(env: NodeJS.ProcessEnv) {
  const store = createPluginBlobStoreForTests<{ version: number }>(
    "diffs",
    { namespace: "readonly", maxEntries: 3, maxBytesPerEntry: 16, maxBytesPerNamespace: 32 },
    env,
  );
  return { ...store, lookupInfo: expectDefined(store.lookupInfo, "metadata-only blob lookup") };
}

describe("plugin blob read-only access", () => {
  it("returns empty reads without creating an absent database", async () => {
    await withOpenClawTestState({ label: "blob-read-absent", applyEnv: false }, async (state) => {
      const store = createStore(state.env);
      const databasePath = resolveOpenClawStateSqlitePath(state.env);

      await expect(store.lookup("missing")).resolves.toBeUndefined();
      await expect(store.lookupInfo("missing")).resolves.toBeUndefined();
      await expect(store.lookupInfo(" ")).rejects.toMatchObject({
        code: "PLUGIN_BLOB_INVALID_INPUT",
        operation: "lookup",
      });
      await expect(store.entries()).resolves.toEqual([]);
      expect(existsSync(path.dirname(databasePath))).toBe(false);
      expect(isOpenClawStateDatabaseOpen(databasePath)).toBe(false);
    });
  });

  it("reads committed blobs after close without reopening a writable owner", async () => {
    await withOpenClawTestState({ label: "blob-read-reopen", applyEnv: false }, async (state) => {
      const store = createStore(state.env);
      await store.register("saved", new Uint8Array([1, 2]), { version: 1 });
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      expect(closeOpenClawStateDatabaseByPath(databasePath)).toBe(true);

      const entry = await store.lookup("saved");
      expect(entry).toMatchObject({ metadata: { version: 1 }, bytes: new Uint8Array([1, 2]) });
      entry!.bytes[0] = 9;
      await expect(store.lookup("saved")).resolves.toMatchObject({ bytes: new Uint8Array([1, 2]) });
      await expect(store.entries()).resolves.toMatchObject([{ key: "saved", sizeBytes: 2 }]);
      let fetchedBytes = 0;
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Invoke with the original native receiver.
      const get = StatementSync.prototype.get;
      const reads = vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (
        this: StatementSync,
        ...args
      ) {
        const row = get.apply(this, args);
        for (const value of Object.values(row ?? {})) {
          if (value instanceof Uint8Array) {
            fetchedBytes += value.byteLength;
          }
        }
        return row;
      });
      try {
        await expect(store.lookupInfo("saved")).resolves.toEqual({
          key: "saved",
          metadata: { version: 1 },
          sizeBytes: 2,
          createdAt: entry?.createdAt,
        });
        expect(fetchedBytes).toBe(0);
      } finally {
        reads.mockRestore();
      }
      expect(isOpenClawStateDatabaseOpen(databasePath)).toBe(false);
    });
  });

  it("keeps an active writer's uncommitted changes out of blob reads", async () => {
    await withOpenClawTestState(
      { label: "blob-read-transaction", applyEnv: false },
      async (state) => {
        const store = createStore(state.env);
        await store.register("saved", new Uint8Array([1]), { version: 1 });
        const { db } = openOpenClawStateDatabase({ env: state.env });
        db.exec("BEGIN IMMEDIATE; DELETE FROM plugin_blob_entries;");
        try {
          await expect(store.lookup("saved")).resolves.toMatchObject({ metadata: { version: 1 } });
          await expect(store.lookupInfo("saved")).resolves.toMatchObject({
            metadata: { version: 1 },
          });
          await expect(store.entries()).resolves.toMatchObject([{ key: "saved" }]);
        } finally {
          db.exec("ROLLBACK");
        }
        await expect(store.lookup("saved")).resolves.toMatchObject({ metadata: { version: 1 } });
      },
    );
  });

  it("leaves a checkpoint-only database unchanged when its blob table is absent", async () => {
    await withOpenClawTestState(
      { label: "blob-read-bootstrap", applyEnv: false },
      async (state) => {
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        mkdirSync(path.dirname(databasePath), { recursive: true });
        const db = new DatabaseSync(databasePath);
        db.exec(`
        CREATE TABLE schema_meta (
          meta_key TEXT NOT NULL PRIMARY KEY, role TEXT NOT NULL, schema_version INTEGER NOT NULL,
          agent_id TEXT, app_version TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE state_leases (
          scope TEXT NOT NULL, lease_key TEXT NOT NULL, owner TEXT NOT NULL, expires_at INTEGER,
          heartbeat_at INTEGER, payload_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY (scope, lease_key)
        );
      `);
        db.close();
        const before = readFileSync(databasePath);
        const store = createStore(state.env);

        await expect(store.lookup("missing")).resolves.toBeUndefined();
        await expect(store.lookupInfo("missing")).resolves.toBeUndefined();
        await expect(store.entries()).resolves.toEqual([]);
        expect(readFileSync(databasePath)).toEqual(before);
        expect(isOpenClawStateDatabaseOpen(databasePath)).toBe(false);
      },
    );
  });

  it("reports a missing initialized blob table as a read error without repairing it", async () => {
    await withOpenClawTestState({ label: "blob-read-damaged", applyEnv: false }, async (state) => {
      const store = createStore(state.env);
      await store.register("saved", new Uint8Array([1]), { version: 1 });
      const databasePath = resolveOpenClawStateSqlitePath(state.env);
      openOpenClawStateDatabase({ env: state.env }).db.exec("DROP TABLE plugin_blob_entries");
      closeOpenClawStateDatabaseByPath(databasePath);
      const before = readFileSync(databasePath);

      for (const operation of ["lookup", "lookupInfo", "entries"] as const) {
        await expect(
          operation === "entries" ? store.entries() : store[operation]("saved"),
        ).rejects.toMatchObject({
          code: "PLUGIN_BLOB_READ_FAILED",
          operation: operation === "lookupInfo" ? "lookup" : operation,
          path: databasePath,
        });
      }
      expect(readFileSync(databasePath)).toEqual(before);
      expect(isOpenClawStateDatabaseOpen(databasePath)).toBe(false);
    });
  });

  it.each(["warm", "cold"])(
    "rejects a newer schema through %s acquisition",
    async (temperature) => {
      await withOpenClawTestState({ label: "blob-read-newer", applyEnv: false }, async (state) => {
        const store = createStore(state.env);
        await store.register("saved", new Uint8Array([1]), { version: 1 });
        const { db, path: databasePath } = openOpenClawStateDatabase({ env: state.env });
        db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
        if (temperature === "cold") {
          closeOpenClawStateDatabaseByPath(databasePath);
        }
        for (const operation of ["lookup", "lookupInfo", "entries"] as const) {
          await expect(
            operation === "entries" ? store.entries() : store[operation]("saved"),
          ).rejects.toMatchObject({
            code: "PLUGIN_BLOB_OPEN_FAILED",
            operation: operation === "lookupInfo" ? "lookup" : operation,
            path: databasePath,
          });
        }
      });
    },
  );

  it("preserves process-local and persisted quarantine failures on cold reads", async () => {
    await withOpenClawTestState(
      { label: "blob-read-quarantine", applyEnv: false },
      async (state) => {
        const store = createStore(state.env);
        await store.register("saved", new Uint8Array([1]), { version: 1 });
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        closeOpenClawStateDatabaseByPath(databasePath);
        recordOpenClawStateDatabaseOpenFailure(databasePath, new Error("latched failure"));
        try {
          await expect(store.lookup("saved")).rejects.toMatchObject({
            code: "PLUGIN_BLOB_OPEN_FAILED",
          });
          await expect(store.entries()).rejects.toMatchObject({ code: "PLUGIN_BLOB_OPEN_FAILED" });
          await expect(store.lookupInfo("saved")).rejects.toMatchObject({
            code: "PLUGIN_BLOB_OPEN_FAILED",
            operation: "lookup",
          });
        } finally {
          clearOpenClawStateDatabaseOpenFailure(databasePath);
        }
        expect(
          recordOpenClawDatabaseQuarantine({
            env: state.env,
            kind: "state",
            path: databasePath,
            reason: "persisted failure",
          }),
        ).toBe(true);
        try {
          await expect(store.lookup("saved")).rejects.toMatchObject({
            code: "PLUGIN_BLOB_OPEN_FAILED",
          });
          await expect(store.entries()).rejects.toMatchObject({ code: "PLUGIN_BLOB_OPEN_FAILED" });
          await expect(store.lookupInfo("saved")).rejects.toMatchObject({
            code: "PLUGIN_BLOB_OPEN_FAILED",
            operation: "lookup",
          });
        } finally {
          clearOpenClawStateDatabaseOpenFailure(databasePath);
          expect(clearOpenClawDatabaseQuarantine(databasePath, { env: state.env })).toBe(true);
        }
      },
    );
  });
});
