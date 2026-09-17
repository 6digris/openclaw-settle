import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { DispatchReplyFromConfig } from "../../auto-reply/reply/dispatch-from-config.types.js";
import type { ChannelTurnPlan, RunChannelTurnParams } from "../../channels/turn/types.js";
import { createRuntimeChannel } from "./runtime-channel.js";

const unownedDispatch = vi.hoisted(() =>
  vi.fn<DispatchReplyFromConfig>(async ({ dispatcher }) => {
    dispatcher.sendFinalReply({ text: "unowned reply" });
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  }),
);

vi.mock("../../auto-reply/reply/dispatch-from-config.js", () => ({
  dispatchReplyFromConfig: unownedDispatch,
  dispatchLowLevelChannelReplyFromConfig: unownedDispatch,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createBoundDispatch(text = "owned reply") {
  return vi.fn<DispatchReplyFromConfig>(async ({ dispatcher }) => {
    dispatcher.sendFinalReply({ text });
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
  });
}

function createPlan(dispatchReplyFromConfig?: DispatchReplyFromConfig) {
  const channel = createRuntimeChannel();
  const store = path.join(tempDirs.make("openclaw-runtime-inbound-"), "sessions.json");
  const deliver = vi.fn(async () => ({ visibleReplySent: true }));
  const plan: ChannelTurnPlan = {
    channel: "test",
    cfg: { session: { store } },
    route: { agentId: "main", sessionKey: "agent:main:test:peer" },
    ctxPayload: channel.reply.finalizeInboundContext({
      Body: "hello",
      From: "peer",
      To: "bot",
      SessionKey: "agent:main:test:peer",
      Provider: "test",
      Surface: "test",
      ChatType: "direct",
    }),
    delivery: { deliver },
    ...(dispatchReplyFromConfig ? { dispatchReplyFromConfig } : {}),
  };
  return { plan, deliver };
}

function createRawParams(plan: ChannelTurnPlan): RunChannelTurnParams<{ text: string }> {
  return {
    channel: "test",
    raw: { text: "hello" },
    adapter: {
      ingest: (raw) => ({ id: "message", rawText: raw.text }),
      resolveTurn: () => plan,
    },
  };
}

describe("runtime raw inbound ownership", () => {
  beforeEach(() => vi.clearAllMocks());

  it("delivers through the owning dispatcher without a plan override", async () => {
    const dispatch = createBoundDispatch();
    const channel = createRuntimeChannel({ dispatchReplyFromConfig: dispatch });
    const { plan, deliver } = createPlan();
    const result = await channel.inbound.run(createRawParams(plan));

    expect(result.dispatched).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(unownedDispatch).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ text: "owned reply" }),
      expect.objectContaining({ kind: "final" }),
    );
    expect(plan).not.toHaveProperty("dispatchReplyFromConfig");
  });

  it("retains adapter receivers across asynchronous resolution and finalization", async () => {
    const dispatch = createBoundDispatch();
    const channel = createRuntimeChannel({ dispatchReplyFromConfig: dispatch });
    const { plan } = createPlan();
    class Adapter {
      readonly calls: string[] = [];
      ingest(raw: { text: string }) {
        this.calls.push("ingest");
        return { id: "message", rawText: raw.text };
      }
      classify() {
        this.calls.push("classify");
        return { kind: "message" as const, canStartAgentTurn: true };
      }
      preflight() {
        this.calls.push("preflight");
        return { admission: { kind: "dispatch" as const } };
      }
      async resolveTurn() {
        await Promise.resolve();
        this.calls.push("resolve");
        return plan;
      }
      onFinalize() {
        this.calls.push("finalize");
      }
    }
    const adapter = new Adapter();
    await channel.inbound.run({ channel: "test", raw: { text: "hello" }, adapter });

    expect(adapter.calls).toEqual(["ingest", "classify", "preflight", "resolve", "finalize"]);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("keeps an explicit routed dispatcher instead of replacing its owner", async () => {
    const dispatch = createBoundDispatch();
    const explicitDispatch = createBoundDispatch("explicit reply");
    const channel = createRuntimeChannel({ dispatchReplyFromConfig: dispatch });
    const { plan, deliver } = createPlan(explicitDispatch);
    await channel.inbound.run(createRawParams(plan));

    expect(explicitDispatch).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ text: "explicit reply" }),
      expect.objectContaining({ kind: "final" }),
    );
  });

  it("keeps the genuinely ownerless runtime usable", async () => {
    const { plan, deliver } = createPlan();
    await createRuntimeChannel().inbound.run(createRawParams(plan));

    expect(unownedDispatch).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ text: "unowned reply" }),
      expect.objectContaining({ kind: "final" }),
    );
  });

  it("binds provider-owned delivery while preserving its delivery contract", async () => {
    const dispatch = createBoundDispatch();
    const channel = createRuntimeChannel({ dispatchReplyFromConfig: dispatch });
    const { plan, deliver } = createPlan();
    await channel.inbound.run({
      channel: "test",
      raw: "hello",
      adapter: {
        ingest: (raw) => ({ id: "message", rawText: raw }),
        resolveTurn: () => ({
          ...plan,
          delivery: { deliverWithProviderMessageSending: deliver },
        }),
      },
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("leaves prepared closures and their dispatch-result generic with the caller", async () => {
    const dispatch = createBoundDispatch();
    const channel = createRuntimeChannel({ dispatchReplyFromConfig: dispatch });
    const { plan } = createPlan();
    const runDispatch = vi.fn(async () => ({ answer: 42, visibleReplySent: true }));
    const result = await channel.inbound.run({
      channel: "test",
      raw: 42,
      adapter: {
        ingest: (raw) => ({ id: "message", rawText: String(raw) }),
        resolveTurn: () => ({
          ...plan,
          runDispatch,
          runDispatchLifecycle: { turnAdoptionLifecycle: undefined, onDispatchSkipped: vi.fn() },
        }),
      },
    });

    expect(result.dispatched && result.dispatchResult.answer).toBe(42);
    expect(runDispatch).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(unownedDispatch).not.toHaveBeenCalled();
  });

  it("leaves assembled compatibility dispatcher ownership with the caller", async () => {
    const dispatch = createBoundDispatch();
    const channel = createRuntimeChannel({ dispatchReplyFromConfig: dispatch });
    const { plan, deliver } = createPlan();
    const { route, ...assembled } = plan;
    const callerDispatch = vi.fn(async () => ({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    }));
    await channel.inbound.run({
      channel: "test",
      raw: "hello",
      adapter: {
        ingest: (raw) => ({ id: "message", rawText: raw }),
        resolveTurn: () => ({
          ...assembled,
          agentId: route.agentId,
          routeSessionKey: route.sessionKey,
          storePath: plan.cfg.session!.store!,
          recordInboundSession: vi.fn(async () => undefined),
          dispatchReplyWithBufferedBlockDispatcher: callerDispatch,
        }),
      },
    });

    expect(callerDispatch).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
    expect(unownedDispatch).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});
