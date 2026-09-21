import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import * as stateDb from "../state/openclaw-state-db.js";
import {
  loadDevicePairingStoreState,
  persistDevicePairingStoreState,
  readDevicePairingStoreStateFromDatabase,
} from "./device-pairing-store.js";
import type { DevicePairingStoreState } from "./device-pairing.types.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let baseDir: string;
let database: ReturnType<typeof stateDb.openOpenClawStateDatabase>;
let initial: DevicePairingStoreState;

beforeEach(() => {
  baseDir = tempDirs.make("device-pairing-cache-");
  database = stateDb.openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
  });
  initial = {
    pendingById: {},
    pairedByDeviceId: {
      node: { deviceId: "node", publicKey: "synthetic-key", createdAtMs: 1, approvedAtMs: 1 },
    },
  };
  persistDevicePairingStoreState(initial, baseDir, "both");
  expect(loadDevicePairingStoreState(baseDir)).toEqual(initial);
});

afterEach(() => {
  closeOpenClawStateDatabaseByPath(database.path);
});

test("reloads committed pairing changes when transaction cleanup throws", () => {
  const runTransaction = stateDb.runOpenClawStateWriteTransaction;
  const transaction = vi
    .spyOn(stateDb, "runOpenClawStateWriteTransaction")
    .mockImplementationOnce((operate, options, transactionOptions) => {
      runTransaction(operate, options, transactionOptions);
      throw new Error("post-commit cleanup failed");
    });
  try {
    expect(() =>
      persistDevicePairingStoreState({ pendingById: {}, pairedByDeviceId: {} }, baseDir, "paired"),
    ).toThrow("post-commit cleanup failed");
    expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual({});
  } finally {
    transaction.mockRestore();
  }
});

test("shares pairing invalidation across module copies using the same connection", async () => {
  vi.resetModules();
  const other = await import("./device-pairing-store.js");
  expect(other.loadDevicePairingStoreState).not.toBe(loadDevicePairingStoreState);
  other.persistDevicePairingStoreState(
    { pendingById: {}, pairedByDeviceId: {} },
    baseDir,
    "paired",
  );
  expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual({});
});

test.each([false, true])(
  "keeps transaction-local pairing reads out of the cache (rollback=%s)",
  (rollback) => {
    const operate = () =>
      stateDb.runOpenClawStateWriteTransaction(
        () => {
          persistDevicePairingStoreState(
            { pendingById: {}, pairedByDeviceId: {} },
            baseDir,
            "paired",
          );
          expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual({});
          if (rollback) {
            throw new Error("rollback pairing");
          }
        },
        { database, env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } },
      );
    if (rollback) {
      expect(operate).toThrow("rollback pairing");
    } else {
      operate();
    }
    expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual(
      rollback ? initial.pairedByDeviceId : {},
    );
  },
);

test("reloads the pairing snapshot after reopening the database", () => {
  closeOpenClawStateDatabaseByPath(database.path);
  const reopened = stateDb.openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
  });
  expect(reopened.db === database.db).toBe(false);
  reopened.db.prepare("DELETE FROM device_pairing_paired").run();
  expect(loadDevicePairingStoreState(baseDir).pairedByDeviceId).toEqual({});
});

test.each([false, true])(
  "keeps pending and paired inventory coherent across an approval (readOnly=%s)",
  (readOnly) => {
    const pending: DevicePairingStoreState = {
      pendingById: {
        request: { requestId: "request", deviceId: "node", publicKey: "synthetic-key", ts: 1 },
      },
      pairedByDeviceId: {},
    };
    persistDevicePairingStoreState(pending, baseDir, "both");
    const reader = openNodeSqliteDatabase(database.path, { readOnly });
    const prepare = reader.prepare.bind(reader);
    let approved = false;
    const preparing = vi.spyOn(reader, "prepare").mockImplementation((sql) => {
      if (!approved && sql.includes('"device_pairing_paired"')) {
        // Commit through the live writer after the inventory has consumed pending rows.
        persistDevicePairingStoreState(initial, baseDir, "both");
        approved = true;
      }
      return prepare(sql);
    });
    try {
      expect(readDevicePairingStoreStateFromDatabase(reader)).toEqual(pending);
      expect(approved).toBe(true);
      expect(readDevicePairingStoreStateFromDatabase(reader)).toEqual(initial);
    } finally {
      preparing.mockRestore();
      reader.close();
    }
  },
);

test("releases the inventory snapshot when paired row decoding fails", () => {
  database.db.prepare("UPDATE device_pairing_paired SET tokens_json = ?").run("{");
  expect(() => readDevicePairingStoreStateFromDatabase(database.db)).toThrow(SyntaxError);
  expect(database.db.isTransaction).toBe(false);
  database.db.prepare("UPDATE device_pairing_paired SET tokens_json = NULL").run();
  expect(readDevicePairingStoreStateFromDatabase(database.db)).toEqual(initial);
});
