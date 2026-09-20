import { expect, it } from "vitest";
import { resolveAdmittedRunActiveAssertion } from "../../agents/admitted-run-context.js";
import { buildExecAutoReviewTranscript } from "../../agents/exec-auto-review-transcript.js";
import { castAgentMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import {
  captureCommandOwnerAssertion,
  getCommandOwnerAuthority,
} from "../../auto-reply/command-owner-authority.js";
import { prepareChannelRunAdmission } from "../../auto-reply/reply/channel-run-admission.js";
import { installDiscordRegistryHooks } from "../../auto-reply/test-helpers/command-auth-registry-fixture.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profiles.js";
import { withAdminIngress } from "./operator-authority.test-support.js";

installDiscordRegistryHooks();

it("recognizes every linked Team admin through host ingress and gives Guardian operator provenance", async () => {
  await withAdminIngress(async ({ cfg, admins, context }) => {
    for (const { identity } of admins) {
      const ctx = await context(identity.senderId);
      const auth = resolveCommandAuthorization({ cfg, ctx: { ...ctx }, commandAuthorized: true });
      expect(auth).toMatchObject({ senderIsOwner: true, isAuthorizedSender: true });
      const transcript = buildExecAutoReviewTranscript({
        messages: [
          castAgentMessage({
            role: "user",
            content: "Assign this session to the requester",
            timestamp: 0,
            __openclaw: {
              senderIsOwner: auth.senderIsOwner,
              senderIdentity: {
                type: "observation",
                pluginId: "discord",
                accountId: "team",
                senderKind: "human",
                id: identity.senderId,
              },
            },
          }),
        ],
      });
      expect(transcript.entries[0]?.origin).toBe("operator");
    }
    const ordinary = await context("ordinary-member");
    expect(
      resolveCommandAuthorization({ cfg, ctx: ordinary, commandAuthorized: true }),
    ).toMatchObject({ senderIsOwner: false, isAuthorizedSender: true });
    const adminContext = await context("100");
    const authority = getCommandOwnerAuthority(adminContext);
    const constructor: unknown = authority && Reflect.get(authority, "constructor");
    const forgedAuthority =
      typeof constructor === "function"
        ? Reflect.construct(constructor, [{ isCurrent: () => true }])
        : { isCurrent: () => true };
    for (const ctx of [
      await context("100", false),
      await context("100", true, "different-bot"),
      structuredClone(adminContext),
      {
        Provider: "discord",
        AccountId: "team",
        SenderId: "100",
        GatewayClientScopes: ["operator.admin"],
      },
      {
        ...adminContext,
        ...Object.fromEntries(
          Object.getOwnPropertySymbols(adminContext).map((key) => [key, { isCurrent: () => true }]),
        ),
      },
      {
        ...adminContext,
        ...Object.fromEntries(
          Object.getOwnPropertySymbols(adminContext).map((key) => [key, forgedAuthority]),
        ),
      },
    ]) {
      expect(resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true }).senderIsOwner).toBe(
        false,
      );
    }
  });
});

it.each(["role", "grant", "link", "reassign", "host"] as const)(
  "revokes admitted channel owner authority when its %s changes",
  async (change) => {
    await withAdminIngress(async ({ cfg, admins, context, retire }) => {
      const admin = admins[0]!;
      const ctx = await context(admin.identity.senderId);
      expect(resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true }).senderIsOwner).toBe(
        true,
      );
      const prepared = prepareChannelRunAdmission({
        cfg,
        runId: `linked-admin-${change}`,
        agentId: "main",
        ingressKind: "channel",
        boundary: "test.channel",
        assertSourceCurrent: captureCommandOwnerAssertion(ctx),
      });
      const admitted = await prepared.admit("embedded");
      const assertCurrent = resolveAdmittedRunActiveAssertion(admitted);
      expect(assertCurrent).toBeTypeOf("function");
      expect(() => assertCurrent?.()).not.toThrow();
      if (change === "role") {
        setUserProfileRole(admin.profile.id, "member");
      }
      if (change === "grant") {
        delete cfg.gateway!.auth!.identityScopes!["ada@example.test"];
      }
      if (change === "link") {
        unlinkUserChannelIdentity(admin.profile.id, admin.identity);
      }
      if (change === "reassign") {
        unlinkUserChannelIdentity(admin.profile.id, admin.identity);
        linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
      }
      if (change === "host") {
        retire();
      }
      expect(resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true }).senderIsOwner).toBe(
        false,
      );
      expect(() => assertCurrent?.()).toThrow();
      prepared.close();
    });
  },
);
