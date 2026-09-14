import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { startQaGatewayRpcProxy } from "./fixtures/qa-gateway-rpc-proxy.mjs";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "./helpers/gateway-websocket.js";
import { createDeferred } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

type Proxy = Awaited<ReturnType<typeof startQaGatewayRpcProxy>>;

async function withProxy(
  holdUpgrade: boolean,
  body: (fixture: {
    proxy: Proxy;
    front: WebSocket;
    upstream: Promise<WebSocket>;
    upgrade: Promise<Duplex>;
    reconnect: () => Promise<{ front: WebSocket; upstream: Promise<WebSocket> }>;
  }) => Promise<void>,
  captureReadiness = false,
) {
  const server = createServer();
  const sockets = new Set<Duplex>();
  const peers = new Set<WebSocket>();
  const backend = new WebSocketServer({ noServer: true });
  const upgrade = createDeferred<Duplex>();
  const upstream = createDeferred<WebSocket>();
  let nextUpstream = upstream;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    upgrade.resolve(socket);
    if (holdUpgrade) {
      socket.on("end", () => socket.end());
      socket.resume();
    } else {
      backend.handleUpgrade(request, socket, head, (ws) => {
        peers.add(ws);
        ws.once("close", () => peers.delete(ws));
        nextUpstream.resolve(ws);
      });
    }
  });
  let proxy: Proxy | undefined;
  let front: WebSocket | undefined;
  await runQaGatewayFixture(
    async () => {
      const listening = once(server, "listening");
      server.listen(0, "127.0.0.1");
      await listening;
      proxy = await startQaGatewayRpcProxy({
        backendPort: (server.address() as AddressInfo).port,
        repoRoot: fileURLToPath(new URL("../", import.meta.url)),
        upstreamHeaders: { "x-qa-private": "private-header-marker" },
        captureReadiness,
      });
      front = new WebSocket(proxy.url);
      await acquireGatewayTestWebSocket(front, 5000);
      const proxyURL = proxy.url;
      await body({
        proxy,
        front,
        upstream: upstream.promise,
        upgrade: upgrade.promise,
        reconnect: async () => {
          if (front) await closeGatewayTestWebSocket(front);
          nextUpstream = createDeferred<WebSocket>();
          front = new WebSocket(proxyURL);
          await acquireGatewayTestWebSocket(front, 5000);
          return { front, upstream: nextUpstream.promise };
        },
      });
    },
    async () => {
      if (front) {
        await closeGatewayTestWebSocket(front);
      }
    },
    async () => {
      if (proxy) {
        await proxy.stop();
      }
    },
    async () => {
      await Promise.all([...peers].map(closeGatewayTestWebSocket));
      await Promise.all(
        [...sockets].map(async (socket) => {
          const closed = once(socket, "close");
          socket.destroy();
          await closed;
        }),
      );
      await new Promise<void>((resolve) => {
        backend.close(() => resolve());
      });
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
}

function expectTraceOrder(trace: ReturnType<Proxy["snapshot"]>["firstConnection"], tags: string[]) {
  let previous = -1;
  for (const tag of tags) {
    const index = trace.findIndex((entry) => entry.tag === tag);
    expect(index, tag).toBeGreaterThan(previous);
    previous = index;
  }
}

describe("QA Gateway proxy first-connection diagnostics", () => {
  it("relays challenge and connect bytes unchanged", async () => {
    await withProxy(false, async ({ proxy, front, upstream }) => {
      const back = await upstream;
      const challenge = Buffer.from(
        '{"type":"event", "event":"connect.challenge","payload":{"nonce":"private-nonce-marker"}}',
      );
      const challengeReceived = once(front, "message");
      back.send(challenge);
      expect((await challengeReceived)[0]).toEqual(challenge);

      const connect = Buffer.from(
        '{"type":"req", "id":"fixture","method":"connect","params":{"private":"private-payload-marker"}}',
      );
      const connectReceived = once(back, "message");
      front.send(connect);
      expect((await connectReceived)[0]).toEqual(connect);
      expect(proxy.snapshot().events).toContainEqual(
        expect.objectContaining({ kind: "connect-request", connection: 1 }),
      );
      const trace = proxy.snapshot().firstConnection;
      expectTraceOrder(trace, [
        "upstream-create-start",
        "upstream-create-return",
        "upstream-upgrade",
        "upstream-open",
      ]);
      expect(JSON.stringify(trace)).not.toContain("private-");
      expect(proxy.readinessSnapshot()).toEqual({ truncated: false, connections: [] });
    });
  });

  it("attributes pending-upgrade abort errors to the first local frontend-close termination", async () => {
    await withProxy(true, async ({ proxy, front, upgrade }) => {
      const socket = await upgrade;
      const upstreamClosed = once(socket, "close");
      await closeGatewayTestWebSocket(front);
      await upstreamClosed;
      await proxy.stop();

      const trace = proxy.snapshot().firstConnection;
      expect(trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tag: "upstream-terminate",
            state: "CONNECTING",
            localTermination: "front-close",
          }),
          expect.objectContaining({
            tag: "upstream-error",
            localTermination: "front-close",
            errorCode: "none",
          }),
        ]),
      );
      expectTraceOrder(trace, [
        "upstream-create-start",
        "upstream-create-return",
        "front-close",
        "upstream-terminate",
        "upstream-error",
      ]);
      expect(trace).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ tag: "upstream-upgrade" })]),
      );
      expect(trace.filter(({ tag }) => tag.endsWith("-terminate"))).toHaveLength(2);
    });
  });

  it("records an independent upstream failure before local frontend termination", async () => {
    await withProxy(true, async ({ proxy, front, upgrade }) => {
      const socket = await upgrade;
      expect(front.readyState).toBe(WebSocket.OPEN);
      const frontendClosed = once(front, "close");
      const upstreamClosed = once(socket, "close");
      socket.destroy();
      await Promise.all([frontendClosed, upstreamClosed]);
      await proxy.stop();

      const trace = proxy.snapshot().firstConnection;
      expect(trace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tag: "upstream-error",
            localTermination: "none",
            errorCode: "ECONNRESET",
          }),
          expect.objectContaining({
            tag: "front-terminate",
            state: "OPEN",
            localTermination: "upstream-error",
          }),
        ]),
      );
      expectTraceOrder(trace, ["upstream-create-return", "upstream-error", "front-terminate"]);
      expect(trace.filter(({ tag }) => tag.endsWith("-terminate"))).toHaveLength(2);
      expect(trace.length).toBeLessThanOrEqual(16);
      for (const entry of trace) {
        expect(Object.keys(entry)).toEqual(expect.arrayContaining(["elapsedMs", "tag"]));
        expect(
          Object.keys(entry).every((key) =>
            ["tag", "elapsedMs", "state", "localTermination", "errorCode"].includes(key),
          ),
        ).toBe(true);
      }
      const evidence = JSON.stringify(trace);
      expect(evidence).not.toMatch(/private-|127\.0\.0\.1|socket hang up|Error:/);
    });
  });
});

