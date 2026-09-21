// Telegram tests cover bot message contextm topic threadid plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

vi.mock("./bot-message-context.body.js", () => ({
  resolveTelegramInboundBody: async () => ({
    bodyText: "hello",
    rawBody: "hello",
    historyKey: undefined,
    commandAuthorized: false,
    effectiveWasMentioned: true,
    inboundEventKind: "user_request",
    mentionFacts: {
      canDetectMention: false,
      wasMentioned: true,
      effectiveWasMentioned: true,
      requireMention: false,
    },
    canDetectMention: false,
    shouldBypassMention: false,
    hasControlCommand: false,
    stickerCacheHit: false,
    locationData: undefined,
  }),
}));

describe("buildTelegramMessageContext DM topic threadId in deliveryContext (#8891)", () => {
  async function buildCtx(params: {
    message: Record<string, unknown>;
    options?: Record<string, unknown>;
    resolveGroupActivation?: () => boolean | undefined;
  }) {
    return await buildTelegramMessageContextForTest({
      message: params.message,
      options: params.options,
      resolveGroupActivation: params.resolveGroupActivation,
    });
  }

  it("passes threadId to updateLastRoute for DM topics", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        message_thread_id: 42, // DM Topic ID
      },
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram DM topic context payload");
    }
    expect(ctx.turn.record.updateLastRoute?.to).toBe("telegram:1234");
    expect(ctx.turn.record.updateLastRoute?.threadId).toBe("42");
  });

  it("preserves the reply body and bot sender identity in Telegram payloads", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        text: "hello",
        reply_to_message: {
          message_id: 9,
          date: 1_700_000_001,
          text: "parent",
          from: { id: 99, first_name: "Bob" },
        },
        from: { id: 42, first_name: "Alice", username: "alice_bot", is_bot: true },
      },
    });

    expect(ctx?.ctxPayload.ReplyToBody).toBe("parent");
    expect(ctx?.ctxPayload.SenderIsBot).toBe(true);
  });

  it("preserves voice-note source modality without treating ordinary audio as voice", async () => {
    const voiceCtx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        voice: { file_id: "voice-1" },
      },
    });
    const audioCtx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
        audio: { file_id: "audio-1" },
      },
    });

    expect(voiceCtx?.ctxPayload.SourceModality).toBe("voice");
    expect(audioCtx?.ctxPayload.SourceModality).toBeUndefined();
  });

  it("does not pass threadId for regular DM without topic", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: 1234, type: "private" },
      },
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram DM context payload");
    }
    expect(ctx.ctxPayload.SessionKey).toBe("agent:main:main");
    expect(ctx.ctxPayload.MessageThreadId).toBeUndefined();
    expect(ctx.turn.record.updateLastRoute?.to).toBe("telegram:1234");
    expect(ctx.turn.record.updateLastRoute?.threadId).toBeUndefined();
  });

  it("passes threadId to updateLastRoute for forum topic group messages", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group", is_forum: true },
        text: "@bot hello",
        message_thread_id: 99,
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram forum topic context payload");
    }
    expect(ctx.turn.record.updateLastRoute?.to).toBe("telegram:-1001234567890:topic:99");
    expect(ctx.turn.record.updateLastRoute?.threadId).toBe("99");
  });

  it("keeps the forum General topic target aligned with live routing", async () => {
    const ctx = await buildCtx({
      message: {
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group", is_forum: true },
        text: "@bot hello",
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

    if (!ctx?.ctxPayload) {
      throw new Error("expected Telegram General topic context payload");
    }
    expect(ctx.turn.record.updateLastRoute?.to).toBe("telegram:-1001234567890");
    expect(ctx.turn.record.updateLastRoute?.threadId).toBe("1");
  });
});
