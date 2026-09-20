import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  createHostChannelInboundEventContextBuilder,
  createHostChannelIngressRuntime,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import * as imessageRuntime from "../runtime.js";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";

describe("buildIMessageInboundContext direct reply route", () => {
  it.each([undefined, 42])(
    "retains host owner authority after reply ID mapping (chat ID %s)",
    async (chatId) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg: OpenClawConfig = {
          session: { store: state.path("sessions.json") },
          commands: { ownerAllowFrom: ["imessage:+15555550123"] },
        };
        type GatewayContext = NonNullable<
          ReturnType<
            NonNullable<
              Parameters<typeof createHostChannelIngressRuntime>[0]["resolveGatewayContext"]
            >
          >
        >;
        // SAFETY: Host ingress only reads current config from this synthetic Gateway.
        const gateway = { getRuntimeConfig: () => cfg } as GatewayContext;
        let live = true;
        const owner = {
          channelId: "imessage",
          isLive: () => live,
          resolveGatewayContext: () => gateway,
        };
        const runtime = createPluginRuntimeMock();
        runtime.channel.inbound.ingress = createHostChannelIngressRuntime(owner);
        const runtimeSpy = vi.spyOn(imessageRuntime, "getIMessageRuntime").mockReturnValue(runtime);
        try {
          const message = {
            id: 12349,
            guid: "p:0/GUID-current-guid-only",
            sender: "+15555550123",
            text: "current",
            is_from_me: false,
            is_group: false,
            chat_guid: "iMessage;-;+15555550123",
            chat_id: chatId,
          };
          const decision = await resolveIMessageInboundDecision({
            cfg,
            accountId: "default",
            opts: undefined,
            allowFrom: ["*"],
            groupAllowFrom: [],
            groupPolicy: "open",
            dmPolicy: "open",
            storeAllowFrom: [],
            historyLimit: 0,
            groupHistories: new Map(),
            echoCache: undefined,
            selfChatCache: undefined,
            isKnownFromMeMessageId: () => false,
            logVerbose: undefined,
            message,
            messageText: message.text,
            bodyText: message.text,
          });
          expect(decision.kind).toBe("dispatch");
          if (decision.kind !== "dispatch") {
            return;
          }

          const { ctxPayload, imessageTo } = await buildIMessageInboundContext({
            cfg,
            accountService: undefined,
            decision,
            message,
            historyLimit: 0,
            groupHistories: new Map(),
            buildContext: createHostChannelInboundEventContextBuilder(
              buildChannelInboundEventContext,
              owner,
            ),
          });

          expect(ctxPayload.To).toBe(
            chatId == null ? "chat_guid:iMessage;-;+15555550123" : "chat_id:42",
          );
          expect(imessageTo).toBe("imessage:+15555550123");
          expect(ctxPayload.MessageSid).toMatch(/^\d+$/u);
          expect(ctxPayload.MessageSid).not.toBe(String(message.id));
          const authorization = resolveCommandAuthorization({
            ctx: ctxPayload,
            cfg: {},
            commandAuthorized: true,
          });
          expect(authorization.senderIsOwner).toBe(true);
          expect(authorization.assertOwnerCurrent).toBeTypeOf("function");
          expect(() => authorization.assertOwnerCurrent?.()).not.toThrow();
          cfg.commands = { ownerAllowFrom: [] };
          expect(() => authorization.assertOwnerCurrent?.()).toThrow("authority changed");
        } finally {
          live = false;
          runtimeSpy.mockRestore();
        }
      });
    },
  );
});
