import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createMessageReceiptFromOutboundResults,
  type ProgressContinuationReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { finalizeInboundContext, type ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { expect, it, vi, type Mock } from "vitest";
import { noteSlackDraftConversationMessage } from "../../draft-message-boundaries.js";
import type * as SlackDraftStreamModule from "../../draft-stream.js";
import type * as SlackRepliesModule from "../replies.js";
import type * as SlackSendRuntime from "../send.runtime.js";
import type { SlackReplyOptionEvent } from "./dispatch.compact-progress.test-support.js";
import type * as SlackDispatchModule from "./dispatch.js";
import type { PreparedSlackMessage } from "./types.js";

export type DeliveryParams = Omit<
  Parameters<typeof SlackRepliesModule.deliverReplies>[0],
  "replies"
> & {
  replies: ReplyPayload[];
};

export function registerSlackProgressDispatchContracts(harness: {
  THREAD_TS: string;
  STREAM_MESSAGE_TS: string;
  createSlackDraftStreamMock: Mock;
  deliverRepliesMock: Mock<
    (params: DeliveryParams) => Promise<{ messageId?: string; channelId?: string } | undefined>
  >;
  sendMessageSlackMock: Mock<typeof SlackSendRuntime.sendMessageSlack>;
  finalizeSlackPreviewEditMock: Mock;
  editSlackRenderedMessageMock: Mock;
  startSlackStreamMock: Mock;
  stopSlackStreamMock: Mock;
  emitSlackMessageSentHooksMock: Mock;
  dispatchPreparedSlackMessage: typeof SlackDispatchModule.dispatchPreparedSlackMessage;
  createPreparedSlackMessage: (params?: {
    cfg?: Record<string, unknown>;
    accountConfig?: Record<string, unknown>;
    relayIdentity?: { username?: string };
    route?: { agentId: string; sessionKey: string };
    ctxPayload?: Record<string, unknown>;
    dispatchReplyFromConfig?: PreparedSlackMessage["ctx"]["dispatchReplyFromConfig"];
  }) => PreparedSlackMessage;
  dispatchNativeProgressScenario: (params: {
    events: SlackReplyOptionEvent[];
    finalPayload?: { text: string };
  }) => Promise<void>;
  collectNativeTaskUpdates: () => Record<string, unknown>[];
  expectDeliverReplyCall: (index: number, text: string) => void;
  configure: (options: {
    mode?: "progress";
    native?: boolean;
    realInbound?: boolean;
    events?: SlackReplyOptionEvent[];
    final?: { text: string };
  }) => void;
}) {
  const {
    THREAD_TS,
    STREAM_MESSAGE_TS,
    createSlackDraftStreamMock,
    deliverRepliesMock,
    sendMessageSlackMock,
    finalizeSlackPreviewEditMock,
    editSlackRenderedMessageMock,
    startSlackStreamMock,
    stopSlackStreamMock,
    emitSlackMessageSentHooksMock,
    dispatchPreparedSlackMessage,
    createPreparedSlackMessage,
    dispatchNativeProgressScenario,
    collectNativeTaskUpdates,
    expectDeliverReplyCall,
    configure,
  } = harness;
  it.each(["card", "compact"] as const)(
    "hands the confirmed %s draft to child progress before cleanup, including custom identity",
    async (style) => {
      const { createSlackDraftStream } =
        await vi.importActual<typeof SlackDraftStreamModule>("../../draft-stream.js");
      const entered = createDeferred<void>();
      const accepted = createDeferred<boolean>();
      const remove = vi.fn(async () => {});
      const draft = createSlackDraftStream({
        target: "channel:C123",
        cfg: {},
        token: "xoxb-test",
        accountId: "default",
        conversationChannelId: "C123",
        resolveThreadTs: () => THREAD_TS,
        send: async () => ({
          channelId: "C123",
          messageId: STREAM_MESSAGE_TS,
          receipt: createMessageReceiptFromOutboundResults({
            results: [{ channel: "slack", channelId: "C123", messageId: STREAM_MESSAGE_TS }],
            kind: "preview",
          }),
        }),
        edit: async () => {},
        remove,
      });
      createSlackDraftStreamMock.mockReturnValue(draft);
      configure({
        mode: "progress",
        native: false,
        events: [
          {
            kind: "item",
            itemKind: "preamble",
            itemId: "preamble-1",
            phase: "end",
            progressText: "Checking the workspace.",
          },
          { kind: "checkpoint", run: () => draft.flush() },
        ],
      });
      const adopt = vi.fn(async (receipt: ProgressContinuationReceipt) => {
        expect(receipt).toMatchObject({
          channel: "slack",
          accountId: "default",
          to: "channel:C123",
          messageId: STREAM_MESSAGE_TS,
          threadId: THREAD_TS,
        });
        expect(receipt.text).toContain("Checking the workspace");
        entered.resolve();
        return await accepted.promise;
      });
      const payload = setReplyPayloadMetadata(
        { text: "Waiting for child work." },
        {
          progressContinuation: { adopt, close: () => {} },
        },
      );
      configure({ final: payload });
      const dispatch = dispatchPreparedSlackMessage(
        createPreparedSlackMessage({
          relayIdentity: { username: "Custom Agent" },
          accountConfig: {
            streaming: {
              mode: "progress",
              progress: {
                style,
                toolProgress: false,
                commentary: true,
              },
            },
          },
        }),
      );
      await entered.promise;
      expect(remove).not.toHaveBeenCalled();
      expect(deliverRepliesMock).not.toHaveBeenCalled();
      accepted.resolve(true);
      await dispatch;
      await draft.clear();
      await draft.dropDetachedMessages();
      expect(adopt).toHaveBeenCalledOnce();
      expect(remove).not.toHaveBeenCalled();
      expect(deliverRepliesMock).not.toHaveBeenCalled();
      expect(finalizeSlackPreviewEditMock).not.toHaveBeenCalled();
    },
  );

  it("declines a progress draft displaced by a human and delivers the waiting fallback", async () => {
    const { createSlackDraftStream } =
      await vi.importActual<typeof SlackDraftStreamModule>("../../draft-stream.js");
    const draft = createSlackDraftStream({
      target: "channel:C123",
      cfg: {},
      token: "xoxb-test",
      conversationChannelId: "C123",
      resolveThreadTs: () => THREAD_TS,
      send: async () => ({
        channelId: "C123",
        messageId: STREAM_MESSAGE_TS,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "slack", channelId: "C123", messageId: STREAM_MESSAGE_TS }],
          kind: "preview",
        }),
      }),
      edit: async () => {},
      remove: async () => {},
    });
    createSlackDraftStreamMock.mockReturnValue(draft);
    configure({
      mode: "progress",
      events: [
        {
          kind: "item",
          itemKind: "preamble",
          itemId: "preamble-1",
          phase: "end",
          progressText: "Checking the workspace.",
        },
        {
          kind: "checkpoint",
          run: async () => {
            await draft.flush();
            noteSlackDraftConversationMessage({
              channelId: "C123",
              threadTs: THREAD_TS,
              messageTs: "171235.000",
              userId: "U_HUMAN",
            });
          },
        },
      ],
    });
    const adopt = vi.fn(async () => true);
    const payload = setReplyPayloadMetadata(
      { text: "Waiting for child work." },
      {
        progressContinuation: { adopt, close: () => {} },
      },
    );
    configure({ final: payload });
    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        accountConfig: {
          streaming: {
            mode: "progress",
            progress: {
              style: "compact",
              toolProgress: false,
              commentary: true,
            },
          },
        },
      }),
    );
    expect(adopt).not.toHaveBeenCalled();
    expectDeliverReplyCall(0, payload.text);
  });

  it.each(["accepted", "unconfirmed", "stopped"] as const)(
    "settles native progress without completing child tasks before handoff (%s)",
    async (outcome) => {
      const adopt = vi.fn(async () => true);
      const payload = setReplyPayloadMetadata(
        { text: "Waiting for child work." },
        {
          progressContinuation: { adopt, close: () => {} },
        },
      );
      if (outcome === "accepted") {
        stopSlackStreamMock.mockResolvedValue({ messageId: STREAM_MESSAGE_TS });
      } else if (outcome === "stopped") {
        startSlackStreamMock.mockResolvedValue(
          Object.assign(
            {
              channel: "C123",
              threadTs: THREAD_TS,
              stopped: true,
              delivered: true,
              pendingText: "",
            },
            { stoppedBySlack: true },
          ),
        );
      }
      await dispatchNativeProgressScenario({
        finalPayload: payload,
        events: [
          { kind: "plan", phase: "update", steps: [{ step: "Child work", status: "in_progress" }] },
        ],
      });
      if (outcome === "accepted") {
        expect(adopt).toHaveBeenCalledWith(
          expect.objectContaining({
            channel: "slack",
            messageId: STREAM_MESSAGE_TS,
            threadId: THREAD_TS,
          }),
        );
        expect(editSlackRenderedMessageMock).toHaveBeenCalledWith(
          "C123",
          STREAM_MESSAGE_TS,
          expect.any(String),
          expect.objectContaining({ blocks: expect.any(Array) }),
        );
        expect(collectNativeTaskUpdates().every((task) => task.status === "in_progress")).toBe(
          true,
        );
        expect(deliverRepliesMock).not.toHaveBeenCalled();
      } else {
        expect(adopt).not.toHaveBeenCalled();
        expect(editSlackRenderedMessageMock).not.toHaveBeenCalled();
        if (outcome === "unconfirmed") {
          expectDeliverReplyCall(0, payload.text);
        } else {
          expect(deliverRepliesMock).not.toHaveBeenCalled();
          expect(stopSlackStreamMock).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each([
    { agents: ["alice"], withMedia: true },
    { agents: ["alice", "bob"], withMedia: true },
    { agents: ["alice", "bob"], withMedia: false },
  ])(
    "binds group-thread completion hooks and media to the participant: $agents (media: $withMedia)",
    async ({ agents, withMedia }) => {
      configure({ realInbound: true, native: true });
      const { resolveGroupThreadMentionFacts } =
        await import("openclaw/plugin-sdk/channel-inbound");
      const workspaceRoot = path.join(realpathSync(tmpdir()), "slack-group-participants");
      const cfg = {
        agents: {
          entries: {
            root: { workspace: path.join(workspaceRoot, "workspace-root") },
            alice: { workspace: path.join(workspaceRoot, "workspace-alice") },
            bob: { workspace: path.join(workspaceRoot, "workspace-bob") },
          },
        },
        broadcast: { "slack:C123": agents },
      };
      const rootSessionKey = `agent:root:slack:channel:c123:thread:${THREAD_TS}`;
      const actualReplies = await vi.importActual<typeof SlackRepliesModule>("../replies.js");
      const { prepareSlackReply } = await import("../../reply-blocks.js");
      deliverRepliesMock.mockImplementation(async (params) =>
        actualReplies.deliverReplies({ ...params, replies: params.replies.map(prepareSlackReply) }),
      );
      sendMessageSlackMock.mockResolvedValue({
        messageId: "sent-1",
        channelId: "C123",
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "slack", messageId: "sent-1", channelId: "C123" }],
          kind: withMedia ? "media" : "text",
        }),
      });
      const participantRuns: string[] = [];
      const dispatchReplyFromConfig: NonNullable<
        Parameters<typeof dispatchPreparedSlackMessage>[0]["ctx"]["dispatchReplyFromConfig"]
      > = async ({ ctx, dispatcher }) => {
        if (!ctx.AgentId) {
          throw new Error("Expected participant agent identity");
        }
        participantRuns.push(ctx.AgentId);
        return {
          queuedFinal: dispatcher.sendFinalReply({
            text: `Reply from ${ctx.AgentId}`,
            ...(withMedia
              ? { mediaUrl: path.join(workspaceRoot, `workspace-${ctx.AgentId}`, "attachment.txt") }
              : {}),
          }),
          counts: dispatcher.getQueuedCounts(),
        };
      };

      await dispatchPreparedSlackMessage(
        createPreparedSlackMessage({
          cfg,
          route: { agentId: "root", sessionKey: rootSessionKey },
          ctxPayload: finalizeInboundContext({
            AgentId: "root",
            SessionKey: rootSessionKey,
            ChatType: "channel",
            Provider: "slack",
            Surface: "slack",
            OriginatingChannel: "slack",
            OriginatingTo: "channel:C123",
            NativeChannelId: "C123",
            AccountId: "default",
            From: "slack:C123",
            To: "channel:C123",
            SenderId: "U123",
            MessageSid: "171234.111",
            MessageThreadId: THREAD_TS,
            Body: "Review the attachment.",
            GroupThread: resolveGroupThreadMentionFacts({
              cfg,
              channel: "slack",
              peerId: "C123",
              text: "Review the attachment.",
              sessionKey: rootSessionKey,
            }),
          }),
          dispatchReplyFromConfig,
        }),
      );

      expect(participantRuns.toSorted()).toEqual(agents.toSorted());
      expect(emitSlackMessageSentHooksMock).toHaveBeenCalledTimes(agents.length);
      expect(sendMessageSlackMock).toHaveBeenCalledTimes(agents.length);
      for (const agentId of agents) {
        expect(emitSlackMessageSentHooksMock).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionKeyForInternalHooks: `agent:${agentId}:slack:channel:c123:thread:${THREAD_TS}`,
            success: true,
          }),
        );
        expect(sendMessageSlackMock).toHaveBeenCalledWith(
          "channel:C123",
          expect.stringContaining(`Reply from ${agentId}`),
          expect.objectContaining({
            ...(withMedia
              ? { mediaUrl: path.join(workspaceRoot, `workspace-${agentId}`, "attachment.txt") }
              : {}),
            mediaLocalRoots: expect.arrayContaining([
              path.join(workspaceRoot, `workspace-${agentId}`),
            ]),
          }),
        );
        const sent = sendMessageSlackMock.mock.calls.find(([, text]) =>
          text.includes(`Reply from ${agentId}`),
        );
        for (const other of ["root", "alice", "bob"].filter((id) => id !== agentId)) {
          expect(sent?.[2]?.mediaLocalRoots).not.toContain(
            path.join(workspaceRoot, `workspace-${other}`),
          );
        }
      }
      expect(startSlackStreamMock).not.toHaveBeenCalled();
      expect(createSlackDraftStreamMock).not.toHaveBeenCalled();
    },
  );
}
