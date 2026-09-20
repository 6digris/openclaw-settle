import type { ChannelInboundTurnPlan } from "openclaw/plugin-sdk/channel-inbound";
import type { ProgressContinuationReceipt } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { expect, vi, type Mock } from "vitest";

/** Mock for the SDK's reply stream, including acknowledged typing chunks. */
export type StreamMock = {
  update: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  clearText: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn<() => Promise<{ id: string } | undefined>>>;
  canceled: boolean;
  events: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
  acknowledge: (text: string) => void;
};

export function createStreamMock(): StreamMock {
  let chunkHandler:
    | ((activity: {
        id: string;
        type: string;
        text: string;
        channelData: { streamType: string };
      }) => void)
    | undefined;
  return {
    update: vi.fn(),
    emit: vi.fn(),
    clearText: vi.fn(),
    close: vi.fn(async () => ({ id: "stream-final" })),
    canceled: false,
    events: {
      on: vi.fn((_event: "chunk", handler: typeof chunkHandler) => {
        chunkHandler = handler;
        return 0;
      }),
      off: vi.fn(() => {
        chunkHandler = undefined;
      }),
    },
    acknowledge: (text: string) => {
      chunkHandler?.({
        id: "stream-acknowledged",
        type: "typing",
        text,
        channelData: { streamType: "streaming" },
      });
    },
  };
}

type TeamsProgressFixture = Pick<ChannelInboundTurnPlan, "delivery"> & {
  replyOptions: NonNullable<ChannelInboundTurnPlan["replyOptions"]>;
  dispatcherOptions: { onSettled: () => Promise<void> };
};

export async function assertProgressHandoffSettlement(
  teams: TeamsProgressFixture,
  stream: StreamMock,
  sendMSTeamsMessagesMock: Mock,
) {
  const closeStarted = createDeferred<void>();
  const releaseClose = createDeferred<void>();
  const adoptionStarted = createDeferred<ProgressContinuationReceipt>();
  const releaseAdoption = createDeferred<boolean>();
  stream.close.mockImplementation(async () => {
    closeStarted.resolve();
    await releaseClose.promise;
    return { id: "retained-stream" };
  });
  await teams.replyOptions.onPlanUpdate?.({
    phase: "update",
    steps: [{ step: "Inspect", status: "in_progress" }],
  });
  const delivered = teams.delivery.deliver(
    { text: "Waiting for child completion" },
    {
      kind: "final",
      adoptProgressContinuation: async (receipt) => {
        adoptionStarted.resolve(receipt);
        return await releaseAdoption.promise;
      },
    },
  );
  let settled = false;
  const teardown = teams.dispatcherOptions.onSettled().then(() => {
    settled = true;
  });
  try {
    await closeStarted.promise;
    expect(settled).toBe(false);
    releaseClose.resolve();
    const receipt = await adoptionStarted.promise;
    expect(receipt).toMatchObject({
      channel: "msteams",
      to: "conversation:conv",
      messageId: "retained-stream",
      text: "Working\n\n▸ Inspect",
      snapshot: { plan: [{ step: "Inspect", status: "in_progress" }] },
    });
    expect(settled).toBe(false);
    releaseAdoption.resolve(true);
    await delivered;
    await teardown;
    expect(sendMSTeamsMessagesMock).not.toHaveBeenCalled();
    expect(stream.close).toHaveBeenCalledOnce();
    await teams.replyOptions.onPartialReply?.({ text: "late text" });
    expect(stream.emit).not.toHaveBeenCalledWith("late text");
  } finally {
    releaseClose.resolve();
    releaseAdoption.resolve(false);
    await delivered;
    await teardown;
  }
}

export async function assertProgressFinalSettlement(teams: TeamsProgressFixture) {
  const deliveries: Promise<unknown>[] = [];
  const events: string[] = [];
  const producer = createReplyDispatcher({
    deliver: async (payload, info) => {
      events.push(`deliver:${payload.text}`);
      const result = await teams.delivery.deliver(payload, info);
      deliveries.push(Promise.resolve(result?.finalization ?? result));
      return result;
    },
    onIdle: async () => {
      events.push("settle");
      await teams.dispatcherOptions.onSettled?.();
    },
  });
  producer.sendFinalReply({ text: "First distinct result." });
  producer.sendFinalReply({ text: "# Second distinct result" });
  producer.markComplete();
  await producer.waitForIdle();
  const results = await Promise.all(deliveries);
  expect(events).toEqual([
    "deliver:First distinct result.",
    "deliver:# Second distinct result",
    "settle",
  ]);
  for (const text of ["First distinct result.", "Second distinct result"]) {
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          visibleReplySent: true,
          content: expect.stringContaining(text),
        }),
      ]),
    );
  }
}
