import { createOutboundPayloadPlan } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { TelegramDispatchTurn as Turn } from "./bot-message-dispatch.types.js";
import { canonicalizeTelegramPresentationPayload } from "./interactive-fallback.js";
import { resolveTelegramTargetChatType } from "./targets.js";

export const applyTextToPayload = (payload: ReplyPayload, text: string): ReplyPayload =>
  payload.text === text ? payload : { ...payload, text };

export const projectPayloadForDelivery = (
  turn: Turn,
  payload: ReplyPayload,
): ReplyPayload | undefined => {
  const projected = createOutboundPayloadPlan([payload])[0]?.payload;
  if (projected?.replyToCurrent && projected.replyToId === undefined) {
    // The raw planner has no turn context; resolve current-message intent before preview reuse.
    projected.replyToId =
      turn.context.ctxPayload.MessageSidFull ?? turn.context.ctxPayload.MessageSid;
  }
  return projected;
};

export function normalizeDeliveryPayload(
  turn: Turn,
  payload: ReplyPayload,
): ReplyPayload | undefined {
  const keepReasoningLane = payload.isReasoning === true && turn.durableReasoningPayloadsEnabled;
  const payloadForPlan = keepReasoningLane ? { ...payload } : payload;
  if (keepReasoningLane) {
    delete payloadForPlan.isReasoning;
  }
  const normalized = projectPayloadForDelivery(turn, payloadForPlan);
  if (!normalized) {
    return undefined;
  }
  return normalizePreparedDeliveryPayload(turn, normalized);
}

export function normalizePreparedDeliveryPayload(turn: Turn, payload: ReplyPayload): ReplyPayload {
  // Retained finals can still select HTML at send time, and HTML bypasses
  // rich blocks. Converting a presentation here would strip it while the
  // final funnel is still undecided, so rich accounts defer canonicalization
  // to the sender which knows the text mode.
  if (turn.telegramCfg.richMessages === true && payload.presentation) {
    return payload;
  }
  return canonicalizeTelegramPresentationPayload(payload, {
    allowWebAppButtons: resolveTelegramTargetChatType(String(turn.context.chatId)) === "direct",
    richTables: false,
  });
}
