import { describe, expect, it } from "vitest";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyDispatchRuntimeInfo } from "../../auto-reply/reply/reply-dispatcher.types.js";
import { buildWaitingStatusPayload } from "../../auto-reply/reply/waiting-status.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { ReplyPayload } from "../../shared/reply-payload.types.js";
import { createFinalizableDraftLifecycle } from "../draft-stream-controls.js";
import type { ProgressContinuationReceipt } from "../progress-continuation.js";
import {
  createChannelProgressContinuation,
  deliverFinalizableLivePreview,
  type ChannelProgressContinuationOptions,
} from "./live.js";

function createHarness() {
  const visible = new Map<string, string>();
  const taskOwned = new Set<string>();
  let nextId = 0;
  const createDraft = () => {
    let messageId: string | undefined;
    let deliveredText = "";
    const state = { stopped: false, final: false };
    const stream = createFinalizableDraftLifecycle({
      throttleMs: 0,
      state,
      sendOrEditStreamMessage: async (text: string) => {
        messageId ??= `preview-${++nextId}`;
        deliveredText = text;
        visible.set(messageId, text);
      },
      readMessageId: () => messageId,
      clearMessageId: () => {
        messageId = undefined;
      },
      isValidMessageId: (id: unknown): id is string => typeof id === "string",
      deleteMessage: async (id: string) => {
        visible.delete(id);
      },
      warnPrefix: "preview cleanup",
    });
    return {
      stream,
      id: () => messageId,
      receipt: (): ProgressContinuationReceipt | undefined =>
        messageId && deliveredText
          ? {
              channel: "test",
              to: "room",
              messageId,
              text: deliveredText,
              snapshot: { lines: [deliveredText] },
            }
          : undefined,
      release(receipt: ProgressContinuationReceipt) {
        if (messageId === receipt.messageId) {
          messageId = undefined;
        }
      },
    };
  };
  let draft = createDraft();
  const drafts = [draft];
  let prepared = draft;
  const adapter: ChannelProgressContinuationOptions = {
    async prepareReceipt(assertCurrent) {
      prepared = draft;
      await prepared.stream.stop();
      assertCurrent();
      return prepared.receipt();
    },
    releaseReceipt(receipt) {
      prepared.release(receipt);
    },
    async discardPending() {
      await prepared.stream.discardPending();
    },
  };
  const continuation = createChannelProgressContinuation(adapter);
  return {
    visible,
    taskOwned,
    adapter,
    continuation,
    accept: async (receipt: ProgressContinuationReceipt) => {
      taskOwned.add(receipt.messageId);
      return true;
    },
    async publish(text: string) {
      draft.stream.update(text);
      await draft.stream.loop.flush();
    },
    beginTurn() {
      draft = createDraft();
      drafts.push(draft);
    },
    async freeze() {
      await draft.stream.seal();
    },
    async cleanup() {
      await continuation.settle();
      for (const generation of drafts) {
        await generation.stream.clear();
      }
    },
    async deliver(this: void, payload: ReplyPayload, info: ReplyDispatchRuntimeInfo) {
      if (await continuation.adopt(payload, info)) {
        return "adopted";
      }
      return (
        await deliverFinalizableLivePreview({
          kind: info.kind,
          payload,
          draft: { ...draft.stream, flush: draft.stream.loop.flush, id: draft.id },
          buildFinalEdit: () => undefined,
          editFinal: async () => {
            throw new Error("A waiting final must use ordinary delivery after a declined handoff");
          },
          deliverNormally: async (reply) => {
            visible.set(`final-${++nextId}`, reply.text ?? "");
          },
        })
      ).kind;
    },
  };
}

const waiting: ReplyPayload = { text: "Waiting for the remaining work" };

