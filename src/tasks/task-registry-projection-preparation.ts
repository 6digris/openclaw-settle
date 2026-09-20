import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { getTaskRegistryProcessState } from "./task-registry.process-state.js";
import {
  loadTaskRegistryMutationSnapshots,
  type TaskRegistryStore,
} from "./task-registry.store.js";

function canShareTaskRegistryPreparation(context: OpenClawStateWorkerContext): boolean {
  // Maintenance and schema inspection retain their own captured custody.
  return (
    context.maintenanceScope === undefined &&
    context.existingSchemaPath === undefined &&
    context.runInCapturedSchemaScope === undefined
  );
}

/** Shares preparation while the registry owner retains admission and snapshot publication. */
export function createTaskRegistryProjectionPreparation(owner: {
  assertCurrent: (context: OpenClawStateWorkerContext, store: TaskRegistryStore) => void;
  ensureReady: (context: OpenClawStateWorkerContext) => Promise<void>;
  installBatch: (
    context: OpenClawStateWorkerContext,
    store: TaskRegistryStore,
    epoch: number,
    snapshots: Awaited<ReturnType<typeof loadTaskRegistryMutationSnapshots>>,
  ) => number | undefined;
}) {
  const projection = getTaskRegistryProcessState().projection;
  const dirtyScopes = projection.dirtyScopes;
  return async function prepareTaskRegistryProjectionAsync(
    context: OpenClawStateWorkerContext,
    store: TaskRegistryStore,
    maxAttempts = Number.POSITIVE_INFINITY,
  ): Promise<boolean> {
    owner.assertCurrent(context, store);
    await owner.ensureReady(context);
    owner.assertCurrent(context, store);
    let attempts = 0;
    while (projection.mutationDepth === 0 && (projection.dirty || dirtyScopes.size > 0)) {
      if (attempts++ >= maxAttempts) {
        return false;
      }
      const epoch = projection.epoch;
      const scopes = projection.dirty ? [undefined] : [...dirtyScopes];
      if (!canShareTaskRegistryPreparation(context)) {
        const snapshots = await loadTaskRegistryMutationSnapshots(context, store, scopes);
        if (owner.installBatch(context, store, epoch, snapshots) !== undefined) {
          return true;
        }
        continue;
      }
      let prepared: Promise<number | undefined>;
      let pending = projection.preparation;
      if (pending) {
        const previous = pending.context;
        if (
          !pending.matchesStore(store) ||
          pending.epoch !== epoch ||
          previous.admission.identity.key !== context.admission.identity.key ||
          previous.admission.databasePath !== context.admission.databasePath ||
          previous.environment.OPENCLAW_STATE_DIR !== context.environment.OPENCLAW_STATE_DIR ||
          previous.environment.OPENCLAW_SUPERVISOR_MODE !==
            context.environment.OPENCLAW_SUPERVISOR_MODE ||
          previous.coordinatorRuntime.directory !== context.coordinatorRuntime.directory ||
          previous.coordinatorRuntime.keepAlive !== context.coordinatorRuntime.keepAlive
        ) {
          pending = undefined;
        } else {
          try {
            owner.assertCurrent(previous, store);
          } catch {
            pending = undefined;
          }
        }
      }
      if (pending) {
        prepared = pending.promise;
      } else {
        const promise = Promise.resolve().then(async () => {
          try {
            owner.assertCurrent(context, store);
            const snapshots = await loadTaskRegistryMutationSnapshots(context, store, scopes);
            return owner.installBatch(context, store, epoch, snapshots);
          } finally {
            if (projection.preparation?.promise === promise) {
              projection.preparation = undefined;
            }
          }
        });
        projection.preparation = {
          context,
          matchesStore: (candidate) => candidate === store,
          epoch,
          promise,
        };
        prepared = promise;
      }
      const installedEpoch = await prepared;
      owner.assertCurrent(context, store);
      if (installedEpoch !== undefined && installedEpoch === projection.epoch) {
        return true;
      }
    }
    return true;
  };
}
