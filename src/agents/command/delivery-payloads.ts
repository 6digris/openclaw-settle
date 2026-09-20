import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  normalizeReplyPayloadOutcome,
  type NormalizeReplyOutcome,
  type NormalizeReplySkipReason,
} from "../../auto-reply/reply/normalize-reply.js";
import { resolveResponsePrefixTemplate } from "../../auto-reply/reply/response-prefix-template.js";
import { createChannelReplyTransform } from "../../channels/message/reply-transform.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createReplyPrefixContext } from "../../channels/reply-prefix.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OutboundSessionContext } from "../../infra/outbound/session-context.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import type { AgentCommandOpts } from "./types.js";

type RunResult = Awaited<ReturnType<(typeof import("../embedded-agent.js"))["runEmbeddedAgent"]>>;
const UNRESOLVED_RESPONSE_PREFIX_VAR_PATTERN = /\{[a-zA-Z][a-zA-Z0-9.]*\}/;

/** Normalizes reply payloads and media paths before delivery. */
export function normalizeAgentCommandReplyPayloads(params: {
  cfg: OpenClawConfig;
  opts: AgentCommandOpts;
  outboundSession: OutboundSessionContext | undefined;
  payloads: ReplyPayload[] | undefined;
  result: RunResult;
  deliveryChannel?: string;
  plugin?: ChannelPlugin;
  accountId?: string;
  applyChannelTransforms?: boolean;
  includeRunModelContext?: boolean;
}): NormalizeReplyOutcome<ReplyPayload[]> {
  const payloads = params.payloads ?? [];
  if (payloads.length === 0) {
    return { kind: "suppress", reason: "empty" };
  }
  const channel =
    params.deliveryChannel && !isInternalMessageChannel(params.deliveryChannel)
      ? (normalizeChannelId(params.deliveryChannel) ?? params.deliveryChannel)
      : undefined;
  if (!channel) {
    return { kind: "deliver", payload: payloads };
  }
  const applyChannelTransforms = params.applyChannelTransforms ?? true;
  const deliveryPlugin = applyChannelTransforms ? params.plugin : undefined;

  const sessionKey = params.outboundSession?.key ?? params.opts.sessionKey;
  const agentId =
    params.outboundSession?.agentId ??
    resolveSessionAgentId({
      sessionKey,
      config: params.cfg,
    });
  const replyPrefix = createReplyPrefixContext({
    cfg: params.cfg,
    agentId,
    channel,
    accountId: params.accountId,
  });
  const modelUsed = params.result.meta.agentMeta?.model;
  const providerUsed = params.result.meta.agentMeta?.provider;
  if (params.includeRunModelContext !== false && providerUsed && modelUsed) {
    replyPrefix.onModelSelected({
      provider: providerUsed,
      model: modelUsed,
      thinkLevel: undefined,
    });
  }
  const responsePrefixContext = replyPrefix.responsePrefixContextProvider();
  const resolvedResponsePrefix = resolveResponsePrefixTemplate(
    replyPrefix.responsePrefix,
    responsePrefixContext,
  );
  const responsePrefix =
    params.includeRunModelContext === false &&
    resolvedResponsePrefix &&
    UNRESOLVED_RESPONSE_PREFIX_VAR_PATTERN.test(resolvedResponsePrefix)
      ? undefined
      : replyPrefix.responsePrefix;
  const deliveryMessaging = deliveryPlugin?.messaging;
  const transformReplyPayload = createChannelReplyTransform({
    messaging: deliveryMessaging,
    cfg: params.cfg,
    accountId: params.accountId,
  });

  const normalizedPayloads: ReplyPayload[] = [];
  let suppressionReason: NormalizeReplySkipReason | undefined;
  for (const payload of payloads) {
    const outcome = normalizeReplyPayloadOutcome(payload, {
      responsePrefix,
      applyChannelTransforms,
      responsePrefixContext,
      transformReplyPayload,
    });
    if (outcome.kind === "deliver") {
      normalizedPayloads.push(outcome.payload);
    } else if (suppressionReason === undefined || outcome.reason === "channel_transform") {
      suppressionReason = outcome.reason;
    }
  }
  return normalizedPayloads.length > 0
    ? { kind: "deliver", payload: normalizedPayloads }
    : { kind: "suppress", reason: suppressionReason ?? "empty" };
}
