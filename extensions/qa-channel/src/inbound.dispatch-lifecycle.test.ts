import assert from "node:assert/strict";
import type { ProgressContinuationReceipt } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { createReplyDispatcher, SILENT_REPLY_TOKEN } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState, startQaBusServer } from "../../qa-lab/bus-api.js";
import {
  editQaBusMessage,
  getQaBusState,
  injectQaBusInboundMessage,
  sendQaBusMessage,
} from "./bus-client.js";
import { qaChannelMessageActions } from "./channel-actions.js";
import { createQaInboundParams, runQaInbound } from "./inbound.test-harness.js";

async function withQaBus(run: (params: ReturnType<typeof createQaInboundParams>) => Promise<void>) {
  const bus = await startQaBusServer({ state: createQaBusState() });
  try {
    const params = createQaInboundParams();
    params.account.baseUrl = bus.baseUrl;
    params.config = { channels: { "qa-channel": { baseUrl: bus.baseUrl } } };
    params.message = (
      await injectQaBusInboundMessage({
        baseUrl: bus.baseUrl,
        input: params.message,
      })
    ).message;
    await run(params);
  } finally {
    await bus.stop();
  }
}

async function visibleReplies(baseUrl: string) {
  const state = await getQaBusState(baseUrl);
  return state.messages.filter((message) => message.direction === "outbound" && !message.deleted);
}

