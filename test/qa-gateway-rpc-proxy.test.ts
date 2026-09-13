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
    backend: WebSocketServer;
  }) => Promise<void>,
) {
  const server = createServer();
  const sockets = new Set<Duplex>();
  const peers = new Set<WebSocket>();
  const backend = new WebSocketServer({ noServer: true });
  const upgrade = createDeferred<Duplex>();
  const upstream = createDeferred<WebSocket>();
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
        backend.emit("connection", ws, request);
        upstream.resolve(ws);
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
      });
      front = new WebSocket(proxy.url);
      await acquireGatewayTestWebSocket(front, 5000);
      await body({ proxy, front, upstream: upstream.promise, upgrade: upgrade.promise, backend });
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
  it("relays allowlisted requests unchanged and exposes only bounded public facts", async () => {
    await withProxy(false, async ({ proxy, front, upstream }) => {
      const back = await upstream;
      const methods = [
        "users.self",
        "agents.list",
        "sessions.messages.subscribe",
        "chat.history",
        "sessions.branches.list",
        "health",
        "sessions.list",
        "sessions.patch",
        "models.list",
      ];
      expect(proxy.snapshot().readiness).toBeUndefined();
      proxy.startReadinessDiagnostics();
      for (const [index, method] of [...methods, "private-method-marker"].entries()) {
        const request = Buffer.from(
          JSON.stringify({
            type: "req",
            id: `private-id-${index}`,
            method,
            params: { value: "private-payload-marker" },
          }),
        );
        const requestReceived = once(back, "message");
        front.send(request);
        expect((await requestReceived)[0]).toEqual(request);
        const response = Buffer.from(
          JSON.stringify({
            type: "res",
            id: `private-id-${index}`,
            ok: index % 2 === 0,
            payload: { value: "private-response-marker" },
            error: { message: "private-error-marker" },
          }),
        );
        const responseReceived = once(front, "message");
        back.send(response);
        expect((await responseReceived)[0]).toEqual(response);
      }
      const snapshot = proxy.snapshot();
      expect(snapshot.events).toEqual([]);
      expect(snapshot.readiness).toEqual({
        connectionOrdinal: 1,
        replacements: 0,
        frontClosed: false,
        upstreamClosed: false,
        frozen: false,
        requestsSeen: 9,
        responsesRecorded: 9,
        truncated: false,
        requests: methods.map((method, index) => ({
          ordinal: index + 1,
          method,
          requestedAtMs: expect.any(Number),
          respondedAtMs: expect.any(Number),
          ok: index % 2 === 0,
        })),
      });
      const requests = snapshot.readiness!.requests;
      for (const [index, request] of requests.entries()) {
        expect(request.requestedAtMs).toBeGreaterThanOrEqual(
          requests[index - 1]?.requestedAtMs ?? 0,
        );
        expect(request.respondedAtMs).toBeGreaterThanOrEqual(request.requestedAtMs);
      }
      expect(JSON.stringify(snapshot.readiness)).not.toMatch(/private-|127\.0\.0\.1|Error:/);
    });
  });

  it("caps records without stopping relay and freezes late responses outside the window", async () => {
    await withProxy(false, async ({ proxy, front, upstream }) => {
      const back = await upstream;
      proxy.startReadinessDiagnostics();
      for (let index = 0; index < 35; index += 1) {
        const received = once(back, "message");
        front.send(JSON.stringify({ type: "req", id: `request-${index}`, method: "health" }));
        await received;
      }
      for (const id of ["request-34", "request-0"]) {
        const received = once(front, "message");
        back.send(JSON.stringify({ type: "res", id, ok: true }));
        await received;
      }
      const before = proxy.snapshot();
      expect(before.events).toEqual([]);
      expect(before.readiness).toMatchObject({
        requestsSeen: 35,
        responsesRecorded: 1,
        truncated: true,
        frozen: false,
      });
      expect(before.readiness!.requests).toHaveLength(32);
      expect(before.readiness!.requests[0]).toMatchObject({ ordinal: 1, ok: true });
      expect(before.readiness!.requests[1]).not.toHaveProperty("ok");
      proxy.freezeReadinessDiagnostics();
      const frozen = proxy.snapshot().readiness;
      expect(frozen!.frozen).toBe(true);
      const late = once(front, "message");
      back.send(JSON.stringify({ type: "res", id: "request-1", ok: false }));
      await late;
      expect(proxy.snapshot().readiness).toEqual(frozen);
      expect(before.readiness!.frozen).toBe(false);
      await closeGatewayTestWebSocket(front);
      await proxy.stop();
      expect(proxy.snapshot().readiness).toEqual(frozen);
    });
  });

  it("replaces the connection snapshot without mixing old responses or close state", async () => {
    await withProxy(false, async ({ proxy, front, upstream, backend }) => {
      const back = await upstream;
      proxy.startReadinessDiagnostics();
      const original = once(back, "message");
      front.send(JSON.stringify({ type: "req", id: "same-id", method: "chat.history" }));
      await original;
      const first = proxy.snapshot().readiness;
      const next = once(backend, "connection");
      const replacement = new WebSocket(proxy.url);
      try {
        await acquireGatewayTestWebSocket(replacement, 5000);
        const [replacementBack] = (await next) as [WebSocket];
        const received = once(replacementBack, "message");
        replacement.send(JSON.stringify({ type: "req", id: "same-id", method: "health" }));
        await received;
        const oldResponse = once(front, "message");
        back.send(JSON.stringify({ type: "res", id: "same-id", ok: false }));
        await oldResponse;
        await closeGatewayTestWebSocket(front);
        expect(proxy.snapshot().readiness).toMatchObject({
          connectionOrdinal: 2,
          replacements: 1,
          frontClosed: false,
          upstreamClosed: false,
          requestsSeen: 1,
          responsesRecorded: 0,
          requests: [{ ordinal: 1, method: "health", requestedAtMs: expect.any(Number) }],
        });
        const response = once(replacement, "message");
        replacementBack.send(JSON.stringify({ type: "res", id: "same-id", ok: true }));
        await response;
        expect(proxy.snapshot().readiness!.requests[0]).toMatchObject({ ok: true });
        expect(first!.requests[0]).not.toHaveProperty("ok");
        await closeGatewayTestWebSocket(replacement);
        await proxy.stop();
        expect(proxy.snapshot().readiness).toMatchObject({
          frontClosed: true,
          upstreamClosed: true,
        });
      } finally {
        await closeGatewayTestWebSocket(replacement);
      }
    });
  });
});
