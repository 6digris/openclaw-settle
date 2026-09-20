import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import {
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import {
  loadDevicePairingStoreStateFromDatabase,
  readDevicePairingStoreStateFromDatabase,
} from "./device-pairing-store.js";
import type { DevicePairingStoreState } from "./device-pairing.types.js";
import { getSqliteWorkerStateContext } from "./sqlite-worker-state-context.js";

export function readDevicePairingInventoryInWorker(
  input: OpenClawStateWorkerOperations["devicePairing.inventory"]["input"],
  context: { databasePath: string },
  open: () => OpenClawStateDatabase,
): DevicePairingStoreState {
  if (!input.readOnly) {
    return loadDevicePairingStoreStateFromDatabase(open());
  }
  const read = () =>
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readDevicePairingStoreStateFromDatabase(db),
      { path: context.databasePath, env: getSqliteWorkerStateContext().environment },
    ) ?? { pendingById: {}, pairedByDeviceId: {} };
  return input.artifactPreserving ? withArtifactPreservingStateReads(read) : read();
}
