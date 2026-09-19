// Status-tool session resolution helpers keep storage lookup out of the tool body.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveSessionEntryCandidateTarget, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildAgentMainSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveInternalSessionKey } from "./sessions-helpers.js";

type ResolvedStatusSessionEntry = {
  entry: SessionEntry;
  key: string;
  persisted: boolean;
};

/** Resolves one status lookup against ordered tool-local session key candidates. */
export function resolveSessionStatusEntry(params: {
  agentId: string;
  cfg: OpenClawConfig;
  keyRaw: string;
  requesterInternalKey?: string;
}): ResolvedStatusSessionEntry | null {
  const keyRaw = params.keyRaw.trim();
  if (!keyRaw) {
    return null;
  }
  const internal = resolveInternalSessionKey({
    key: keyRaw,
    agentId: params.agentId,
    cfg: params.cfg,
    requesterInternalKey: params.requesterInternalKey,
  });

  const resolved = resolveSessionEntryCandidateTarget({
    agentId: params.agentId,
    candidateKeys: [internal],
    cfg: params.cfg,
  });
  return resolved
    ? {
        entry: resolved.entry,
        key: resolved.sessionKey,
        persisted: resolved.persisted,
      }
    : null;
}

/** Returns a synthesized current-session entry without writing it to storage. */
export function resolveImplicitCurrentSessionFallback(params: {
  allowFallback: boolean;
  fallbackKey: string;
}): ResolvedStatusSessionEntry | null {
  const fallbackKey = params.fallbackKey.trim();
  if (!params.allowFallback || !fallbackKey) {
    return null;
  }
  return {
    entry: { sessionId: "", updatedAt: Date.now() },
    key: fallbackKey,
    persisted: false,
  };
}

/** Lists policy-key fallbacks for implicit default-account direct status lookups. */
export function listImplicitDefaultDirectFallbackKeys(params: {
  keyRaw: string;
  mainKey: string;
}): string[] {
  const parsed = parseAgentSessionKey(params.keyRaw.trim());
  if (!parsed) {
    return [];
  }
  const parts = parsed.rest.split(":");
  if (parts.length < 4 || parts[1] !== "default" || parts[2] !== "direct") {
    return [];
  }
  const channel = parts[0];
  const peerParts = parts.slice(3);
  if (!channel || peerParts.length === 0) {
    return [];
  }
  const candidates = [
    `agent:${parsed.agentId}:${channel}:direct:${peerParts.join(":")}`,
    buildAgentMainSessionKey({
      agentId: parsed.agentId,
      mainKey: params.mainKey,
    }),
  ];
  return uniqueStrings(candidates);
}
