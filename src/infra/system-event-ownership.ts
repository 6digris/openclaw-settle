import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";

export type SessionEventStoreTarget = { sessionKey?: string; agentId?: string };
export type PublishedSystemEventStoreSelection = {
  config: OpenClawConfig;
  preparedStorePaths: ReadonlyMap<string, string | null>;
  resolveStorePath(target: SessionEventStoreTarget): string | undefined;
  samePath(left: string, right: string): boolean;
  rememberWatcher(sessionKey: string, storePath: string | null): void;
  activate(onStoreChange: () => void): () => void;
};
const storeOwnership = resolveGlobalSingleton<{
  selection: PublishedSystemEventStoreSelection | undefined;
  stopObservation?: () => void;
  owners: Map<symbol, () => void>;
}>(
  Symbol.for("openclaw.sessionEventStoreOwnership"),
  () => ({ selection: undefined, owners: new Map() }),
  () => publishSystemEventStoreSelection(undefined),
  // Pending wakes keep this accepted selection until the next Gateway publishes its store.
  "close-only",
);

export function getPublishedSystemEventStoreSelection():
  | PublishedSystemEventStoreSelection
  | undefined {
  return storeOwnership.selection;
}

/** Event producers carry a copy of prepared watcher facts across their asynchronous work. */
export function captureSystemEventStorePaths(
  cfg?: OpenClawConfig | null,
): Readonly<Record<string, string | null>> {
  const selection = storeOwnership.selection;
  return selection && (cfg === undefined || cfg === selection.config)
    ? Object.fromEntries(selection.preparedStorePaths)
    : {};
}

/** Committed watcher registrations publish only into the selection that admitted them. */
export function rememberSystemEventStoreWatcher(
  sessionKey: string,
  storePath: string | null,
  selection: PublishedSystemEventStoreSelection | undefined,
): void {
  if (selection && storeOwnership.selection === selection) {
    selection.rememberWatcher(sessionKey, storePath);
  }
}

/** Queue admission borrows the config owner's published selection without loading storage runtime. */
export function getPublishedSystemEventStorePath(
  target: SessionEventStoreTarget,
): string | undefined {
  return storeOwnership.selection?.resolveStorePath(target);
}

export function isSystemEventStoreCurrent(
  target: SessionEventStoreTarget,
  storePath: string | null | undefined,
): boolean {
  // An unscoped scheduler sweep selects its sessions when it runs.
  if (!target.sessionKey) {
    return storePath !== null;
  }
  const selection = storeOwnership.selection;
  if (!storePath || !selection) {
    return false;
  }
  const current = selection.resolveStorePath(target);
  return current !== undefined && selection.samePath(storePath, current);
}

/** Owners retire their own queues synchronously after the config owner publishes its selection. */
export function publishSystemEventStoreSelection(
  selection: PublishedSystemEventStoreSelection | undefined,
): void {
  storeOwnership.stopObservation?.();
  storeOwnership.stopObservation = undefined;
  storeOwnership.selection = selection;
  storeOwnership.stopObservation = selection?.activate(retireReplacedSystemEventStores);
  retireReplacedSystemEventStores();
}

function retireReplacedSystemEventStores(): void {
  for (const retire of storeOwnership.owners.values()) {
    retire();
  }
}

export function registerSystemEventStoreOwner(owner: symbol, retire: () => void): void {
  storeOwnership.owners.set(owner, retire);
}

export function recordSystemEventStoreReplaced(): void {
  emitHeartbeatEvent({
    status: "skipped",
    reason: "store-replaced",
    message:
      "Dropped notification because its session store was replaced or could not be established.",
  });
}

/** Queue identity is scoped without rewriting the caller's persisted session key. */
export function resolveSystemEventQueueKey(sessionKey: string, agentId?: string): string {
  if (!sessionKey.trim()) {
    throw new Error("system events require a sessionKey");
  }
  const owner = resolveAgentIdFromSessionKey(sessionKey, agentId);
  if (agentId && owner !== normalizeAgentId(agentId)) {
    throw new Error("System event owner does not match its session key.");
  }
  return toAgentStoreSessionKey({ agentId: owner, requestKey: sessionKey });
}

export function withSystemEventOwner<T extends { sessionKey: string }>(
  options: T,
  agentId: string,
): Omit<T, "sessionKey"> & { sessionKey: string } {
  return { ...options, sessionKey: resolveSystemEventQueueKey(options.sessionKey, agentId) };
}
