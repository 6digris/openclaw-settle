import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";

type CaptureStoreClose =
  | { kind: "close" }
  | { kind: "database-retired"; database: OpenClawStateDatabase };

// Capture sessions must settle while their exact store is still writable.
// This registry avoids a runtime/store import cycle and never acquires a store.
const finalizers = new WeakMap<object, Set<(event: CaptureStoreClose) => void>>();
const closed = new WeakSet<object>();

export function registerCaptureStoreFinalizer(
  store: object,
  finalize: (event: CaptureStoreClose) => void,
): () => void {
  if (closed.has(store)) {
    throw new Error("Capture store is already finalized.");
  }
  let callbacks = finalizers.get(store);
  if (!callbacks) {
    callbacks = new Set();
    finalizers.set(store, callbacks);
  }
  callbacks.add(finalize);
  return () => callbacks.delete(finalize);
}

export function finalizeCaptureStore(
  store: object,
  event: CaptureStoreClose = { kind: "close" },
): void {
  if (closed.has(store)) {
    return;
  }
  if (event.kind === "close") {
    closed.add(store);
  }
  const callbacks = finalizers.get(store);
  if (event.kind === "close") {
    finalizers.delete(store);
  }
  const errors: unknown[] = [];
  for (const finalize of callbacks ?? []) {
    try {
      finalize(event);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Capture store finalization failed.");
  }
}