describe("QA Gateway proxy readiness diagnostics", () => {
  async function exchange(
    front: WebSocket,
    back: WebSocket,
    ordinal: number,
    method: string,
    ok: boolean,
  ) {
    const id = `private-request-${ordinal}`;
    const request = Buffer.from(
      JSON.stringify({
        type: "req",
        id,
        method,
        expectedProfileId: "private-profile",
        params: { token: "private-token" },
      }),
    );
    const received = once(back, "message");
    front.send(request);
    expect((await received)[0]).toEqual(request);
    const response = Buffer.from(
      JSON.stringify({
        type: "res",
        id,
        ok,
        payload: { token: "private-response" },
        error: {
          code: "private-code",
          message: "private-message",
          details: { url: "https://private.example" },
        },
      }),
    );
    const returned = once(front, "message");
    back.send(response);
    expect((await returned)[0]).toEqual(response);
  }

  it("retains pairing-retry requests and a pending method without private wire data", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream, reconnect }) => {
        await exchange(front, await upstream, 1, "connect", false);
        const second = await reconnect();
        const back = await second.upstream;
        await exchange(second.front, back, 2, "connect", true);
        await exchange(second.front, back, 3, "users.self", true);
        const received = once(back, "message");
        second.front.send(
          JSON.stringify({ type: "req", id: "private-pending", method: "chat.history" }),
        );
        await received;
        await expect
          .poll(() => proxy.readinessSnapshot().connections[1]?.requests[1]?.frontWrite?.outcome)
          .toBe("ok");
        await closeGatewayTestWebSocket(second.front);
        await proxy.stop();
        const snapshot = proxy.readinessSnapshot();
        expect(snapshot.truncated).toBe(false);
        expect(snapshot.connections.map(({ connection }) => connection)).toEqual([1, 2]);
        expect(snapshot.connections[0].requests[0]).toMatchObject({
          ordinal: 1,
          method: "connect",
          response: { outcome: "error", code: "other" },
          upstreamWrite: { outcome: "ok" },
          frontWrite: { outcome: "ok" },
        });
        expect(snapshot.connections[1].requests).toEqual([
          expect.objectContaining({
            ordinal: 1,
            method: "connect",
            response: expect.objectContaining({ outcome: "ok", code: "none" }),
          }),
          expect.objectContaining({
            ordinal: 2,
            method: "users.self",
            response: expect.objectContaining({ outcome: "ok", code: "none" }),
          }),
          expect.objectContaining({
            ordinal: 3,
            method: "chat.history",
            upstreamWrite: expect.objectContaining({ outcome: "ok" }),
          }),
        ]);
        expect(snapshot.connections[1].requests[2].response).toBeUndefined();
        expect(snapshot.connections[1].lifecycle).toContainEqual(
          expect.objectContaining({ tag: "front-close" }),
        );
        expect(JSON.stringify(snapshot)).not.toMatch(
          /private|127\.0\.0\.1|requestId|profileId|token|payload|https:/,
        );
        snapshot.connections[0].requests[0].response!.code = "none";
        snapshot.connections[1].lifecycle[0].elapsedMs = -1;
        expect(proxy.readinessSnapshot().connections[0].requests[0].response?.code).toBe("other");
        expect(
          proxy.readinessSnapshot().connections[1].lifecycle[0].elapsedMs,
        ).toBeGreaterThanOrEqual(0);
      },
      true,
    );
  });

  it("distinguishes queued requests from an upstream write attempt", async () => {
    await withProxy(
      true,
      async ({ proxy, front, upgrade }) => {
        await upgrade;
        front.send(JSON.stringify({ type: "req", id: "private-queued", method: "users.self" }));
        await expect.poll(() => proxy.readinessSnapshot().connections[0]?.requests.length).toBe(1);
        const request = proxy.readinessSnapshot().connections[0].requests[0];
        expect(request.queued).toBe(true);
        expect(request.upstreamStartedMs).toBeUndefined();
        expect(request.upstreamWrite).toBeUndefined();
        expect(request.response).toBeUndefined();
      },
      true,
    );
  });

  it("caps connections and requests without dropping forwarded bytes or clearing saturation", async () => {
    await withProxy(
      false,
      async ({ proxy, front, upstream, reconnect }) => {
        let pair = { front, upstream };
        for (let connection = 1; connection <= 5; connection++) {
          const back = await pair.upstream;
          for (let request = 1; request <= 34; request++) {
            await exchange(pair.front, back, request, "health", true);
          }
          if (connection < 5) pair = await reconnect();
        }
        await closeGatewayTestWebSocket(pair.front);
        await proxy.stop();
        const snapshot = proxy.readinessSnapshot();
        expect(snapshot.truncated).toBe(true);
        expect(snapshot.connections).toHaveLength(4);
        for (const connection of snapshot.connections) {
          expect(connection.truncated).toBe(true);
          expect(connection.requests).toHaveLength(32);
          expect(connection.lifecycle.length).toBeLessThanOrEqual(16);
          expect(connection.requests.every(({ response }) => response?.outcome === "ok")).toBe(
            true,
          );
        }
        expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(64 * 1024);
        expect(proxy.snapshot().events).toEqual([]);
        expect(proxy.readinessSnapshot().truncated).toBe(true);
      },
      true,
    );
  });
});