describe("createChannelProgressContinuation", () => {
  it("adopts a producer-built waiting final after dispatcher preparation without sending a second reply", async () => {
    const h = createHarness();
    await h.publish("Checking child results");
    const payload = buildWaitingStatusPayload({
      completion: { expectation: "required", outcome: "pending" },
      yielded: true,
      hasVisibleMessageDelivery: false,
    });
    if (!payload) {
      throw new Error("A pending required reply must produce a waiting status");
    }
    let capabilityOpen = true;
    const progressContinuation = {
      adopt: async (receipt: ProgressContinuationReceipt) => capabilityOpen && h.accept(receipt),
      close() {
        capabilityOpen = false;
      },
    };
    setReplyPayloadMetadata(payload, { progressContinuation });
    const dispatcher = createReplyDispatcher({
      async beforeDeliver(current) {
        await h.freeze();
        // Real preparation may clone a payload after freezing its draft.
        return { ...current };
      },
      deliver: h.deliver,
    });
    dispatcher.sendFinalReply(payload);
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();
    progressContinuation.close();
    await h.cleanup();

    expect(receipt).toMatchObject({
      anyVisibleDelivered: true,
      counts: { final: { delivered: 1 } },
    });
    expect([...h.visible]).toEqual([["preview-1", "Checking child results"]]);
    expect([...h.taskOwned]).toEqual(["preview-1"]);
  });

  it.each([true, false])(
    "transfers cleanup ownership only after positive acceptance (%s)",
    async (accepted) => {
      const h = createHarness();
      await h.publish("Checking the remaining work");
      const result = await h.deliver(waiting, {
        kind: "final",
        adoptProgressContinuation: accepted ? h.accept : async () => false,
      });
      await h.publish("Late parent update");
      await h.cleanup();

      expect(result).toBe(accepted ? "adopted" : "normal-delivered");
      expect([...h.visible]).toEqual(
        accepted ? [["preview-1", "Checking the remaining work"]] : [["final-2", waiting.text]],
      );
      expect([...h.taskOwned]).toEqual(accepted ? ["preview-1"] : []);
    },
  );

  it("keeps ordinary delivery when the transport cannot confirm a receipt", async () => {
    const h = createHarness();
    await h.publish("Previously confirmed progress");
    const prepareReceipt = h.adapter.prepareReceipt;
    h.adapter.prepareReceipt = async (assertCurrent) => {
      await prepareReceipt(assertCurrent);
      // A successful void update/flush is not positive platform evidence.
      return undefined;
    };

    expect(await h.deliver(waiting, { kind: "final", adoptProgressContinuation: h.accept })).toBe(
      "normal-delivered",
    );
    await h.cleanup();
    expect([...h.visible]).toEqual([["final-2", waiting.text]]);
    expect([...h.taskOwned]).toEqual([]);
  });

  it("does not replace unsupported, empty, supplemental, or control replies with a progress card", async () => {
    const cases: Array<{ payload: ReplyPayload; info?: Partial<ReplyDispatchRuntimeInfo> }> = [
      { payload: waiting, info: { adoptProgressContinuation: undefined } },
      { payload: waiting, info: { kind: "block" } },
      { payload: { text: " " } },
      { payload: { ...waiting, mediaUrls: [], mediaUrl: "https://example.test/result.png" } },
      { payload: { ...waiting, channelData: { askUser: { questionId: "question" } } } },
      { payload: { ...waiting, delivery: { pin: true } } },
      { payload: { ...waiting, isError: true } },
      { payload: { ...waiting, isCommentary: true } },
      { payload: { ...waiting, isReasoning: true } },
      { payload: { ...waiting, isStatusNotice: true } },
    ];
    for (const { payload, info } of cases) {
      const h = createHarness();
      await h.publish("Unrelated progress");
      expect(
        await h.deliver(payload, {
          kind: "final",
          adoptProgressContinuation: h.accept,
          ...info,
        }),
      ).toBe("normal-delivered");
      await h.cleanup();
      expect([...h.visible]).toEqual([["final-2", payload.text]]);
      expect([...h.taskOwned]).toEqual([]);
    }
  });

  it.each(["adapter", "delivery"] as const)(
    "rechecks %s authority after preparation and lets cancellation cleanup join it",
    async (authority) => {
      const h = createHarness();
      await h.publish("Preparing progress");
      const preparing = createDeferredCore();
      const finishPreparing = createDeferredCore();
      const prepareReceipt = h.adapter.prepareReceipt;
      h.adapter.prepareReceipt = async (assertCurrent) => {
        const receipt = await prepareReceipt(assertCurrent);
        preparing.resolve();
        await finishPreparing.promise;
        return receipt;
      };
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Progress authority closed");
        }
      };
      if (authority === "adapter") {
        h.adapter.assertCurrent = assertCurrent;
      }
      const adopting = h.continuation.adopt(waiting, {
        kind: "final",
        adoptProgressContinuation: h.accept,
        ...(authority === "delivery" ? { assertPlatformSendAuthorized: assertCurrent } : {}),
      });
      const rejected = expect(adopting).rejects.toThrow("Progress authority closed");
      await preparing.promise;
      const cleanup = h.cleanup();
      current = false;
      expect([...h.visible]).toEqual([["preview-1", "Preparing progress"]]);
      finishPreparing.resolve();
      await rejected;
      await cleanup;
      expect([...h.visible]).toEqual([]);
      expect([...h.taskOwned]).toEqual([]);
    },
  );

  it("releases accepted ownership even if authority closes, before waiting for transport retirement", async () => {
    const h = createHarness();
    await h.publish("Transferred progress");
    let current = true;
    h.adapter.assertCurrent = () => {
      if (!current) {
        throw new Error("Progress authority closed");
      }
    };
    const discarding = createDeferredCore();
    const finishDiscarding = createDeferredCore();
    const discardPending = h.adapter.discardPending;
    h.adapter.discardPending = async () => {
      discarding.resolve();
      await finishDiscarding.promise;
      await discardPending();
    };
    const adopting = h.continuation.adopt(waiting, {
      kind: "final",
      adoptProgressContinuation: async (receipt) => {
        await h.accept(receipt);
        current = false;
        return true;
      },
    });
    await discarding.promise;
    let cleaned = false;
    const cleanup = h.cleanup().then(() => {
      cleaned = true;
    });
    await Promise.resolve();
    expect(cleaned).toBe(false);
    expect([...h.taskOwned]).toEqual(["preview-1"]);
    finishDiscarding.resolve();
    expect(await adopting).toBe(true);
    await cleanup;
    expect([...h.visible]).toEqual([["preview-1", "Transferred progress"]]);
  });

  it("serializes generation handoffs and joins an adoption queued during settlement", async () => {
    const h = createHarness();
    await h.publish("First turn");
    const accepting = createDeferredCore();
    const finishAccepting = createDeferredCore();
    const first = h.continuation.adopt(waiting, {
      kind: "final",
      adoptProgressContinuation: async (receipt) => {
        accepting.resolve();
        await finishAccepting.promise;
        return h.accept(receipt);
      },
    });
    await accepting.promise;
    let settled = false;
    const settling = h.continuation.settle().then(() => {
      settled = true;
    });
    h.beginTurn();
    await h.publish("Second turn");
    const acceptingSecond = createDeferredCore();
    const finishAcceptingSecond = createDeferredCore();
    const second = h.continuation.adopt(waiting, {
      kind: "final",
      adoptProgressContinuation: async (receipt) => {
        acceptingSecond.resolve();
        await finishAcceptingSecond.promise;
        return h.accept(receipt);
      },
    });
    finishAccepting.resolve();
    expect(await first).toBe(true);
    await acceptingSecond.promise;
    expect(settled).toBe(false);
    finishAcceptingSecond.resolve();
    expect(await second).toBe(true);
    await settling;
    await h.cleanup();
    expect([...h.visible]).toEqual([
      ["preview-1", "First turn"],
      ["preview-2", "Second turn"],
    ]);
    expect([...h.taskOwned]).toEqual(["preview-1", "preview-2"]);
  });

  it("does not return an accepted receipt to cleanup when discard fails, and can adopt the next turn", async () => {
    const h = createHarness();
    await h.publish("Transferred progress");
    const discardPending = h.adapter.discardPending;
    h.adapter.discardPending = async () => {
      await discardPending();
      throw new Error("Transport retirement failed");
    };
    await expect(
      h.continuation.adopt(waiting, { kind: "final", adoptProgressContinuation: h.accept }),
    ).rejects.toThrow("Transport retirement failed");
    await h.cleanup();
    expect([...h.visible]).toEqual([["preview-1", "Transferred progress"]]);

    h.adapter.discardPending = discardPending;
    h.beginTurn();
    await h.publish("Next turn");
    expect(await h.deliver(waiting, { kind: "final", adoptProgressContinuation: h.accept })).toBe(
      "adopted",
    );
    await h.cleanup();
    expect([...h.visible]).toEqual([
      ["preview-1", "Transferred progress"],
      ["preview-2", "Next turn"],
    ]);
  });
});
