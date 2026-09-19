import { expect, it } from "vitest";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";

it.each([
  ["global", "global", "agent:research:global", "global"],
  ["global", "agent:research:global", "agent:research:global", "agent:research:global"],
  ["global", "unknown", "agent:research:unknown", "unknown"],
  ["global", "agent:research:unknown", "agent:research:unknown", "agent:research:unknown"],
  ["global", "main", "agent:research:global", "global"],
  ["global", "agent:research:main", "agent:research:global", "global"],
  ["global", "inbox", "agent:research:global", "global"],
  ["global", "agent:research:inbox", "agent:research:global", "global"],
  ["per-sender", "main", "agent:research:inbox", "agent:research:inbox"],
  ["per-sender", "agent:research:main", "agent:research:inbox", "agent:research:inbox"],
  ["per-sender", "inbox", "agent:research:inbox", "agent:research:inbox"],
  ["per-sender", "agent:research:inbox", "agent:research:inbox", "agent:research:inbox"],
] as const)(
  "retains the published %s target spelling for %s after unsubscribe clears selection",
  async (scope, requestKey, canonicalKey, expectedKey) => {
    const client = createOperatorWsClient();
    client.connect.caps = [];
    const subscribers = createSessionMessageSubscriberRegistry();
    const harness = createDispatchTestHarness({
      buildRequestContext: () => ({
        getRuntimeConfig: () => ({
          agents: { entries: { research: {} } },
          session: { scope, mainKey: "inbox" },
        }),
        beginSessionWireSelection: subscribers.beginWireSelection,
        getSessionWireKey: subscribers.getWireKey,
        subscribeSessionMessageEvents: subscribers.subscribe,
        unsubscribeSessionMessageEvents: subscribers.unsubscribe,
      }),
    });
    for (const method of ["sessions.messages.subscribe", "sessions.messages.unsubscribe"]) {
      await harness.dispatcher.dispatch(
        {
          type: "req",
          id: method,
          method,
          params: { key: requestKey, agentId: "research" },
        },
        client,
      );
      const subscribed = method === "sessions.messages.subscribe";
      expect([...subscribers.get(canonicalKey)]).toEqual(subscribed ? [client.connId] : []);
      expect(subscribers.getWireKey(client.connId, canonicalKey)).toBe(
        subscribed ? requestKey : undefined,
      );
      expect([...subscribers.getApprovals(canonicalKey)]).toEqual([]);
      expect(await harness.awaitResponseFrame(method)).toMatchObject({
        ok: true,
        payload: { subscribed, key: expectedKey },
      });
    }
  },
);
