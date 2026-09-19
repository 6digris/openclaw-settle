import { normalizeAgentId, normalizeAgentIdStrict } from "@openclaw/normalization-core/agent-id";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

export const DEFAULT_MAIN_KEY = "main";

export type ParsedAgentSessionKey = {
  agentId: string;
  rest: string;
};

/** Split the ownership head without changing opaque tail bytes or empty tail segments. */
export function parseAgentSessionKeyParts(sessionKey: string): ParsedAgentSessionKey | null {
  if (!sessionKey.startsWith("agent:") && sessionKey.slice(0, 6).toLowerCase() !== "agent:") {
    return null;
  }
  const agentIdEnd = sessionKey.indexOf(":", 6);
  if (agentIdEnd === -1) {
    return null;
  }
  const agentId = sessionKey.slice(6, agentIdEnd).trim();
  const rest = sessionKey.slice(agentIdEnd + 1);
  return agentId && rest && !rest.startsWith(":") ? { agentId, rest } : null;
}

/** Admit an ownership head without interpreting or rewriting its opaque session tail. */
export function normalizeAgentSessionKeyParts(
  sessionKey: string,
): Result<ParsedAgentSessionKey & { sessionKey: string }, "unscoped" | "malformed"> {
  if (sessionKey.slice(0, 6).toLowerCase() !== "agent:") {
    return err("unscoped");
  }
  const parsed = parseAgentSessionKeyParts(sessionKey);
  if (!parsed) {
    return err("malformed");
  }
  const owner = normalizeAgentIdStrict(parsed.agentId);
  return owner.ok
    ? ok({
        agentId: owner.value,
        rest: parsed.rest,
        sessionKey: `agent:${owner.value}:${parsed.rest}`,
      })
    : err("malformed");
}

export function normalizeMainKey(value: string | undefined | null): string {
  return normalizeLowercaseStringOrEmpty(value) || DEFAULT_MAIN_KEY;
}

export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string {
  return `agent:${normalizeAgentId(params.agentId)}:${normalizeMainKey(params.mainKey)}`;
}
