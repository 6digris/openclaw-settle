/** Resolves runtime policy session keys distinct from transcript session keys. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import {
  canonicalizeMainSessionAlias,
  resolveAgentMainSessionKey,
} from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildAgentPeerSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import type { MsgContext } from "../templating.js";

type RuntimePolicyContext = Pick<
  MsgContext,
  | "AgentId"
  | "AccountId"
  | "ChatType"
  | "CommandTargetSessionKey"
  | "From"
  | "NativeDirectUserId"
  | "OriginatingChannel"
  | "OriginatingTo"
  | "Provider"
  | "RuntimePolicySessionKey"
  | "SenderE164"
  | "SenderId"
  | "SenderUsername"
  | "SessionKey"
  | "Surface"
  | "To"
>;

function resolvePolicyChannel(ctx?: RuntimePolicyContext): string | undefined {
  const raw = normalizeOptionalString(ctx?.OriginatingChannel ?? ctx?.Provider ?? ctx?.Surface);
  if (!raw) {
    return undefined;
  }
  const channel = normalizeLowercaseStringOrEmpty(raw);
  return channel && channel !== "webchat" ? channel : undefined;
}

function resolvePolicyDirectPeerId(ctx?: RuntimePolicyContext): string | undefined {
  return normalizeOptionalString(
    ctx?.NativeDirectUserId ??
      ctx?.SenderId ??
      ctx?.SenderE164 ??
      ctx?.SenderUsername ??
      ctx?.OriginatingTo ??
      ctx?.From ??
      ctx?.To,
  );
}

/** Resolves the session key used for sandbox/tool/runtime policy lookups. */
export function resolveRuntimePolicySessionKey(params: {
  agentId?: string;
  cfg?: OpenClawConfig;
  ctx?: RuntimePolicyContext;
  sessionKey?: string | null;
}): string | undefined {
  const explicitPolicySessionKey = normalizeOptionalString(params.ctx?.RuntimePolicySessionKey);
  const input = normalizeOptionalString(
    explicitPolicySessionKey ??
      params.sessionKey ??
      params.ctx?.CommandTargetSessionKey ??
      params.ctx?.SessionKey,
  );
  if (!input) {
    return undefined;
  }
  const agentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: input,
    // An explicit policy identity can belong to a different agent than the active conversation.
    agentId:
      parseAgentSessionKey(explicitPolicySessionKey)?.agentId ??
      params.agentId ??
      normalizeOptionalString(params.ctx?.AgentId),
  });
  const sessionKey = canonicalizeMainSessionAlias({ cfg: params.cfg, agentId, sessionKey: input });
  if (
    explicitPolicySessionKey ||
    sessionKey !== resolveAgentMainSessionKey({ cfg: params.cfg, agentId })
  ) {
    return sessionKey;
  }

  if (normalizeChatType(params.ctx?.ChatType) !== "direct") {
    return sessionKey;
  }
  const channel = resolvePolicyChannel(params.ctx);
  const peerId = resolvePolicyDirectPeerId(params.ctx);
  if (!channel || !peerId) {
    return sessionKey;
  }

  // Direct main-session replies use a peer-scoped key so policy does not leak across DMs.
  return buildAgentPeerSessionKey({
    agentId,
    channel,
    accountId: params.ctx?.AccountId,
    peerKind: "direct",
    peerId,
    dmScope: "per-account-channel-peer",
    identityLinks: params.cfg?.session?.identityLinks,
  });
}
