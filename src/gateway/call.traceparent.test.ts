import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import type { GatewayClientOptions, GatewayClientRequestOptions } from "./client.js";
type TraceCallState = {
  starts: number;
  options?: GatewayClientOptions;
  requests: Array<{ method: string; params: unknown; options?: GatewayClientRequestOptions }>;
};
const state = vi.hoisted(() => {
  const value: TraceCallState = { starts: 0, requests: [] };
  return value;
});
vi.mock("./client.js", () => ({
  isGatewayConnectAssemblyError: () => false,
  GatewayClient: class {
    constructor(options: GatewayClientOptions) {
      state.options = options;
    }
    start() {
      state.starts++;
      state.options?.onHelloOk?.({
        type: "hello-ok",
        protocol: 1,
        server: { version: "fixture", connId: "fixture" },
        features: { methods: ["health"], capabilities: [], events: [] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        auth: { role: "operator", scopes: ["operator.read"] },
        policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
      } satisfies HelloOk);
    }
    async request(method: string, params: unknown, options?: GatewayClientRequestOptions) {
      state.requests.push({ method, params, options });
      return { ok: true };
    }
    async stopAndWait() {}
    stop() {}
  },
}));
vi.mock("../../packages/gateway-client/src/readiness.js", () => ({
  startGatewayClientWhenEventLoopReady: async (client: { start: () => void }) => {
    client.start();
    return { ready: true, aborted: false };
  },
}));
import { callGateway } from "./call.js";
beforeEach(() => {
  state.starts = 0;
  state.options = undefined;
  state.requests = [];
});
describe("callGateway explicit diagnostic correlation", () => {
  it("forwards only to the requested method without changing params/auth options", async () => {
    const traceparent = "00-" + "1".repeat(32) + "-" + "2".repeat(16) + "-01";
    const params = { unchanged: true };
    await callGateway({
      method: "health",
      params,
      url: "ws://127.0.0.1:18789",
      token: "fixture",
      config: {},
      deviceIdentity: null,
      sharedStateMode: "read-only",
      traceparent,
    });
    expect(state.requests).toEqual([
      expect.objectContaining({
        method: "health",
        params,
        options: expect.objectContaining({ traceparent }),
      }),
    ]);
    expect(state.options).not.toHaveProperty("traceparent");
  });
  it.each([
    "",
    "malformed",
    "x".repeat(129),
    "00-" + "0".repeat(32) + "-" + "2".repeat(16) + "-01",
  ])("rejects malformed correlation before connection: %s", async (traceparent) => {
    await expect(callGateway({ method: "health", traceparent })).rejects.toThrow(
      "Invalid diagnostic traceparent.",
    );
    expect(state.starts).toBe(0);
    expect(state.requests).toEqual([]);
  });
});
