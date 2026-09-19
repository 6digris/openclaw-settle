import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { getRuntimeConfig } from "../../config/io.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { requestHeartbeat as requestCanonicalHeartbeat } from "../../infra/heartbeat-wake.js";
import * as events from "../../infra/system-events.js";
import {
  normalizeAgentIdStrict,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";

/** Published SDK aliases resolve here; the process queues retain only qualified identities. */
function resolveSystemEventSessionKey(sessionKey: string, agentId?: string): string {
  const owner = agentId === undefined ? null : normalizeAgentIdStrict(agentId);
  if (owner && !owner.ok) {
    throw new Error("Invalid system event agentId.");
  }
  const parsed = parseAgentSessionKey(sessionKey);
  if (parsed) {
    if (owner && parsed.agentId !== owner.value) {
      throw new Error("System event owner does not match its session key.");
    }
    return toAgentStoreSessionKey({ agentId: parsed.agentId, requestKey: sessionKey });
  }
  const cfg = getRuntimeConfig();
  return canonicalizeMainSessionAlias({
    cfg,
    agentId: resolveSessionAgentId({ config: cfg, sessionKey, agentId: owner?.value }),
    sessionKey,
  });
}

export const enqueueSystemEventFromSdk = (
  text: string,
  { agentId, ...options }: Parameters<typeof events.enqueueSystemEvent>[1] & { agentId?: string },
) =>
  events.enqueueSystemEvent(text, {
    ...options,
    sessionKey: resolveSystemEventSessionKey(options.sessionKey, agentId),
  });

export const enqueueSystemEventEntryFromSdk: typeof events.enqueueSystemEventEntry = (
  text,
  options,
) =>
  events.enqueueSystemEventEntry(text, {
    ...options,
    sessionKey: resolveSystemEventSessionKey(options.sessionKey),
  });

export function enqueueRoutedSystemEvent(
  text: string,
  route: { agentId: string; sessionKey: string },
  options: Omit<Parameters<typeof events.enqueueSystemEvent>[1], "sessionKey"> = {},
): boolean {
  if (!route.agentId.trim()) {
    throw new Error("routed system events require route.agentId");
  }
  return enqueueSystemEventFromSdk(text, {
    ...options,
    sessionKey: route.sessionKey,
    agentId: route.agentId,
  });
}

export const requestHeartbeatFromSdk: typeof requestCanonicalHeartbeat = (options) =>
  requestCanonicalHeartbeat({
    ...options,
    sessionKey: options.sessionKey
      ? resolveSystemEventSessionKey(options.sessionKey, options.agentId)
      : undefined,
  });

export const consumeSelectedSystemEventEntriesFromSdk: typeof events.consumeSelectedSystemEventEntries =
  (key, entries) =>
    events.consumeSelectedSystemEventEntries(resolveSystemEventSessionKey(key), entries);
export const drainSystemEventEntriesFromSdk: typeof events.drainSystemEventEntries = (key) =>
  events.drainSystemEventEntries(resolveSystemEventSessionKey(key));
export const drainSystemEventsFromSdk: typeof events.drainSystemEvents = (key) =>
  events.drainSystemEvents(resolveSystemEventSessionKey(key));
export const hasSystemEventsFromSdk: typeof events.hasSystemEvents = (key) =>
  events.hasSystemEvents(resolveSystemEventSessionKey(key));
export const isSystemEventContextChangedFromSdk: typeof events.isSystemEventContextChanged = (
  key,
  context,
) => events.isSystemEventContextChanged(resolveSystemEventSessionKey(key), context);
export function peekSystemEventEntriesFromSdk(key: string, agentId?: string) {
  return events.peekSystemEventEntries(resolveSystemEventSessionKey(key, agentId));
}
export const peekSystemEventsFromSdk: typeof events.peekSystemEvents = (key) =>
  events.peekSystemEvents(resolveSystemEventSessionKey(key));
export {
  resetSystemEventsForTest,
  resolveSystemEventDeliveryContext,
  type SystemEvent,
} from "../../infra/system-events.js";
