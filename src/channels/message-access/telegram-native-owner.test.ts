import { beforeAll, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "../../commands/models/auth.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { registerPluginCommand } from "../../plugins/commands.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import type { PluginCommandContext } from "../../plugins/types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../../state/user-channel-identities.js";
import { ensureProfileForEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  buildChannelInboundEventContext,
  type BuildChannelInboundEventContextAsyncParams,
  type BuildChannelInboundEventContextParams,
  type BuiltChannelInboundEventContext,
} from "../inbound-event/context.js";
import { createHostChannelInboundEventContextBuilder } from "../inbound-event/host-context-builder.js";
import type { ChannelPlugin } from "../plugins/types.public.js";
import { createCommandOwnerTestGateway } from "./operator-authority.test-support.js";
import { createHostChannelIngressRuntime } from "./runtime.js";

type TelegramNativeCommandTestDriver = {
  invoke: (input?: {
    command?: string;
    senderId?: number;
    chatId?: number;
    group?: boolean;
    threadId?: number;
    match?: string;
  }) => Promise<void>;
  pairingStoreReadCount: () => number;
  deliveries: () => Array<{ replies: ReplyPayload[] }>;
  sentMessages: () => Array<{ chatId: number | string; text: string }>;
  configureLogin: (input: {
    run: (options: ModelsAuthLoginFlowOptions) => Promise<ModelsAuthLoginFlowResult>;
    onResult: () => void;
  }) => void;
  close: () => void;
};
const { createTelegramNativeCommandTestDriver } = await loadBundledPluginFacade<{
  createTelegramNativeCommandTestDriver: (options: {
    cfg: OpenClawConfig;
    runtime: PluginRuntime;
  }) => TelegramNativeCommandTestDriver;
}>({
  pluginId: "telegram",
  artifactBasename: "native-command-test-api.js",
});
let telegramPlugin: ChannelPlugin;

beforeAll(async () => {
  ({ telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
    pluginId: "telegram",
    artifactBasename: "api.js",
  }));
});

async function withTelegramNativeOwners(
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  asserted = false,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const previous = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
      null,
      "default",
    );
    const fixture = createFixture(asserted);
    try {
      await run(fixture);
    } finally {
      fixture.close();
      rollbackStagedPluginRegistry(previous);
    }
  });
}

function createFixture(asserted: boolean) {
  const cfg: OpenClawConfig = {
    commands: { ownerAllowFrom: ["telegram:999999"] },
    channels: { telegram: { dmPolicy: "pairing", allowFrom: [] } },
    gateway: {
      roles: {
        default: "member",
        definitions: {
          admin: { scopes: ["operator.admin"], agents: "*", sessions: { others: "write" } },
          member: {
            scopes: ["operator.read", "operator.write"],
            agents: "*",
            sessions: { others: "view" },
          },
        },
      },
    },
  };
  const admins = [100, 200].map((senderId) => {
    const profile = ensureProfileForEmail(`admin-${senderId}@example.test`);
    setUserProfileRole(profile.id, "admin");
    const identity = { channelId: "telegram", accountId: "default", senderId: String(senderId) };
    linkUserChannelIdentity(profile.id, identity);
    return { profile, identity };
  });
  let live = true;
  const gateway = createCommandOwnerTestGateway(cfg);
  const host = { channelId: "telegram", isLive: () => live, resolveGatewayContext: () => gateway };
  const ingress = createHostChannelIngressRuntime(host);
  const handler = vi.fn(async (ctx: PluginCommandContext) => {
    ctx.assertOwnerCurrent?.();
    return { text: "TELEGRAM-OWNER-OK" };
  });
  expect(
    registerPluginCommand("owner-probe", {
      name: "qaowner",
      description: "Owner authority probe",
      requiredScopes: ["operator.admin"],
      handler,
    }),
  ).toEqual({ ok: true });
  const buildHostContext = createHostChannelInboundEventContextBuilder(
    buildChannelInboundEventContext,
    host,
  );
  function buildContext(
    input: BuildChannelInboundEventContextAsyncParams,
  ): Promise<BuiltChannelInboundEventContext>;
  function buildContext(
    input: BuildChannelInboundEventContextParams,
  ): BuiltChannelInboundEventContext;
  function buildContext(input: BuildChannelInboundEventContextParams) {
    return buildHostContext(input);
  }
  const runtime = createPluginRuntimeMock({
    channel: {
      inbound: {
        ingress: asserted
          ? {
              ...ingress,
              createResolver: (base) => {
                const resolver = ingress.createResolver(base);
                return {
                  ...resolver,
                  event: (input) =>
                    resolver.event({
                      ...input,
                      subject: {
                        ...input.subject,
                        authentication: { "telegram-user-id": "asserted" },
                      },
                    }),
                };
              },
            }
          : ingress,
        buildContext,
      },
    },
  });
  const driver = createTelegramNativeCommandTestDriver({ cfg, runtime });
  return {
    cfg,
    admins,
    handler,
    driver,
    invoke: (senderId = 100) => driver.invoke({ senderId }),
    invokeTopic: () => driver.invoke({ group: true, chatId: -10012345, threadId: 42 }),
    close: () => {
      live = false;
      driver.close();
    },
  };
}

it("delivers current linked Team-admin ownership through registered Telegram plugin commands", async () => {
  await withTelegramNativeOwners(async ({ invoke, handler, driver }) => {
    await invoke(100);
    await invoke(200);
    expect(handler).toHaveBeenCalledTimes(2);
    for (const [ctx] of handler.mock.calls) {
      expect(ctx).toMatchObject({
        senderIsOwner: true,
        isAuthorizedSender: true,
        channel: "telegram",
        accountId: "default",
        assertOwnerCurrent: expect.any(Function),
      });
    }
    expect(driver.pairingStoreReadCount()).toBe(0);
    expect(driver.deliveries()).toHaveLength(2);
  });
});

