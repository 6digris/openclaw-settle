/** Canonicalizes cron session keys into agent-scoped session-store keys. */
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import type { SessionScope } from "../../config/sessions/types.js";

/** Resolves a cron session key into the canonical agent-scoped session-store key. */
export function resolveCronAgentSessionKey(params: {
  sessionKey: string;
  agentId: string;
  mainKey?: string | undefined;
  cfg?: { session?: { scope?: SessionScope; mainKey?: string } };
}): string {
  return canonicalizeMainSessionAlias({
    cfg: {
      session: { ...params.cfg?.session, mainKey: params.mainKey ?? params.cfg?.session?.mainKey },
    },
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
}
