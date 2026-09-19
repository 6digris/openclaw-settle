import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createGatewayConnectionState } from "../../server-connection-state.js";
import { sessionSubscriptionHandlers } from "../../server-methods/sessions-subscriptions.js";
import type { GatewayRequestHandler } from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./authenticated-request-dispatch.test-support.js";

describe("authenticated request connection liveness", { concurrent: false }, () => {
  it.each([
    {
      method: "sessions.subscribe",
      params: {},
      assertEmpty: (state: ReturnType<typeof createGatewayConnectionState>) =>
        expect(state.sessionEventSubscribers.getAll()).toEqual(new Set()),
    },
    {
      method: "sessions.messages.subscribe",
      params: { key: "agent:main:main" },
      assertEmpty: (state: ReturnType<typeof createGatewayConnectionState>) =>
        expect(state.sessionMessageSubscribers.get("agent:main:main")).toEqual(new Set()),
    },
  ])("rejects a late $method mutation after disconnect cleanup", async (testCase) => {
    const held = createDeferredCore();
    const started = createDeferredCore();
    const delayedHandler = vi.fn<GatewayRequestHandler>(async (options) => {
      started.resolve();
      await held.promise;
      const handler = sessionSubscriptionHandlers[options.req.method];
      if (!handler) {
        throw new Error(`missing test handler for ${options.req.method}`);
      }
      await handler(options);
    });
    const state = createGatewayConnectionState({ bootId: "late-subscription", cfg: {} });
    onTestFinished(() => state.mentionInbox.dispose());
    const client = createOperatorWsClient({
      connId: "late-subscription-connection",
      scopes: ["operator.read"],
    });
    state.clients.add(client);
    const harness = createDispatchTestHarness({
      connId: client.connId,
      extraHandlers: { [testCase.method]: delayedHandler },
      buildRequestContext: () => ({
        getRuntimeConfig: () => ({}),
        logGateway: { error: vi.fn() },
        subscribeSessionEvents: state.sessionEventSubscribers.subscribe,
        subscribeSessionMessageEvents: state.sessionMessageSubscribers.subscribe,
      }),
    });

    const dispatch = harness.dispatcher.dispatch(
      { type: "req", id: testCase.method, method: testCase.method, params: testCase.params },
      client,
    );
    try {
      await Promise.race([
        started.promise,
        dispatch.then(() => {
          throw new Error("Request settled before the held handler started");
        }),
      ]);
      expect(delayedHandler).toHaveBeenCalledOnce();
      state.clients.delete(client);
      state.sessionEventSubscribers.unsubscribe(client.connId);
      state.sessionMessageSubscribers.unsubscribeAll(client.connId);
    } finally {
      held.resolve();
      await dispatch;
    }

    expect(await harness.awaitResponseFrame(testCase.method)).toMatchObject({ ok: true });
    testCase.assertEmpty(state);
  });
});
