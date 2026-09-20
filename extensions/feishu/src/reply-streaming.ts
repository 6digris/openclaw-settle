import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import {
  buildChannelProgressDraftLineForEntry,
  createChannelProgressContinuation,
  type ProgressContinuationReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import type { ClawdbotConfig, OutboundIdentity, ReplyPayload } from "../runtime-api.js";
import { resolveFeishuIdentityEmoji } from "./identity-header.js";
import {
  createFeishuReplyDeliveryResult,
  noVisibleFeishuReplyDelivery,
  type FeishuReplyDeliveryResult,
} from "./reply-delivery-result.js";
import { captureFeishuSendAuthority, withFeishuRequestContext } from "./send-context.js";
import { editMessageFeishu, type CardHeaderConfig } from "./send.js";
import type { FeishuStreamingSession } from "./streaming-card.js";
import type { ResolvedFeishuAccount } from "./types.js";

type FeishuProgressState = {
  session: FeishuStreamingSession | null;
  generation: number | undefined;
  start: Promise<void> | null;
  updates: Promise<void>;
  hasFinalText: boolean;
  hasPendingDelivery: boolean;
  text: string;
  answer: string;
  statusLine: string;
  statusProgressInput?: Parameters<typeof buildChannelProgressDraftLineForEntry>[1];
};

type FeishuDeliveryInfo = Parameters<ChannelInboundTurnPlan["delivery"]["deliver"]>[1];

/** The dispatcher retains its live generation; core owns continuation admission and settlement. */
export function createFeishuProgressContinuation(params: {
  cfg: ClawdbotConfig;
  account: Pick<ResolvedFeishuAccount, "accountId" | "config">;
  accountId?: string;
  agentId: string;
  identity?: OutboundIdentity;
  to: string;
  threadId?: string;
  enabled: boolean;
  responsePrefixContextProvider: () => { model?: string; provider?: string };
  pause: () => void;
  getState: () => FeishuProgressState;
  release: (session: FeishuStreamingSession, generation: number) => void;
  markVisible: () => void;
}) {
  let preparedProgress:
    | {
        session: FeishuStreamingSession;
        generation: number;
        receipt: ProgressContinuationReceipt;
        updates: Promise<void>;
      }
    | undefined;
  let progressUpdatesToDiscard: Promise<void> = Promise.resolve();
  const continuation = createChannelProgressContinuation({
    prepareReceipt: async (assertCurrent) => {
      params.pause();
      const state = params.getState();
      const { session, generation, updates } = state;
      if (
        !params.enabled ||
        !session ||
        generation === undefined ||
        state.hasFinalText ||
        state.hasPendingDelivery
      ) {
        // Admitted reply blocks are not a standalone progress preview.
        return undefined;
      }
      await state.start;
      await updates;
      assertCurrent();
      // Reasoning alone and an empty CardKit typing shell are not task progress.
      if (
        !session.isActive() ||
        !session.getMessageId() ||
        !(state.answer.trim() || state.statusLine.trim())
      ) {
        return undefined;
      }
      const { text } = state;
      const progressLine = state.statusProgressInput
        ? buildChannelProgressDraftLineForEntry(params.account.config, state.statusProgressInput)
        : undefined;
      const snapshot: ProgressContinuationReceipt["snapshot"] = {
        lines: state.statusLine ? [progressLine ?? state.statusLine] : [],
        ...(state.answer ? { statusHeadline: state.answer } : {}),
        preparedBlocks: [{ text, format: "markdown" }],
      };
      const closed = await withFeishuRequestContext(assertCurrent, () =>
        session.closeWithResult(text, {
          note: resolveCardNote(
            params.agentId,
            params.identity,
            params.responsePrefixContextProvider(),
          ),
        }),
      );
      assertCurrent();
      if (!closed.messageId || !closed.visibleReplySent || closed.content !== text) {
        return undefined;
      }
      const messageId = closed.messageId;
      params.markVisible();
      // Confirm the task presenter's registered static-card edit, not just a closed entity.
      await withFeishuRequestContext(assertCurrent, () =>
        editMessageFeishu({
          cfg: params.cfg,
          accountId: params.accountId,
          messageId,
          progressSnapshot: snapshot,
          header: resolveCardHeader(params.agentId, params.identity),
          note: resolveCardNote(
            params.agentId,
            params.identity,
            params.responsePrefixContextProvider(),
          ),
        }),
      );
      assertCurrent();
      const receipt: ProgressContinuationReceipt = {
        channel: "feishu",
        accountId: params.account.accountId,
        to: params.to,
        threadId: params.threadId,
        messageId,
        text,
        snapshot,
      };
      preparedProgress = { session, generation, receipt, updates };
      return receipt;
    },
    releaseReceipt: (receipt) => {
      const prepared = preparedProgress;
      if (prepared?.receipt !== receipt) {
        return;
      }
      preparedProgress = undefined;
      progressUpdatesToDiscard = prepared.updates;
      params.release(prepared.session, prepared.generation);
      params.markVisible();
    },
    discardPending: async () => {
      await progressUpdatesToDiscard;
    },
  });

  return {
    settle: continuation.settle,
    async deliver(
      payload: ReplyPayload,
      info: FeishuDeliveryInfo,
    ): Promise<FeishuReplyDeliveryResult | undefined> {
      const previousPreparedProgress = preparedProgress;
      if (await continuation.adopt(payload, info)) {
        return { ...noVisibleFeishuReplyDelivery, visibleReplySent: true };
      }
      const prepared = preparedProgress === previousPreparedProgress ? undefined : preparedProgress;
      if (info.kind !== "final" || !prepared) {
        return undefined;
      }
      // A declined transfer remains ours. Replace that exact closed card rather
      // than sending a second waiting message or abandoning its cleanup owner.
      const text = payload.text ?? "";
      const assertCurrent = captureFeishuSendAuthority();
      assertCurrent?.();
      await withFeishuRequestContext(assertCurrent, () =>
        editMessageFeishu({
          cfg: params.cfg,
          accountId: params.accountId,
          messageId: prepared.receipt.messageId,
          progressSnapshot: { lines: [], preparedBlocks: [{ text, format: "markdown" }] },
          header: resolveCardHeader(params.agentId, params.identity),
          note: resolveCardNote(
            params.agentId,
            params.identity,
            params.responsePrefixContextProvider(),
          ),
        }),
      );
      preparedProgress = undefined;
      params.release(prepared.session, prepared.generation);
      params.markVisible();
      return createFeishuReplyDeliveryResult({
        results: [{ messageId: prepared.receipt.messageId }],
        visibleReplySent: true,
        content: text,
        kind: "card",
      });
    },
  };
}

/** Detect if text contains markdown elements that benefit from card rendering */
export function shouldUseCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text);
}

