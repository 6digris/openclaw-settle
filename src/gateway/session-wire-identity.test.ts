import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { chatHistoryHandlers } from "./server-methods/chat-history-handler.js";
import { createHistoryReadContext } from "./server-methods/chat-history.test-helpers.js";
import { handleChatSend } from "./server-methods/chat-send-handler.js";
import { sessionSubscriptionHandlers } from "./server-methods/sessions-subscriptions.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { legacySessionRequest } from "./session-wire-request.js";

function peer(id: string, canonical = false) {
  const frames: Array<{ payload: Record<string, unknown> }> = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn((wire: string, sent: () => void) => {
      frames.push(JSON.parse(wire));
      sent();
    }),
  });
  const client = createOperatorWsClient({ connId: id, socket });
  client.connect.caps = canonical ? ["canonical-session-keys"] : [];
  return { client, frames };
}

describe("legacy native session wire identity", () => {
  it("preserves each subscribed spelling with one canonical audience and one delta per peer", async () => {
    const raw = peer("raw");
    const qualified = peer("qualified");
    const subscribers = createSessionMessageSubscriberRegistry();
    const key = "agent:research:global";
    const harness = createDispatchTestHarness({
      buildRequestContext: () => ({
        getRuntimeConfig: () => ({
          agents: { entries: { research: {} } },
          session: { scope: "global" },
        }),
        beginSessionWireSelection: subscribers.beginWireSelection,
        getSessionWireKey: subscribers.getWireKey,
        subscribeSessionMessageEvents: subscribers.subscribe,
      }),
      extraHandlers: sessionSubscriptionHandlers,
    });
    const subscribe = async (selected: ReturnType<typeof peer>, wireKey: string) => {
      const id = `${selected.client.connId}:${wireKey}`;
      await harness.dispatcher.dispatch(
        {
          type: "req",
          id,
          method: "sessions.messages.subscribe",
          params: { key: wireKey, agentId: "research" },
        },
        selected.client,
      );
      expect(await harness.awaitResponseFrame(id)).toMatchObject({
        ok: true,
        payload: { key: wireKey },
      });
    };
    await subscribe(raw, "global");
    await subscribe(qualified, key);
    expect([...subscribers.get(key)]).toEqual(["raw", "qualified"]);
    expect([...subscribers.get("global")]).toEqual([]);
    expect([...subscribers.getApprovals(key)]).toEqual([]);
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([raw.client, qualified.client]),
      sessionMessageSubscribers: subscribers,
    });
    const delta = { sessionKey: key, agentId: "research", runId: "same-run", state: "delta" };
    broadcast("chat", delta);
    expect(raw.frames.map((frame) => frame.payload.sessionKey)).toEqual(["global"]);
    expect(qualified.frames.map((frame) => frame.payload.sessionKey)).toEqual([key]);

    await subscribe(raw, key);
    subscribers.beginWireSelection("raw", "global")?.accept(key);
    broadcast("chat", delta);
    expect(raw.frames.map((frame) => frame.payload.sessionKey)).toEqual(["global", key]);
    expect(qualified.frames.map((frame) => frame.payload.sessionKey)).toEqual([key, key]);
    expect([...subscribers.get(key)]).toEqual(["raw", "qualified"]);
  });

  it("restores pending spelling after a newer replay fails and fences detached receipts", () => {
    const subscribers = createSessionMessageSubscriberRegistry();
    const key = "agent:research:global";
    subscribers.subscribe("client", key, { wireKey: "global" });
    const older = subscribers.subscribe("client", key, { provisional: true, wireKey: key })!;
    const newer = subscribers.subscribe("client", key, {
      provisional: true,
      wireKey: "global",
      includeApprovals: true,
    })!;
    expect(subscribers.getWireKey("client", key)).toBe("global");
    newer();
    expect(subscribers.getWireKey("client", key)).toBe(key);
    expect([...subscribers.getApprovals(key)]).toEqual([]);
    older.commit();
    const stale = subscribers.beginWireSelection("client", "global")!;
    subscribers.unsubscribeAll("client");
    subscribers.beginWireSelection("client", key)?.accept(key);
    stale.accept(key);
    expect(subscribers.getWireKey("client", key)).toBe(key);
    expect([...subscribers.get(key)]).toEqual([]);
    expect([...subscribers.getApprovals(key)]).toEqual([]);
  });

  it("keeps the newest accepted history selection when requests settle out of order", () => {
    const subscribers = createSessionMessageSubscriberRegistry();
    const key = "agent:research:global";
    const first = subscribers.beginWireSelection("client", "global")!;
    const second = subscribers.beginWireSelection("client", key)!;
    second.accept(key);
    first.accept(key);
    expect(subscribers.getWireKey("client", key)).toBe(key);
    expect([...subscribers.get(key)]).toEqual([]);
    expect([...subscribers.getApprovals(key)]).toEqual([]);
  });

  it("keeps declared batch bounds ahead of legacy owner resolution", () => {
    const getConfig = vi.fn(() => ({
      agents: { entries: { research: {} } },
      session: { scope: "global" as const },
    }));
    const blanks = { keys: [" ", "  "] };
    expect(legacySessionRequest("sessions.preview", blanks, getConfig)).toBe(blanks);
    const badSearch = { sessionKeys: Array(201).fill("agent:research:main"), query: "term" };
    const badPatch = {
      targets: Array.from({ length: 101 }, () => ({ key: "agent:research:main" })),
      patch: { label: "label" },
    };
    expect(legacySessionRequest("sessions.search", badSearch, getConfig)).toBe(badSearch);
    expect(legacySessionRequest("sessions.patchMany", badPatch, getConfig)).toBe(badPatch);
    expect(getConfig).not.toHaveBeenCalled();
    expect(
      legacySessionRequest(
        "sessions.preview",
        { keys: Array(70).fill(" agent:research:main ") },
        getConfig,
      ),
    ).toEqual({ keys: Array(64).fill("agent:research:global") });
  });

  it.each([false, true])(
    "preserves the requested preview key echo for canonical=%s",
    async (canonical) => {
      const { client } = peer("preview", canonical);
      const keys = [" agent:research:main ", "agent:ops:main"];
      const expectedInputs = canonical ? keys : ["agent:research:global", "agent:ops:global"];
      const observed = vi.fn();
      const harness = createDispatchTestHarness({
        buildRequestContext: () => ({
          getRuntimeConfig: () => ({
            session: { scope: "global" },
            agents: { entries: { research: {}, ops: {} } },
          }),
        }),
        extraHandlers: {
          "sessions.preview": ({ params, respond }) => {
            observed(params.keys);
            respond(true, {
              previews: (Array.isArray(params.keys) ? params.keys : []).map((key) => ({
                key: typeof key === "string" ? key.trim() : key,
                status: "empty",
                items: [],
              })),
            });
          },
        },
      });
      await harness.dispatcher.dispatch(
        { type: "req", id: "preview", method: "sessions.preview", params: { keys } },
        client,
      );
      expect(observed).toHaveBeenCalledWith(expectedInputs);
      expect(await harness.awaitResponseFrame("preview")).toMatchObject({
        ok: true,
        payload: { previews: keys.map((key) => ({ key: key.trim(), status: "empty", items: [] })) },
      });
    },
  );

  it.each([false, true])(
    "admits the selected request dialect before handlers (canonical=%s)",
    async (canonical) => {
      const { client } = peer("request", canonical);
      const params = {
        key: "agent:research:main",
        agentId: "research",
        parentSessionKey: "agent:ops:main",
        label: "agent:research:main",
        message: { sessionKey: "agent:research:main" },
      };
      const admitted = vi.fn();
      const harness = createDispatchTestHarness({
        buildRequestContext: () => ({
          getRuntimeConfig: () => ({
            agents: { entries: { research: {}, ops: {} } },
            session: { scope: "global", mainKey: "inbox" },
          }),
        }),
        extraHandlers: {
          "sessions.create": ({ params: admittedParams, respond }) => {
            admitted(admittedParams);
            respond(true, {});
          },
        },
      });
      await harness.dispatcher.dispatch(
        { type: "req", id: "create", method: "sessions.create", params },
        client,
      );
      expect(admitted).toHaveBeenCalledWith({
        ...params,
        key: canonical ? params.key : "agent:research:global",
        parentSessionKey: canonical ? params.parentSessionKey : "agent:ops:global",
      });
      expect(params.key).toBe("agent:research:main");
    },
  );

  it.each(["global", "unknown"])(
    "keeps qualified %s stable even when it names the legacy configured main",
    async (key) => {
      const { client } = peer("reserved");
      const params = { sessionKey: `agent:research:${key}`, agentId: "research" };
      const admitted = vi.fn();
      const harness = createDispatchTestHarness({
        buildRequestContext: () => ({
          getRuntimeConfig: () => ({ session: { scope: "global", mainKey: key } }),
        }),
        extraHandlers: {
          "chat.history": ({ params: admittedParams, respond }) => {
            admitted(admittedParams);
            respond(true, {});
          },
        },
      });
      await harness.dispatcher.dispatch(
        { type: "req", id: "history", method: "chat.history", params },
        client,
      );
      expect(admitted).toHaveBeenCalledWith(params);
    },
  );

  it.each([
    "chat.inject",
    "chat.message.get",
    "session.visibility.set",
    "session.suggestions.list",
    "sessions.files.list",
    "sessions.files.get",
    "sessions.files.set",
    "sessions.diff",
  ])("routes legacy %s selectors through the same main target", async (method) => {
    const { client } = peer("legacy");
    const admitted = vi.fn();
    const harness = createDispatchTestHarness({
      buildRequestContext: () => ({
        getRuntimeConfig: () => ({
          agents: { entries: { research: {} } },
          session: { scope: "global" },
        }),
      }),
      extraHandlers: {
        [method]: ({ params, respond }) => {
          admitted(params);
          respond(true, {});
        },
      },
    });
    await harness.dispatcher.dispatch(
      {
        type: "req",
        id: method,
        method,
        params: { sessionKey: "agent:research:main", agentId: "research" },
      },
      client,
    );
    expect(await harness.awaitResponseFrame(method)).toMatchObject({ ok: true });
    expect(admitted).toHaveBeenCalledWith({
      sessionKey: "agent:research:global",
      agentId: "research",
    });
  });

  it("keeps cursor replay envelopes on the same wire identity as live messages", async () => {
    const { client } = peer("legacy");
    const message = {
      content: [{ text: "agent:research:global" }],
      sessionKey: "opaque-tool-field",
    };
    const payload = {
      kind: "delta",
      sessionInfo: { key: "agent:research:global", agentId: "research" },
      messages: [{ sessionKey: "agent:research:global", agentId: "research", message }],
    };
    const harness = createDispatchTestHarness({
      extraHandlers: { "chat.history": ({ respond }) => respond(true, payload) },
    });
    await harness.dispatcher.dispatch(
      { type: "req", id: "delta", method: "chat.history", params: {} },
      client,
    );
    expect(await harness.awaitResponseFrame("delta")).toMatchObject({
      payload: {
        kind: "delta",
        messages: [{ sessionKey: "global", agentId: "research", message }],
      },
    });
  });

  it("delivers global stream and task events without changing authorization or opaque content", () => {
    const legacy = peer("legacy");
    const current = peer("current", true);
    const denied = peer("denied");
    const canReceiveSessionEvent = vi.fn<
      NonNullable<Parameters<typeof createGatewayBroadcaster>[0]["canReceiveSessionEvent"]>
    >((client, keys) => {
      expect(keys).toEqual(["agent:research:global"]);
      return client !== denied.client;
    });
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([legacy.client, current.client, denied.client]),
      canReceiveSessionEvent,
    });
    const opaque = { sessionKey: "agent:research:global", key: "agent:ops:unknown" };
    for (const event of ["chat", "agent", "session.message", "session.sharing"]) {
      broadcast(event, {
        sessionKey: "agent:research:global",
        agentId: "research",
        state: "delta",
        data: opaque,
        message: opaque,
      });
    }
    broadcast(
      "task",
      {
        action: "upserted",
        task: {
          id: "child",
          sessionKey: "agent:research:global",
          agentId: "research",
          result: opaque,
        },
      },
      { sessionKeys: ["agent:research:global"] },
    );

    expect(legacy.frames.slice(0, 3).map((frame) => frame.payload.sessionKey)).toEqual([
      "global",
      "global",
      "global",
    ]);
    expect(current.frames.slice(0, 3).map((frame) => frame.payload.sessionKey)).toEqual([
      "agent:research:global",
      "agent:research:global",
      "agent:research:global",
    ]);
    expect(legacy.frames[0]?.payload).toMatchObject({
      agentId: "research",
      data: opaque,
      message: opaque,
    });
    expect(legacy.frames[4]?.payload.task).toEqual({
      id: "child",
      sessionKey: "global",
      agentId: "research",
      result: opaque,
    });
    expect(denied.frames).toEqual([]);
    expect(canReceiveSessionEvent).toHaveBeenCalledTimes(15);
  });

  it("projects a recipient snapshot before encoding aliases and preserves cross-agent references", () => {
    const legacy = peer("legacy");
    const current = peer("current", true);
    const snapshot = {
      sessionKey: "agent:research:global",
      agentId: "research",
      session: {
        key: "agent:research:global",
        agentId: "research",
        parentSessionKey: "agent:ops:global",
        spawnedBy: "agent:research:unknown",
      },
    };
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([legacy.client, current.client]),
      prepareSessionEventProjection: () => () => snapshot,
    });
    broadcast("sessions.changed", { sessionKey: "agent:research:global" });
    expect(legacy.frames[0]?.payload).toEqual({
      sessionKey: "global",
      agentId: "research",
      session: {
        key: "global",
        agentId: "research",
        parentSessionKey: "agent:ops:global",
        spawnedBy: "unknown",
      },
    });
    expect(current.frames[0]?.payload).toEqual(snapshot);
    expect(snapshot.session.key).toBe("agent:research:global");
  });

  it("uses the same legacy identity for compaction events and checkpoints", async () => {
    const legacy = peer("legacy");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([legacy.client]),
    });
    broadcast("session.operation", {
      sessionKey: "agent:research:global",
      agentId: "research",
      operation: "compaction",
    });
    expect(legacy.frames[0]?.payload.sessionKey).toBe("global");
    const payload = {
      key: "agent:research:global",
      sourceKey: "agent:research:global",
      checkpoint: { sessionKey: "agent:research:global", summary: "agent:research:global" },
      entry: { sessionId: "checkpoint-session" },
    };
    const harness = createDispatchTestHarness({
      extraHandlers: { "sessions.compaction.branch": ({ respond }) => respond(true, payload) },
    });
    await harness.dispatcher.dispatch(
      { type: "req", id: "branch", method: "sessions.compaction.branch", params: {} },
      legacy.client,
    );
    expect(await harness.awaitResponseFrame("branch")).toMatchObject({
      payload: {
        key: "global",
        sourceKey: "global",
        checkpoint: { sessionKey: "global", summary: "agent:research:global" },
        entry: payload.entry,
      },
    });
  });

  it("preserves the published canonical progress-card wire contract", () => {
    const legacy = peer("legacy");
    const { broadcast } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([legacy.client]),
    });
    broadcast("progressCard.changed", { sessionKey: "agent:research:global" });
    expect(legacy.frames[0]?.payload.sessionKey).toBe("agent:research:global");
  });

  it.each([false, true])(
    "encodes authorized list responses for canonical=%s",
    async (canonical) => {
      const { client } = peer("response", canonical);
      const sessions = ["research", "ops"].map((agentId) => ({
        key: `agent:${agentId}:global`,
        agentId,
      }));
      const harness = createDispatchTestHarness({
        extraHandlers: { "sessions.list": ({ respond }) => respond(true, { sessions }) },
      });
      await harness.dispatcher.dispatch(
        { type: "req", id: "list", method: "sessions.list", params: {} },
        client,
      );
      expect(await harness.awaitResponseFrame("list")).toMatchObject({
        ok: true,
        payload: {
          sessions: sessions.map((row) => ({ ...row, key: canonical ? row.key : "global" })),
        },
      });
      expect(sessions.map((row) => row.key)).toEqual(["agent:research:global", "agent:ops:global"]);
    },
  );
  it.each([
    {
      method: "sessions.subscribe",
      payload: {
        subscribed: true,
        list: { sessions: [{ key: "agent:research:global", agentId: "research" }] },
      },
      expected: { subscribed: true, list: { sessions: [{ key: "global", agentId: "research" }] } },
    },
    {
      method: "chat.startup",
      payload: {
        resolution: { ok: true, key: "agent:research:global", agentId: "research" },
        inFlightRun: {
          runId: "existing-run",
          events: [{ sessionKey: "agent:research:global", data: { sessionKey: "opaque" } }],
        },
      },
      expected: {
        resolution: { ok: true, key: "global", agentId: "research" },
        inFlightRun: {
          runId: "existing-run",
          events: [{ sessionKey: "global", data: { sessionKey: "opaque" } }],
        },
      },
    },
    {
      method: "chat.history",
      payload: {
        sessionKey: "agent:research:global",
        sessionInfo: { key: "agent:research:global", agentId: "research" },
        messages: [{ sessionKey: "agent:research:global" }],
      },
      expected: {
        sessionKey: "global",
        sessionInfo: { key: "global", agentId: "research" },
        messages: [{ sessionKey: "agent:research:global" }],
      },
    },
    {
      method: "question.list",
      payload: {
        questions: [
          {
            sessionKey: "agent:research:unknown",
            agentId: "research",
            questions: [{ label: "agent:research:unknown" }],
          },
        ],
      },
      expected: {
        questions: [
          {
            sessionKey: "unknown",
            agentId: "research",
            questions: [{ label: "agent:research:unknown" }],
          },
        ],
      },
    },
    {
      method: "exec.approval.list",
      payload: [
        {
          request: {
            sessionKey: "agent:research:global",
            agentId: "research",
            command: "echo agent:research:global",
          },
        },
      ],
      expected: [
        {
          request: {
            sessionKey: "global",
            agentId: "research",
            command: "echo agent:research:global",
          },
        },
      ],
    },
  ])("keeps opaque content intact in legacy $method", async ({ method, payload, expected }) => {
    const { client } = peer("legacy");
    const harness = createDispatchTestHarness({
      extraHandlers: { [method]: ({ respond }) => respond(true, payload) },
    });
    await harness.dispatcher.dispatch({ type: "req", id: method, method, params: {} }, client);
    expect(await harness.awaitResponseFrame(method)).toMatchObject({ ok: true, payload: expected });
  });

  it("keeps raw and qualified native selections streaming over a real loopback WebSocket", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const key = "agent:research:global";
      const cfg = { agents: { entries: { research: {} } }, session: { scope: "global" as const } };
      await state.writeConfig(cfg);
      await upsertSessionEntryCore(
        { agentId: "research", sessionKey: key },
        { sessionId: "native-global", updatedAt: 1 },
      );
      const subscribers = createSessionMessageSubscriberRegistry();
      const context = await createHistoryReadContext({
        getRuntimeConfig: () => cfg,
        beginSessionWireSelection: subscribers.beginWireSelection,
        getSessionWireKey: subscribers.getWireKey,
      });
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const accepted = once(server, "connection");
      const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const opened = once(client, "open");
      const [socket] = await accepted;
      try {
        await opened;
        const legacy = createOperatorWsClient({ socket });
        const harness = createDispatchTestHarness({
          buildRequestContext: () => context,
          extraHandlers: { ...chatHistoryHandlers, "chat.send": handleChatSend },
        });
        context.dedupe.set("chat:native-run", {
          ts: Date.now(),
          ok: true,
          payload: { runId: "native-run", status: "in_flight" },
        });
        const dispatches: Promise<void>[] = [];
        socket.on("message", (wire: Buffer) => {
          dispatches.push(harness.dispatcher.dispatch(JSON.parse(wire.toString()), legacy));
        });
        const { broadcast } = createGatewayBroadcaster({
          clients: new GatewayClientRegistry([legacy]),
          sessionMessageSubscribers: subscribers,
        });
        for (const [index, { method, selected }] of [
          { method: "chat.history", selected: "global" },
          { method: "chat.startup", selected: key },
          { method: "chat.history", selected: "global" },
          { method: "chat.send", selected: key },
          { method: "chat.send", selected: "global" },
        ].entries()) {
          const id = `selection-${index}`;
          client.send(
            JSON.stringify({
              type: "req",
              id,
              method,
              params: {
                sessionKey: selected,
                agentId: "research",
                ...(method === "chat.send"
                  ? { idempotencyKey: "native-run", message: "Continue" }
                  : {}),
              },
            }),
          );
          expect(await harness.awaitResponseFrame(id)).toMatchObject({
            ok: true,
            payload:
              method === "chat.send"
                ? { runId: "native-run", status: "in_flight" }
                : { sessionKey: selected },
          });
          const received = once(client, "message");
          broadcast("chat", {
            sessionKey: key,
            agentId: "research",
            runId: "native-run",
            state: "delta",
            message: { content: [{ type: "text", text: "Still running" }] },
          });
          const [wire] = await received;
          // Published Android compares this key exactly with its selected spelling.
          expect(JSON.parse(wire.toString()).payload).toEqual({
            sessionKey: selected,
            agentId: "research",
            runId: "native-run",
            state: "delta",
            message: { content: [{ type: "text", text: "Still running" }] },
          });
        }
        await Promise.all(dispatches);
        expect([...subscribers.get(key)]).toEqual([]);
        expect([...subscribers.getApprovals(key)]).toEqual([]);
      } finally {
        client.terminate();
        socket.terminate();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    });
  });
});
