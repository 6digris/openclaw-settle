import { parentPort, workerData } from "node:worker_threads";

const { register } = await import(workerData.sourceLoaderUrl);
register();
const { withStateDatabaseCoordinatorRuntimeDirectory } = await import(workerData.coordinatorUrl);
const { closeOpenClawStateDatabaseAsync, runOpenClawStateWriteTransaction } = await import(
  workerData.stateUrl
);
const { ensureProfileForEmail, setDisplayName } = await import(workerData.profilesUrl);
const flags = new Int32Array(workerData.flags);

await withStateDatabaseCoordinatorRuntimeDirectory(workerData.runtime, async () => {
  try {
    ensureProfileForEmail("writer@example.test", workerData.options);
    runOpenClawStateWriteTransaction(() => {
      setDisplayName(workerData.writerId, "Committed writer", workerData.options);
      const created = workerData.createEmail
        ? ensureProfileForEmail(workerData.createEmail, workerData.options)
        : undefined;
      Atomics.store(flags, 0, 1);
      parentPort.postMessage({ held: true, created }, []);
      Atomics.wait(flags, 1, 0, 10_000);
      // Release independently so a regressed synchronous reader cannot hang the test.
      Atomics.wait(flags, 1, 1, 500);
      Atomics.store(flags, 0, 2);
    }, workerData.options);
  } finally {
    await closeOpenClawStateDatabaseAsync();
    parentPort.close();
  }
});
