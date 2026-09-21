// Telegram plugin module implements bot message context.sender prefix support behavior.
import { describe, expect, it } from "vitest";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { isTelegramForumServiceMessage } from "./forum-service-message.js";

describe("isTelegramForumServiceMessage", () => {
  it("returns false for normal messages and non-objects", () => {
    expect(isTelegramForumServiceMessage({ text: "hello" })).toBe(false);
    expect(isTelegramForumServiceMessage(null)).toBe(false);
    expect(isTelegramForumServiceMessage("topic created")).toBe(false);
  });
});

describe("buildTelegramMessageContext sender prefix", () => {
  async function buildCtx(params: { messageId: number }) {
    return await buildTelegramMessageContextForTest({
      message: {
        message_id: params.messageId,
        chat: { id: -99, type: "supergroup", title: "Dev Chat" },
        date: 1700000000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
    });
  }

  it("prefixes group bodies with sender label", async () => {
    const ctx = await buildCtx({ messageId: 1 });

    expect(ctx).not.toBeNull();
    const body = ctx?.ctxPayload?.Body ?? "";
    expect(body).toContain("Alice (42): hello");
  });
});
