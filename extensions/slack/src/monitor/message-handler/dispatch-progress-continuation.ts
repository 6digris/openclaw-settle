import type { Block, KnownBlock } from "@slack/web-api";
import {
  createChannelProgressContinuation,
  type ChannelProgressDraftCompositorSnapshot,
  type ProgressContinuationReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { editSlackRenderedMessage } from "../../actions.js";
import type { SlackDraftStream } from "../../draft-stream.js";
import { formatSlackError } from "../../errors.js";
import { stopSlackStream, type SlackStreamSession } from "../../streaming.js";
import { formatSlackTarget } from "../../target-parsing.js";
import type { SlackDispatchSetup } from "./dispatch-setup.js";
import type { SlackStreamingDeliveryRuntime } from "./dispatch-streaming.js";

export function createSlackProgressContinuation(params: {
  setup: Pick<SlackDispatchSetup, "account" | "cfg" | "ctx" | "prepared" | "slackMessageMetadata">;
  delivery: SlackStreamingDeliveryRuntime;
  draftStream: SlackDraftStream | undefined;
  progressDraft: {
    markFinalReplyStarted: () => void;
    markFinalReplyDelivered: () => void;
    getSnapshot: () => ChannelProgressDraftCompositorSnapshot;
    getText: () => string;
  };
  progressCard: {
    resolvePresentation: (
      snapshot: ChannelProgressDraftCompositorSnapshot,
      state: "working",
    ) => (Block | KnownBlock)[];
  };
  isProgressMode: boolean;
  useNativeProgressStreaming: boolean;
  settleNativeUpdates: () => Promise<void>;
  onNativeReleased: () => void;
}) {
  const { account, cfg, ctx, prepared, slackMessageMetadata } = params.setup;
  const { delivery, draftStream, progressDraft, progressCard, useNativeProgressStreaming } = params;
  let preparedNativeReceipt:
    | { session: SlackStreamSession; receipt: ProgressContinuationReceipt }
    | undefined;
  return createChannelProgressContinuation({
    prepareReceipt: async (assertCurrent): Promise<ProgressContinuationReceipt | undefined> => {
      if (!params.isProgressMode) {
        return undefined;
      }
      progressDraft.markFinalReplyStarted();
      if (!useNativeProgressStreaming) {
        await draftStream?.seal();
        assertCurrent();
        return draftStream?.progressReceipt();
      }

      delivery.assertProgressCurrent = assertCurrent;
      await params.settleNativeUpdates();
      assertCurrent();
      const session = delivery.streamSession;
      if (!session || session.stopped || session.stoppedBySlack || delivery.streamFailed) {
        return undefined;
      }
      try {
        // Stop only the transport, not its running task rows. Slack task chunks
        // cannot be edited after stop; retain the same ID as an ordinary Block Kit card.
        const stopped = await stopSlackStream({
          session,
          ...(slackMessageMetadata ? { metadata: slackMessageMetadata } : {}),
        });
        assertCurrent();
        if (!stopped.messageId || session.stoppedBySlack || delivery.streamSession !== session) {
          return undefined;
        }
        const snapshot = progressDraft.getSnapshot();
        const text = progressDraft.getText();
        await editSlackRenderedMessage(session.channel, stopped.messageId, text, {
          cfg,
          token: ctx.botToken,
          accountId: account.accountId,
          teamId: prepared.eventScope?.teamId,
          assertDirectAdapterHandoff: assertCurrent,
          blocks: progressCard.resolvePresentation(snapshot, "working"),
        });
        assertCurrent();
        if (session.stoppedBySlack || delivery.streamSession !== session) {
          return undefined;
        }
        delivery.observedReplyDelivery = true;
        delivery.usedReplyThreadTs ??= session.threadTs;
        const receipt: ProgressContinuationReceipt = {
          channel: "slack",
          accountId: account.accountId,
          to: formatSlackTarget({
            kind: "channel",
            id: session.channel,
            explicitKind: true,
            teamId: prepared.eventScope?.teamId,
          }),
          threadId: session.threadTs,
          messageId: stopped.messageId,
          text,
          snapshot,
        };
        preparedNativeReceipt = { session, receipt };
        return receipt;
      } catch (err) {
        assertCurrent();
        logVerbose(`slack: native progress handoff declined (${formatSlackError(err)})`);
        return undefined;
      }
    },
    releaseReceipt: (receipt) => {
      if (useNativeProgressStreaming) {
        if (
          preparedNativeReceipt?.receipt === receipt &&
          delivery.streamSession === preparedNativeReceipt.session
        ) {
          delivery.streamSession = null;
          delivery.nativeProgressStreamStartPromise = null;
          delivery.nativeProgressStreamThreadTs = undefined;
          params.onNativeReleased();
          preparedNativeReceipt = undefined;
        }
      } else {
        draftStream?.releaseProgressReceipt(receipt);
      }
      progressDraft.markFinalReplyDelivered();
    },
    discardPending: async () => {
      if (!useNativeProgressStreaming) {
        await draftStream?.discardPending();
      }
    },
  });
}
