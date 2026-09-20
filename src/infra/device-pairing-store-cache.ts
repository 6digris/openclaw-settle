import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import type { DevicePairingStoreState } from "./device-pairing.types.js";
import { readSqliteDataVersion } from "./node-sqlite.js";

type DevicePairingStoreCache = {
  connection: OpenClawStateDatabase["db"];
  path: string;
  state: DevicePairingStoreState;
  dataVersion: number;
};

// Store-owned writes invalidate across module copies sharing the native connection.
// data_version catches other-connection commits; unrelated local writes preserve the snapshot.
const cache = resolveGlobalSingleton<{ value: DevicePairingStoreCache | undefined }>(
  Symbol.for("openclaw.devicePairingStoreCache"),
  () => ({ value: undefined }),
);

export function readCachedDevicePairingStoreState(
  database: OpenClawStateDatabase,
  read: () => DevicePairingStoreState,
): DevicePairingStoreState {
  // A nested pairing write can still roll back with its outer transaction.
  if (database.db.isTransaction) {
    return read();
  }
  const dataVersion = readSqliteDataVersion(database.db);
  const cached = cache.value;
  if (
    cached?.connection === database.db &&
    cached.path === database.path &&
    cached.dataVersion === dataVersion
  ) {
    return structuredClone(cached.state);
  }
  const state = read();
  cache.value = {
    connection: database.db,
    path: database.path,
    state: structuredClone(state),
    dataVersion,
  };
  return state;
}

export function invalidateDevicePairingStoreCache(database: OpenClawStateDatabase): void {
  const cached = cache.value;
  if (cached?.connection === database.db && cached.path === database.path) {
    cache.value = undefined;
  }
}
