import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { isCronRunSessionKey, isSubagentSessionKey } from "../sessions/session-key-utils.js";
import type { readSessionRowModelFacts } from "./session-row-model-facts.js";
import type { materializeSessionRow } from "./session-utils-row.js";

export function readSessionListSelectionFacts(
  key: string,
  entry?: { sessionId?: string; updatedAt?: number | null; spawnedBy?: string },
) {
  const parsed = parseAgentSessionKey(key);
  return {
    agentId: parsed ? normalizeAgentId(parsed.agentId) : undefined,
    isGlobal: parsed?.rest === "global",
    isUnknown: parsed?.rest === "unknown",
    isCronRun: isCronRunSessionKey(key),
    isSubagent: isSubagentSessionKey(key) || Boolean(entry?.spawnedBy),
    isPhantom:
      entry?.updatedAt == null &&
      !normalizeOptionalString(entry?.sessionId) &&
      parsed?.rest === "sessions",
  };
}

/** Cold rows prepare only the model facts needed by search. */
export type SessionListTargetLookup = (key: string) =>
  | {
      agentId: string;
      selection: ReturnType<typeof readSessionListSelectionFacts>;
      materialized?: Pick<ReturnType<typeof materializeSessionRow>, "source">;
      getModelFacts?: () => Pick<
        ReturnType<typeof readSessionRowModelFacts>,
        "selectedModel" | "rowModelIdentity" | "thinkingProjection"
      >;
    }
  | undefined;
