// Session key tests cover session key generation and normalization.
import { describe, expect, it } from "vitest";
import { resolveSessionKey } from "./session-key.js";
import { installDiscordSessionKeyNormalizerFixture, makeCtx } from "./session-key.test-helpers.js";

installDiscordSessionKeyNormalizerFixture();

describe("resolveSessionKey", () => {
  it("resolves bare main while keeping qualified identities stable across configuration changes", () => {
    expect(resolveSessionKey("global", makeCtx({ SessionKey: "main" }), "work", "ops")).toBe(
      "agent:ops:global",
    );
    for (const sessionKey of ["agent:ops:main", "agent:main:main", "agent:ops:work"]) {
      expect(resolveSessionKey("global", makeCtx({ SessionKey: sessionKey }), "other", "ops")).toBe(
        sessionKey,
      );
      expect(
        resolveSessionKey("per-sender", makeCtx({ SessionKey: sessionKey }), "work", "ops"),
      ).toBe(sessionKey);
    }
  });

  it.each(["global", "unknown"])(
    "preserves reserved %s identity when mainKey has the same name",
    (mainKey) => {
      for (const scope of ["global", "per-sender"] as const) {
        for (const sessionKey of [mainKey, `agent:ops:${mainKey}`]) {
          expect(
            resolveSessionKey(scope, makeCtx({ SessionKey: sessionKey }), mainKey, "ops"),
          ).toBe(`agent:ops:${mainKey}`);
        }
        expect(resolveSessionKey(scope, makeCtx({ SessionKey: "main" }), mainKey, "ops")).toBe(
          `agent:ops:${scope === "global" ? "global" : mainKey}`,
        );
      }
    },
  );

  it.each(["ops", "research"])("qualifies global scope for %s before routing", (agentId) => {
    expect(resolveSessionKey("global", makeCtx({}), "main", agentId)).toBe(
      `agent:${agentId}:global`,
    );
    expect(resolveSessionKey("global", makeCtx({ SessionKey: "global" }), "main", agentId)).toBe(
      `agent:${agentId}:global`,
    );
    expect(
      resolveSessionKey("per-sender", makeCtx({ SessionKey: "unknown" }), "main", agentId),
    ).toBe(`agent:${agentId}:unknown`);
  });

  it("uses an explicit agent id for canonical direct-chat keys", () => {
    const ctx = makeCtx({
      From: "+15551234567",
    });

    expect(resolveSessionKey("per-sender", ctx, "main", "ops")).toBe("agent:ops:main");
  });

  it("uses an explicit agent id for group keys", () => {
    const ctx = makeCtx({
      From: "C123",
      ChatType: "channel",
      Provider: "slack",
    });

    expect(resolveSessionKey("per-sender", ctx, "main", "ops")).toBe(
      "agent:ops:slack:channel:c123",
    );
  });

  describe("Discord DM session key normalization", () => {
    it.each([
      {
        title: "passes through correct discord:direct keys unchanged",
        sessionKey: "agent:fina:discord:direct:123456",
        chatType: "direct",
        normalizedKey: "discord:123456",
        senderId: "123456",
        expected: "agent:fina:discord:direct:123456",
      },
      {
        title: "migrates legacy discord:dm: keys to discord:direct:",
        sessionKey: "agent:fina:discord:dm:123456",
        chatType: "direct",
        normalizedKey: "discord:123456",
        senderId: "123456",
        expected: "agent:fina:discord:direct:123456",
      },
      {
        title: "fixes phantom discord:channel:USERID keys when sender matches",
        sessionKey: "agent:fina:discord:channel:123456",
        chatType: "direct",
        normalizedKey: "discord:123456",
        senderId: "123456",
        expected: "agent:fina:discord:direct:123456",
      },
      {
        title: "does not rewrite discord:channel: keys for non-direct chats",
        sessionKey: "agent:fina:discord:channel:123456",
        chatType: "channel",
        normalizedKey: "discord:channel:123456",
        senderId: "789",
        expected: "agent:fina:discord:channel:123456",
      },
      {
        title: "does not rewrite discord:channel: keys when sender does not match",
        sessionKey: "agent:fina:discord:channel:123456",
        chatType: "direct",
        normalizedKey: "discord:789",
        senderId: "789",
        expected: "agent:fina:discord:channel:123456",
      },
      {
        title: "handles keys without an agent prefix",
        sessionKey: "discord:channel:123456",
        chatType: "direct",
        normalizedKey: "discord:123456",
        senderId: "123456",
        expected: "agent:fina:discord:direct:123456",
      },
    ])("$title", ({ sessionKey, chatType, normalizedKey, senderId, expected }) => {
      const ctx = makeCtx({
        SessionKey: sessionKey,
        ChatType: chatType,
        From: normalizedKey,
        SenderId: senderId,
      });
      expect(resolveSessionKey("per-sender", ctx, "main", "fina")).toBe(expected);
    });
  });
});