describe("QA inbound dispatch settlement", () => {
  it("sanitizes replacement tool traces while ordinary edits retain them", async () => {
    await withQaBus(async (params) => {
      const { message } = await sendQaBusMessage({
        baseUrl: params.account.baseUrl,
        accountId: "default",
        to: "dm:alice",
        text: "Progress",
        toolCalls: [{ name: "old-tool" }],
      });
      const edit = {
        baseUrl: params.account.baseUrl,
        accountId: "default",
        messageId: message.id,
        text: "Updated",
      };
      await editQaBusMessage({
        ...edit,
        toolCalls: [{ name: "sessions_spawn", arguments: { token: "private-value", count: 1 } }],
      });
      const [replaced] = await visibleReplies(params.account.baseUrl);
      assert(replaced, "The edited outbound message must remain visible");
      expect(replaced.toolCalls).toMatchObject([
        { name: "sessions_spawn", arguments: { count: 1 } },
      ]);
      expect(JSON.stringify(replaced.toolCalls)).not.toContain("private-value");
      await editQaBusMessage({ ...edit, text: "Ordinary edit" });
      expect((await visibleReplies(params.account.baseUrl))[0]?.toolCalls).toEqual(
        replaced.toolCalls,
      );
      await editQaBusMessage({ ...edit, text: "Cleared trace", toolCalls: [] });
      expect((await visibleReplies(params.account.baseUrl))[0]?.toolCalls).toBeUndefined();
    });
  });

  it.each([true, false])(
    "keeps exactly the admitted preview through a waiting final (adopted=%s)",
    async (accepted) => {
      await withQaBus(async (params) => {
        let receipt: ProgressContinuationReceipt | undefined;
        const adopt = vi.fn(async (candidate: ProgressContinuationReceipt) => {
          receipt = candidate;
          const visible = await visibleReplies(params.account.baseUrl);
          expect(visible).toMatchObject([{ id: candidate.messageId, text: candidate.text }]);
          return accepted;
        });
        await runQaInbound(async (turn) => {
          const dispatcher = createReplyDispatcher({ ...turn.dispatcherOptions, ...turn.delivery });
          await turn.replyOptions?.onPartialReply?.({ text: "Delegated review is running" });
          if (accepted) {
            await turn.replyOptions?.onToolStart?.({ name: "sessions_spawn", phase: "start" });
          }
          dispatcher.sendFinalReply(
            setReplyPayloadMetadata(
              { text: "Waiting for review" },
              {
                progressContinuation: { adopt, close: () => {} },
              },
            ),
          );
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
          await turn.replyOptions?.onPartialReply?.({ text: "late parent preview" });
        }, params);
        expect(adopt).toHaveBeenCalledOnce();
        expect(receipt).toMatchObject({
          channel: "qa-channel",
          accountId: "default",
          to: "dm:alice",
          text: "Delegated review is running",
        });
        expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
          {
            id: receipt?.messageId,
            text: accepted ? "Delegated review is running" : "Waiting for review",
          },
        ]);
        if (accepted) {
          await qaChannelMessageActions.handleAction!({
            channel: "qa-channel",
            action: "edit",
            cfg: params.config,
            accountId: "default",
            params: { to: "dm:alice", messageId: receipt?.messageId, message: "untrusted text" },
            progressSnapshot: {
              lines: [],
              statusHeadline: "Review complete",
              plan: [{ step: "Review", status: "completed" }],
            },
          });
          const [edited] = await visibleReplies(params.account.baseUrl);
          assert(edited, "The adopted progress message must remain visible");
          expect(edited).toMatchObject({ id: receipt?.messageId });
          expect(edited.text).toContain("Review complete");
          expect(edited.text).not.toContain("untrusted text");
          expect(edited.toolCalls).toEqual([{ name: "sessions_spawn" }]);
          await qaChannelMessageActions.handleAction!({
            channel: "qa-channel",
            action: "edit",
            cfg: params.config,
            accountId: "default",
            params: {
              to: "dm:alice",
              messageId: receipt?.messageId,
              message: "Ordinary edit",
              progressSnapshot: { lines: [], statusHeadline: "Forged progress" },
            },
          });
          expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
            {
              id: receipt?.messageId,
              text: "Ordinary edit",
              toolCalls: [{ name: "sessions_spawn" }],
            },
          ]);
        }
        const state = await getQaBusState(params.account.baseUrl);
        expect(state.events.filter((event) => event.kind === "outbound-message")).toHaveLength(1);
        expect(state.events.filter((event) => event.kind === "message-deleted")).toHaveLength(0);
      });
    },
  );

  it("waits for accepted adoption before error cleanup can delete the preview", async () => {
    await withQaBus(async (params) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      await runQaInbound(async (turn) => {
        const dispatcher = createReplyDispatcher({ ...turn.dispatcherOptions, ...turn.delivery });
        await turn.replyOptions?.onPartialReply?.({ text: "Child work is running" });
        dispatcher.sendFinalReply(
          setReplyPayloadMetadata(
            { text: "Waiting" },
            {
              progressContinuation: {
                adopt: async () => {
                  entered.resolve();
                  await release.promise;
                  return true;
                },
                close: () => {},
              },
            },
          ),
        );
        dispatcher.markComplete();
        await Promise.race([entered.promise, dispatcher.waitForIdle()]);
        turn.delivery.onError?.(new Error("parent retired"), { kind: "final" });
        await turn.replyOptions?.onPartialReply?.({ text: "late parent text" });
        release.resolve();
        await dispatcher.waitForIdle();
      }, params);
      expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
        { text: "Child work is running" },
      ]);
      const state = await getQaBusState(params.account.baseUrl);
      expect(state.events.filter((event) => event.kind === "message-deleted")).toHaveLength(0);
    });
  });

  it("never adopts a durable transcript message when no preview exists", async () => {
    await withQaBus(async (params) => {
      const adopt = vi.fn(async () => true);
      await runQaInbound(async (turn) => {
        const dispatcher = createReplyDispatcher({ ...turn.dispatcherOptions, ...turn.delivery });
        dispatcher.sendBlockReply({ text: "Earlier durable reply" });
        dispatcher.sendFinalReply(
          setReplyPayloadMetadata(
            { text: "Waiting" },
            {
              progressContinuation: { adopt, close: () => {} },
            },
          ),
        );
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
      }, params);
      expect(adopt).not.toHaveBeenCalled();
      expect((await visibleReplies(params.account.baseUrl)).map((message) => message.text)).toEqual(
        ["Earlier durable reply", "Waiting"],
      );
    });
  });

  it.each(["", SILENT_REPLY_TOKEN])(
    "removes the preview when dispatcher normalization suppresses final %j",
    async (text) => {
      await withQaBus(async (params) => {
        await runQaInbound(async (turn) => {
          const dispatcher = createReplyDispatcher({ ...turn.dispatcherOptions, ...turn.delivery });
          try {
            await turn.replyOptions?.onPartialReply?.({ text: "unfinished" });
            expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
              { text: "unfinished" },
            ]);
            expect(dispatcher.sendFinalReply({ text })).toBe(false);
            await turn.replyOptions?.onPartialReply?.({ text: "late partial" });
            expect(await visibleReplies(params.account.baseUrl)).toEqual([]);
          } finally {
            dispatcher.markComplete();
            await dispatcher.waitForIdle();
          }
        }, params);
        const state = await getQaBusState(params.account.baseUrl);
        expect(state.events.filter((event) => event.kind === "outbound-message")).toHaveLength(1);
        expect(state.events.filter((event) => event.kind === "message-deleted")).toHaveLength(1);
      });
    },
  );

  it("removes an unfinished preview before a zero-payload dispatch returns", async () => {
    await withQaBus(async (params) => {
      await runQaInbound(async (turn) => {
        await turn.replyOptions?.onPartialReply?.({ text: "unfinished" });
        expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
          { text: "unfinished" },
        ]);
      }, params);
      expect(await visibleReplies(params.account.baseUrl)).toEqual([]);
    });
  });

  it("keeps preview updates after an empty nonterminal block and preserves the final", async () => {
    await withQaBus(async (params) => {
      await runQaInbound(async (turn) => {
        const dispatcher = createReplyDispatcher({ ...turn.dispatcherOptions, ...turn.delivery });
        try {
          await turn.replyOptions?.onPartialReply?.({ text: "draft" });
          expect(dispatcher.sendBlockReply({ text: "" })).toBe(false);
          await turn.replyOptions?.onPartialReply?.({ text: "expanded draft" });
          expect(await visibleReplies(params.account.baseUrl)).toMatchObject([
            { text: "expanded draft" },
          ]);
          expect(dispatcher.sendFinalReply({ text: "answer" })).toBe(true);
        } finally {
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
        }
      }, params);
      expect(await visibleReplies(params.account.baseUrl)).toMatchObject([{ text: "answer" }]);
      const state = await getQaBusState(params.account.baseUrl);
      expect(state.events.filter((event) => event.kind === "outbound-message")).toHaveLength(1);
      expect(state.events.filter((event) => event.kind === "message-deleted")).toHaveLength(0);
    });
  });
});