it.each([
  { name: "enabled", groupPolicy: "open", topicPolicy: undefined, allowed: true },
  { name: "group disabled", groupPolicy: "disabled", topicPolicy: undefined, allowed: false },
  { name: "topic disabled", groupPolicy: "open", topicPolicy: "disabled", allowed: false },
  {
    name: "topic overrides disabled group",
    groupPolicy: "disabled",
    topicPolicy: "open",
    allowed: true,
  },
] as const)(
  "preserves real topic routing and room admission for linked native owners: $name",
  async ({ groupPolicy, topicPolicy, allowed }) => {
    await withTelegramNativeOwners(async ({ cfg, invokeTopic, handler, driver }) => {
      cfg.channels!.telegram!.groups = {
        "-10012345": {
          groupPolicy,
          topics: {
            "42": {
              agentId: "topic-owner",
              ...(topicPolicy ? { groupPolicy: topicPolicy } : {}),
            },
          },
        },
      };
      await invokeTopic();
      if (allowed) {
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            senderIsOwner: true,
            agentId: "topic-owner",
            messageThreadId: 42,
            sessionKey: "agent:topic-owner:telegram:group:-10012345:topic:42",
          }),
        );
        expect(driver.deliveries()).toEqual([{ replies: [{ text: "TELEGRAM-OWNER-OK" }] }]);
      } else {
        expect(handler).not.toHaveBeenCalled();
        expect(driver.sentMessages()).toEqual([]);
        expect(driver.deliveries()).toEqual([]);
      }
    });
  },
);

it.each(["provider allowlist", "global allowlist", "unlinked", "asserted"])(
  "keeps native owner commands denied for %s",
  async (denial) => {
    await withTelegramNativeOwners(async ({ cfg, invoke, handler, driver }) => {
      if (denial === "provider allowlist") {
        cfg.commands!.allowFrom = { telegram: ["999999"] };
      }
      if (denial === "global allowlist") {
        cfg.commands!.allowFrom = { "*": ["999999"] };
      }
      await invoke(denial === "unlinked" ? 300 : 100);
      expect(handler).not.toHaveBeenCalled();
      expect(driver.sentMessages()).toEqual([
        {
          chatId: denial === "unlinked" ? 300 : 100,
          text: "You are not authorized to use this command.",
        },
      ]);
      expect(driver.deliveries()).toEqual([]);
    }, denial === "asserted");
  },
);

it.each(["demote", "unlink", "reassign"])(
  "rejects stale native plugin owner authority after %s",
  async (revocation) => {
    await withTelegramNativeOwners(async ({ invoke, handler, admins, driver }) => {
      const entered = createDeferredCore();
      const finish = createDeferredCore();
      let effects = 0;
      handler.mockImplementation(async (ctx) => {
        expect(ctx.senderIsOwner).toBe(true);
        expect(ctx.assertOwnerCurrent).toBeTypeOf("function");
        entered.resolve();
        await finish.promise;
        ctx.assertOwnerCurrent?.();
        effects += 1;
        return { text: "TELEGRAM-OWNER-OK" };
      });
      const pending = invoke();
      try {
        expect(
          await Promise.race([
            entered.promise.then(() => "entered"),
            pending.then(() => "finished"),
          ]),
        ).toBe("entered");
        const admin = admins[0]!;
        if (revocation === "demote") {
          setUserProfileRole(admin.profile.id, "member");
        } else {
          unlinkUserChannelIdentity(admin.profile.id, admin.identity);
          if (revocation === "reassign") {
            linkUserChannelIdentity(admins[1]!.profile.id, admin.identity);
          }
        }
        finish.resolve();
        await pending;
        expect(effects).toBe(0);
        expect(driver.deliveries()).toHaveLength(1);
        expect(driver.deliveries()).toContainEqual(
          expect.objectContaining({
            replies: [
              expect.objectContaining({ text: "⚠️ Command failed. Please try again later." }),
            ],
          }),
        );
      } finally {
        finish.resolve();
        await pending;
      }
    });
  },
);

it.each([false, true])(
  "retains linked owner authority through native provider login (revoke=%s)",
  async (revoke) => {
    await withTelegramNativeOwners(async ({ cfg, admins, driver }) => {
      cfg.agents = { defaults: { model: "openai/gpt-5.5" } };
      const finish = createDeferredCore();
      const notified = createDeferredCore();
      let writes = 0;
      const loginFlow = vi.fn<
        (options: ModelsAuthLoginFlowOptions) => Promise<ModelsAuthLoginFlowResult>
      >(async (options) => {
        await options.prompter.deviceCode?.({ title: "Sign in", code: "OWNER-TEST-CODE" });
        await finish.promise;
        options.assertCurrent?.();
        writes += 1;
        return {
          providerId: "openai",
          methodId: "device-code",
          authRefresh: "refreshed",
          profiles: [],
        };
      });
      driver.configureLogin({
        run: loginFlow,
        onResult: () => notified.resolve(),
      });
      try {
        await driver.invoke({
          command: "login",
          senderId: 100,
          match: "openai/openai-device-code",
        });
        expect(loginFlow).toHaveBeenCalledOnce();
        if (revoke) {
          setUserProfileRole(admins[0]!.profile.id, "member");
        }
        finish.resolve();
        await notified.promise;
        expect(writes).toBe(revoke ? 0 : 1);
      } finally {
        finish.resolve();
        if (loginFlow.mock.calls.length > 0) {
          await notified.promise;
        }
      }
    });
  },
);