export function mergeStreamingFinalText(
  previousText: string,
  nextText: string,
  appendError: boolean,
): string {
  if (!appendError || !previousText) {
    return nextText;
  }
  if (nextText.startsWith(previousText)) {
    return nextText;
  }
  if (previousText.endsWith(`\n\n${nextText}`)) {
    return previousText;
  }
  return `${previousText}\n\n${nextText}`;
}

/** Build a card header from agent identity config. */
export function resolveCardHeader(
  agentId: string,
  identity: OutboundIdentity | undefined,
): CardHeaderConfig | undefined {
  const name = identity?.name?.trim() || (agentId === "main" ? "" : agentId);
  const emoji = resolveFeishuIdentityEmoji(identity?.emoji);
  const title = (emoji ? `${emoji} ${name}` : name).trim();
  if (!title) {
    return undefined;
  }
  return { title, template: identity?.theme ?? "blue" };
}

/** Build a card note footer from agent identity and model context. */
export function resolveCardNote(
  agentId: string,
  identity: OutboundIdentity | undefined,
  prefixCtx: { model?: string; provider?: string },
): string {
  const name = identity?.name?.trim() || agentId;
  const parts: string[] = [`Agent: ${name}`];
  if (prefixCtx.model) {
    parts.push(`Model: ${prefixCtx.model}`);
  }
  if (prefixCtx.provider) {
    parts.push(`Provider: ${prefixCtx.provider}`);
  }
  return parts.join(" | ");
}

function formatReasoningPrefix(thinking: string): string {
  if (!thinking) {
    return "";
  }
  const withoutLabel = thinking.replace(/^(?:Reasoning:|Thinking\.{0,3})\s*/u, "");
  const plain = withoutLabel.replace(/^_(.*)_$/gm, "$1");
  const lines = plain.split("\n").map((line) => `> ${line}`);
  return `> 💭 **Thinking**\n${lines.join("\n")}`;
}

export function buildCombinedStreamText(
  thinking: string,
  answer: string,
  statusLine: string,
): string {
  const parts: string[] = [];
  if (thinking) {
    parts.push(formatReasoningPrefix(thinking));
  }
  if (thinking && answer) {
    parts.push("\n\n---\n\n");
  }
  if (answer) {
    parts.push(answer);
  }
  if (statusLine) {
    parts.push(parts.length > 0 ? `\n\n${statusLine}` : statusLine);
  }
  return parts.join("");
}
