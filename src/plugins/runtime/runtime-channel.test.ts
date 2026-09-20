// Runtime channel tests cover channel plugin runtime send, reply, and capability behavior.
import { getEventListeners } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { DispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.types.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { dispatchReplyWithBufferedBlockDispatcherCore } from "../../auto-reply/reply/provider-dispatcher.js";
import type * as ChannelSessionModule from "../../channels/session.js";
import type {
  AssembledChannelTurn,
  ChannelTurnPlan,
  ChannelTurnResult,
  RunChannelTurnParams,
} from "../../channels/turn/types.js";
import {
  bindLegacyPluginSdkResourceHost,
  getLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../legacy-sdk-resource-host.js";
import { withPluginRuntimeGatewayContextResolver } from "./gateway-request-scope.js";
import { createRuntimeChannel } from "./runtime-channel.js";

const unboundDispatches = vi.hoisted(() => [] as string[]);

vi.mock("../../auto-reply/reply/dispatch-from-config.js", () => {
  const dispatch: DispatchReplyFromConfig = async ({ dispatcher }) => {
    unboundDispatches.push("unbound");
    return {
      queuedFinal: dispatcher.sendFinalReply({ text: "unbound reply" }),
      counts: dispatcher.getQueuedCounts(),
    };
  };
  return {
    dispatchReplyFromConfig: dispatch,
    dispatchLowLevelChannelReplyFromConfig: dispatch,
  };
});

vi.mock("../../channels/session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ChannelSessionModule>()),
  recordInboundSession: async () => undefined,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createChannelDispatchFixture(bound = true) {
  const owner = new LegacyPluginSdkResourceHost();
  const resolveGatewayContext = () => undefined;
  bindLegacyPluginSdkResourceHost(resolveGatewayContext, owner);
  const dispatchReplyFromConfig: DispatchReplyFromConfig = (params) =>
    withPluginRuntimeGatewayContextResolver(resolveGatewayContext, async () => {
      await Promise.resolve();
      getLegacyPluginSdkResourceHost().assertOpen();
      return {
        queuedFinal: params.dispatcher.sendFinalReply({ text: "owner reply" }),
        counts: params.dispatcher.getQueuedCounts(),
      };
    });
  const channel = createRuntimeChannel({
    dispatchReplyFromConfig: bound ? dispatchReplyFromConfig : undefined,
  });
  const delivered: string[] = [];
  const callerDispatches: string[] = [];
  const storePath = path.join(tempDirs.make("openclaw-runtime-channel-owner-"), "sessions.json");
  const routeSessionKey = "agent:main:qa-channel:direct:peer";
  const turn: AssembledChannelTurn = {
    cfg: { session: { store: storePath } },
    channel: "qa-channel",
    agentId: "main",
    routeSessionKey,
    storePath,
    ctxPayload: finalizeInboundContext({
      Body: "hello",
      From: "peer",
      To: "bot",
      SessionKey: routeSessionKey,
      Provider: "qa-channel",
      Surface: "qa-channel",
      ChatType: "direct",
      CommandAuthorized: false,
    }),
    recordInboundSession: channel.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherCore,
    dispatchReplyFromConfig: async ({ dispatcher }) => {
      callerDispatches.push("caller");
      return {
        queuedFinal: dispatcher.sendFinalReply({ text: "caller reply" }),
        counts: dispatcher.getQueuedCounts(),
      };
    },
    delivery: {
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
        return { visibleReplySent: true };
      },
    },
  };
  const routed: ChannelTurnPlan = {
    cfg: turn.cfg,
    channel: turn.channel,
    route: { agentId: turn.agentId, sessionKey: routeSessionKey },
    ctxPayload: turn.ctxPayload,
    dispatchReplyFromConfig: turn.dispatchReplyFromConfig,
    delivery: turn.delivery,
  };
  unboundDispatches.length = 0;
  return { channel, owner, turn, routed, delivered, callerDispatches };
}

class ChannelTurnAdapter {
  readonly #turn: AssembledChannelTurn | ChannelTurnPlan;

  constructor(turn: AssembledChannelTurn | ChannelTurnPlan) {
    this.#turn = turn;
  }

  ingest(raw: string) {
    return { id: raw, rawText: "hello" };
  }

  resolveTurn() {
    return this.#turn;
  }
}

function requireWatcherEvent(mock: ReturnType<typeof vi.fn>, index: number) {
  const event = mock.mock.calls[index]?.[0] as { type?: string } | undefined;
  if (!event) {
    throw new Error(`Expected watcher event ${index}`);
  }
  return event;
}

describe("inbound dispatch", () => {
  it("keeps the complete deprecated turn object identical to inbound", () => {
    const channel = createRuntimeChannel();
    expect(channel.turn).toBe(channel.inbound);
    expect(channel.turn.dispatch).toBe(channel.inbound.dispatch);
  });
  it.each(["raw-routed", "raw-assembled", "routed", "assembled", "buffered"] as const)(
    "%s delivers through its Gateway owner and rejects retained dispatch after closure",
    async (surface) => {
      const fixture = createChannelDispatchFixture();
      const { channel, owner, turn, routed, delivered, callerDispatches } = fixture;
      const adapter = new ChannelTurnAdapter(surface === "raw-routed" ? routed : turn);
      const dispatch = () => {
        switch (surface) {
          case "routed":
            return channel.inbound.dispatch(routed);
          case "assembled":
            return channel.inbound.dispatchReply(turn);
          case "buffered":
            return channel.reply.dispatchReplyWithBufferedBlockDispatcher({
              cfg: turn.cfg,
              ctx: turn.ctxPayload,
              dispatcherOptions: { deliver: turn.delivery.deliver },
              dispatchReplyFromConfig: turn.dispatchReplyFromConfig,
            });
          default:
            return channel.inbound.run({ channel: turn.channel, raw: "message", adapter });
        }
      };
      try {
        await dispatch();
        expect.soft(delivered).toEqual(["owner reply"]);
        expect.soft(callerDispatches).toEqual([]);
        expect.soft(unboundDispatches).toEqual([]);

        await owner.close();

        await expect(dispatch()).rejects.toThrow("Plugin SDK resource host is closed");
        expect(delivered).toEqual(["owner reply"]);
        expect(callerDispatches).toEqual([]);
        expect(unboundDispatches).toEqual([]);
      } finally {
        await owner.close();
      }
    },
  );

  it("uses the caller dispatcher when the runtime has no Gateway binding", async () => {
    const { channel, owner, routed, delivered } = createChannelDispatchFixture(false);
    try {
      await channel.inbound.run({
        channel: routed.channel,
        raw: "message",
        adapter: new ChannelTurnAdapter(routed),
      });
      expect(delivered).toEqual(["caller reply"]);
      expect(unboundDispatches).toEqual([]);
    } finally {
      await owner.close();
    }
  });

  it("leaves prepared dispatch and its result under caller ownership", async () => {
    const { channel, owner, turn, delivered } = createChannelDispatchFixture();
    await owner.close();
    const params = {
      channel: turn.channel,
      raw: "message",
      adapter: {
        ingest: (raw: string) => ({ id: raw, rawText: "hello" }),
        resolveTurn: () => ({
          channel: turn.channel,
          ctxPayload: turn.ctxPayload,
          routeSessionKey: turn.routeSessionKey,
          storePath: turn.storePath,
          recordInboundSession: turn.recordInboundSession,
          runDispatchLifecycle: {
            turnAdoptionLifecycle: undefined,
            onDispatchSkipped: () => undefined,
          },
          runDispatch: async () => {
            await turn.delivery.deliver({ text: "prepared reply" }, { kind: "final" });
            return "caller result" as const;
          },
        }),
      },
    } satisfies RunChannelTurnParams<string, "caller result">;

    const result: ChannelTurnResult<"caller result"> = await channel.inbound.run(params);

    expect(result).toMatchObject({ dispatched: true, dispatchResult: "caller result" });
    expect(delivered).toEqual(["prepared reply"]);
    expect(unboundDispatches).toEqual([]);
  });
});

describe("runtimeContexts", () => {
  it("registers, resolves, watches, and unregisters contexts", () => {
    const channel = createRuntimeChannel();
    const onEvent = vi.fn();
    const unsubscribe = channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "ok" },
    });

    expect(
      channel.runtimeContexts.get<{ client: string }>({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({ client: "ok" });
    expect(onEvent).toHaveBeenCalledWith({
      type: "registered",
      key: {
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      },
      context: { client: "ok" },
    });

    lease.dispose();

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(onEvent).toHaveBeenLastCalledWith({
      type: "unregistered",
      key: {
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      },
    });

    unsubscribe();
  });

  it("auto-disposes registrations when the abort signal fires", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const lease = channel.runtimeContexts.register({
      channelId: "telegram",
      accountId: "default",
      capability: "approval.native",
      context: { token: "abc" },
      abortSignal: controller.signal,
    });

    controller.abort();

    expect(
      channel.runtimeContexts.get({
        channelId: "telegram",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    lease.dispose();
  });

  it("removes its abort listener when the lease is disposed", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const initialListenerCount = getEventListeners(controller.signal, "abort").length;
    const lease = channel.runtimeContexts.register({
      channelId: "telegram",
      accountId: "default",
      capability: "approval.native",
      context: { token: "abc" },
      abortSignal: controller.signal,
    });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 1);

    lease.dispose();

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount);
  });

  it("removes the stale lease abort listener after a replacement registration", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const initialListenerCount = getEventListeners(controller.signal, "abort").length;
    const staleLease = channel.runtimeContexts.register({
      channelId: "whatsapp",
      accountId: "default",
      capability: "connection.controller",
      context: { token: "stale" },
      abortSignal: controller.signal,
    });
    channel.runtimeContexts.register({
      channelId: "whatsapp",
      accountId: "default",
      capability: "connection.controller",
      context: { token: "replacement" },
      abortSignal: controller.signal,
    });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 2);

    // Channel plugins dispose the previous lease after registering its replacement,
    // so the stale token check must not skip listener cleanup.
    staleLease.dispose();

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(initialListenerCount + 1);
    expect(
      channel.runtimeContexts.get({
        channelId: "whatsapp",
        accountId: "default",
        capability: "connection.controller",
      }),
    ).toEqual({ token: "replacement" });
  });

  it("does not register contexts when the abort signal is already aborted", () => {
    const channel = createRuntimeChannel();
    const onEvent = vi.fn();
    const controller = new AbortController();
    controller.abort();
    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "stale" },
      abortSignal: controller.signal,
    });

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(onEvent).not.toHaveBeenCalled();
    lease.dispose();
  });

  it("isolates watcher exceptions so registration and disposal still complete", () => {
    const channel = createRuntimeChannel();
    const badWatcher = vi.fn((event) => {
      throw new Error(`boom:${event.type}`);
    });
    const goodWatcher = vi.fn();

    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent: badWatcher,
    });
    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent: goodWatcher,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "ok" },
    });

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toEqual({ client: "ok" });
    expect(requireWatcherEvent(badWatcher, 0).type).toBe("registered");
    expect(requireWatcherEvent(goodWatcher, 0).type).toBe("registered");

    lease.dispose();

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(requireWatcherEvent(badWatcher, 1).type).toBe("unregistered");
    expect(requireWatcherEvent(goodWatcher, 1).type).toBe("unregistered");
  });

  it("auto-disposes when a watcher aborts during the registered event", () => {
    const channel = createRuntimeChannel();
    const controller = new AbortController();
    const onEvent = vi.fn((event) => {
      if (event.type === "registered") {
        controller.abort();
      }
    });

    channel.runtimeContexts.watch({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      onEvent,
    });

    const lease = channel.runtimeContexts.register({
      channelId: "matrix",
      accountId: "default",
      capability: "approval.native",
      context: { client: "ok" },
      abortSignal: controller.signal,
    });

    expect(
      channel.runtimeContexts.get({
        channelId: "matrix",
        accountId: "default",
        capability: "approval.native",
      }),
    ).toBeUndefined();
    expect(requireWatcherEvent(onEvent, 0).type).toBe("registered");
    expect(requireWatcherEvent(onEvent, 1).type).toBe("unregistered");

    lease.dispose();
  });
});
