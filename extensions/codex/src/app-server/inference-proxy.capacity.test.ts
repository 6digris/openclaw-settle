import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { createServer, request, type IncomingMessage } from "node:http";
import { createConnection } from "node:net";
import { zstdCompressSync } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  type ClientOptions,
  WebSocket,
  WebSocketServer,
} from "openclaw/plugin-sdk/websocket-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { createCodexInferenceProxy, type CodexInferenceProxy } from "./inference-proxy.js";

const transport = vi.hoisted(() => ({
  upstream: "",
  fetch: vi.fn(),
  resolve: vi.fn(),
  downstreams: [] as WebSocket[],
  remotes: [] as WebSocket[],
  servers: [] as ReturnType<typeof createServer>[],
  decompressions: undefined as (() => void)[] | undefined,
  decompressionStarted: undefined as (() => void) | undefined,
}));
vi.mock("node:zlib", async (original) => {
  const actual = await original<typeof import("node:zlib")>();
  return {
    ...actual,
    zstdDecompress(...args: Parameters<typeof actual.zstdDecompress>) {
      if (transport.decompressions) {
        transport.decompressions.push(() => actual.zstdDecompress(...args));
        transport.decompressionStarted?.();
      } else {
        actual.zstdDecompress(...args);
      }
    },
  };
});
vi.mock("node:http", async (original) => {
  const actual = await original<typeof import("node:http")>();
  return {
    ...actual,
    createServer: (...args: Parameters<typeof createServer>) => {
      const server = actual.createServer(...args);
      transport.servers.push(server);
      return server;
    },
  };
});
vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({ createNodeProxyAgent: () => undefined }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: transport.fetch,
  isBlockedHostnameOrIp: () => false,
  resolvePinnedHostnameWithPolicy: transport.resolve,
}));
vi.mock("openclaw/plugin-sdk/websocket-runtime", async (original) => {
  const actual = await original<typeof import("openclaw/plugin-sdk/websocket-runtime")>();
  return {
    ...actual,
    WebSocketServer: class extends actual.WebSocketServer {
      override handleUpgrade(
        ...[incomingRequest, socket, head, callback]: Parameters<
          InstanceType<typeof actual.WebSocketServer>["handleUpgrade"]
        >
      ) {
        super.handleUpgrade(incomingRequest, socket, head, (client, incoming) => {
          if (this.options.noServer) {
            transport.downstreams.push(client);
          }
          callback(client, incoming);
        });
      }
    },
    WebSocket: class extends actual.WebSocket {
      constructor(url: string | URL, options?: ClientOptions) {
        super(String(url).startsWith("wss:") ? transport.upstream : url, options);
        if (String(url).startsWith("wss:")) {
          transport.remotes.push(this);
        }
      }
    },
  };
});

const completed = '{"type":"response.completed","response":{"id":"synthetic"}}';
const prewarm = {
  type: "response.create",
  generate: false,
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({ thread_id: "fixture", request_kind: "prewarm" }),
  },
};
const child = {
  type: "response.create",
  client_metadata: {
    "x-codex-turn-metadata": JSON.stringify({
      thread_id: "child",
      parent_thread_id: "parent",
      request_kind: "turn",
    }),
  },
};
let proxy: CodexInferenceProxy;
let server: ReturnType<typeof createServer>;
let wss: WebSocketServer;
let upstreams: WebSocket[];
let clients: WebSocket[];

beforeEach(async () => {
  upstreams = [];
  transport.downstreams = [];
  transport.remotes = [];
  transport.servers = [];
  transport.decompressions = undefined;
  transport.decompressionStarted = undefined;
  clients = [];
  transport.resolve.mockReset().mockResolvedValue({ lookup: undefined });
  transport.fetch.mockReset().mockImplementation(async (args) => {
    await new Response(args.init.body).arrayBuffer();
    return {
      response: new Response("synthetic HTTP response"),
      release: async () => {},
    };
  });
  server = createServer();
  wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => upstreams.push(socket));
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture did not listen");
  }
  transport.upstream = "ws://127.0.0.1:" + address.port;
  proxy = await createCodexInferenceProxy({
    upstream: new URL("https://api.openai.com/v1"),
    assertCurrent: () => {},
  });
});
afterEach(async () => {
  vi.useRealTimers();
  const blocked = transport.decompressions;
  transport.decompressions = undefined;
  for (const finish of blocked ?? []) {
    finish();
  }
  for (const client of clients) {
    client.terminate();
  }
  proxy.close();
  for (const socket of wss.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve) => {
    wss.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

function connect() {
  const client = new WebSocket(proxy.baseUrl.replace("http:", "ws:") + "/responses");
  client.on("error", () => {});
  clients.push(client);
  return client;
}
async function open() {
  const client = connect();
  await once(client, "open");
  const upstream = upstreams.at(-1);
  if (!upstream) {
    throw new Error("fixture did not accept its upstream");
  }
  const remote = transport.remotes.at(-1);
  assert(remote);
  return { client, upstream, remote };
}
async function send(client: WebSocket, upstream: WebSocket, body = child) {
  const received = once(upstream, "message");
  client.send(JSON.stringify(body));
  await received;
}
async function complete(client: WebSocket, upstream: WebSocket, frame = completed) {
  const received = once(client, "message");
  upstream.send(frame);
  expect((await received)[0].toString()).toBe(frame);
}
async function post(signal?: AbortSignal, compressed = false) {
  return await new Promise<{ status?: number; retryAfter?: string; body: string }>(
    (resolve, reject) => {
      const req = request(
        proxy.baseUrl + "/responses",
        {
          method: "POST",
          agent: false,
          signal,
          ...(compressed ? { headers: { "content-encoding": "zstd" } } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              retryAfter: res.headers["retry-after"],
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      req.on("error", reject);
      const bytes = Buffer.from(JSON.stringify(child));
      req.end(compressed ? zstdCompressSync(bytes) : bytes);
    },
  );
}

function relayServer() {
  const relay = transport.servers.at(-1);
  assert(relay);
  return relay;
}

async function holdUploads() {
  const streams = [];
  for (let index = 0; index < 16; index++) {
    const stream = await open();
    const nativeSend = stream.remote.send.bind(stream.remote);
    const drained = createDeferred<() => void>();
    vi.spyOn(stream.remote, "send").mockImplementation((data, options, callback) => {
      nativeSend(data, options, (error) => {
        drained.resolve(() => callback?.(error));
      });
    });
    await send(stream.client, stream.upstream);
    const releaseUpload = await drained.promise;
    streams.push({ ...stream, releaseUpload });
  }
  return streams;
}

function holdHttpResponses() {
  const arrived = new EventEmitter();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  transport.fetch.mockImplementation(async (args) => {
    await new Response(args.init.body).arrayBuffer();
    return {
      response: new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
            controller.enqueue(new TextEncoder().encode("synthetic delta"));
            arrived.emit("request");
          },
        }),
      ),
      release: async () => {},
    };
  });
  return {
    streams,
    async waitFor(count: number) {
      while (streams.length < count) {
        await once(arrived, "request");
      }
    },
  };
}

describe("inference relay capacity", () => {
  it("admits new root, child and HTTP fallback after 16 completed prewarm connections", async () => {
    for (let index = 0; index < 16; index++) {
      const { client, upstream } = await open();
      await send(client, upstream, prewarm);
      await complete(client, upstream);
    }
    expect((await post()).status).toBe(200);
    const { client, upstream } = await open();
    const registration = proxy.context.register({
      threadId: "root",
      text: "synthetic persona",
      signal: new AbortController().signal,
      assertCurrent: () => {},
    });
    await send(client, upstream, {
      type: "response.create",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({
          thread_id: "root",
          request_kind: "turn",
          [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
        }),
      },
    });
    await complete(client, upstream);
    const childStream = await open();
    await send(childStream.client, childStream.upstream);
    await complete(childStream.client, childStream.upstream);
    expect(clients.every((socket) => socket.readyState === WebSocket.OPEN)).toBe(true);
  });

  it("starts another inference and HTTP fallback while 16 responses are still active", async () => {
    const streams = [];
    for (let index = 0; index < 16; index++) {
      const stream = await open();
      await send(stream.client, stream.upstream);
      streams.push(stream);
    }
    const next = await open();
    await send(next.client, next.upstream, prewarm);
    expect((await post()).status).toBe(200);
    expect(streams.every(({ client }) => client.readyState === WebSocket.OPEN)).toBe(true);
    expect(upstreams).toHaveLength(17);
    // No terminal has been sent for the first batch when the next request arrives.
    for (const stream of [...streams, next]) {
      await complete(stream.client, stream.upstream);
    }
  });

  it("starts a WebSocket request while 16 HTTP responses are still streaming", async () => {
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const admitted = createDeferred<void>();
    transport.fetch.mockImplementation(async (args) => {
      await new Response(args.init.body).arrayBuffer();
      return {
        response: new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push(controller);
              if (streams.length === 16) {
                admitted.resolve();
              }
              controller.enqueue(new TextEncoder().encode("synthetic HTTP delta"));
            },
          }),
        ),
        release: async () => {},
      };
    });
    const responses = Array.from({ length: 16 }, () => post());
    await admitted.promise;
    const next = await open();
    await send(next.client, next.upstream);
    await complete(next.client, next.upstream);
    for (const stream of streams) {
      stream.close();
    }
    expect((await Promise.all(responses)).every((response) => response.status === 200)).toBe(true);
  });

  it("reclaims the oldest idle transport immediately when its pool is full", async () => {
    for (let index = 0; index < 64; index++) {
      const stream = await open();
      await send(stream.client, stream.upstream, prewarm);
      await complete(stream.client, stream.upstream);
    }
    const oldest = clients[0];
    assert(oldest);
    const closed = once(oldest, "close");
    const replacement = await open();
    await closed;
    await send(replacement.client, replacement.upstream);
    await complete(replacement.client, replacement.upstream);
    expect(clients.slice(1).every((client) => client.readyState === WebSocket.OPEN)).toBe(true);
    expect((await post()).status).toBe(200);
  });

  it("reclaims completed WebSockets for HTTP pressure without a 16-response bottleneck", async () => {
    for (let index = 0; index < 64; index++) {
      const stream = await open();
      await send(stream.client, stream.upstream, prewarm);
      await complete(stream.client, stream.upstream);
    }
    const http = holdHttpResponses();
    const responses = Array.from({ length: 16 }, () => post());
    await http.waitFor(16);
    const closed = once(clients[0]!, "close");
    responses.push(post());
    await Promise.all([closed, http.waitFor(17)]);
    expect(clients.slice(1).every((client) => client.readyState === WebSocket.OPEN)).toBe(true);
    for (const stream of http.streams) {
      stream.close();
    }
    expect((await Promise.all(responses)).every(({ status }) => status === 200)).toBe(true);
  });

  it("keeps a new handshake until its first response completes under resident pressure", async () => {
    for (let index = 0; index < 63; index++) {
      const stream = await open();
      await send(stream.client, stream.upstream);
    }
    const http = holdHttpResponses();
    const responses = Array.from({ length: 16 }, () => post());
    await http.waitFor(16);
    const resolving = createDeferred<void>();
    const dns = createDeferred<{ lookup: undefined }>();
    transport.resolve.mockImplementationOnce(() => {
      resolving.resolve();
      return dns.promise;
    });
    const fresh = connect();
    const opened = once(fresh, "open");
    await resolving.promise;
    const incoming = once(relayServer(), "request");
    responses.push(post());
    await incoming;
    dns.resolve({ lookup: undefined });
    await opened;
    const upstream = upstreams.at(-1)!;
    await send(fresh, upstream);
    expect(fresh.readyState).toBe(WebSocket.OPEN);
    const closed = once(fresh, "close");
    await complete(fresh, upstream);
    await Promise.all([closed, http.waitFor(17)]);
    for (const stream of http.streams) {
      stream.close();
    }
    expect((await Promise.all(responses)).every(({ status }) => status === 200)).toBe(true);
  });

  it("bounds resident HTTP operations at 80 plus 16 waiters and recovers after cancellation", async () => {
    const http = holdHttpResponses();
    const responses = [];
    for (let index = 0; index < 80; index += 16) {
      responses.push(...Array.from({ length: 16 }, () => post()));
      await http.waitFor(responses.length);
    }
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const waiting = [];
    const closed = [];
    for (const controller of controllers) {
      const incoming = once(relayServer(), "request");
      waiting.push(post(controller.signal).catch(() => undefined));
      const [req] = await incoming;
      closed.push(once(req.socket, "close"));
    }
    expect(await post()).toMatchObject({ status: 503, retryAfter: "1" });
    expect(transport.fetch).toHaveBeenCalledTimes(80);
    for (const controller of controllers) {
      controller.abort();
    }
    await Promise.all([...waiting, ...closed]);
    http.streams[0]!.close();
    expect((await responses[0]).status).toBe(200);
    responses.push(post());
    await http.waitFor(81);
    for (const stream of http.streams.slice(1)) {
      stream.close();
    }
    expect((await Promise.all(responses)).every(({ status }) => status === 200)).toBe(true);
  });

  it("charges pipelined HTTP operations independently on a shared downstream socket", async () => {
    const http = holdHttpResponses();
    const responses = [];
    for (let index = 0; index < 79; index += 16) {
      responses.push(...Array.from({ length: Math.min(16, 79 - index) }, () => post()));
      await http.waitFor(responses.length);
    }
    const target = new URL(proxy.baseUrl + "/responses");
    const socket = createConnection({ host: target.hostname, port: Number(target.port) });
    socket.on("error", () => {});
    await once(socket, "connect");
    const body = JSON.stringify(child);
    const wire = `POST ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    let incoming = 0;
    const received = createDeferred<void>();
    relayServer().on("request", () => {
      if (++incoming === 2) {
        received.resolve();
      }
    });
    socket.write(wire + wire);
    await Promise.all([received.promise, http.waitFor(80)]);
    expect(transport.fetch).toHaveBeenCalledTimes(80);
    http.streams[0]!.close();
    await responses[0];
    await http.waitFor(81);
    for (const stream of http.streams.slice(1, 79)) {
      stream.close();
    }
    expect((await Promise.all(responses)).every(({ status }) => status === 200)).toBe(true);
    const closed = once(socket, "close");
    socket.destroy();
    await closed;
  });

  it("cancels every fully read pipelined request when its shared socket closes", async () => {
    const started = createDeferred<void>();
    const released = createDeferred<void>();
    const signals: AbortSignal[] = [];
    let releaseCount = 0;
    transport.fetch.mockImplementation(async (args) => {
      await new Response(args.init.body).arrayBuffer();
      signals.push(args.signal);
      if (signals.length === 2) {
        started.resolve();
      }
      return {
        response: new Response(new ReadableStream<Uint8Array>()),
        release: async () => {
          if (++releaseCount === 2) {
            released.resolve();
          }
        },
      };
    });
    const incoming: IncomingMessage[] = [];
    relayServer().on("request", (req) => incoming.push(req));
    const target = new URL(proxy.baseUrl + "/responses");
    const socket = createConnection({ host: target.hostname, port: Number(target.port) });
    socket.on("error", () => {});
    await once(socket, "connect");
    const body = JSON.stringify(child);
    const wire = `POST ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    socket.write(wire + wire);
    await started.promise;
    expect(incoming).toHaveLength(2);
    expect(incoming.every((req) => req.complete && req.readableEnded)).toBe(true);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    const closed = once(incoming[0]!.socket, "close");
    socket.destroy();
    await closed;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await released.promise;
  });

  it("retains upload admission after early headers until the final body chunk's next pull", async () => {
    const uploads: ReadableStream<Uint8Array>[] = [];
    const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
    const arrived = new EventEmitter();
    transport.fetch.mockImplementation(async (args) => {
      uploads.push(args.init.body);
      arrived.emit("request");
      return {
        response: new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push(controller);
              controller.enqueue(new TextEncoder().encode("early response"));
            },
          }),
        ),
        release: async () => {},
      };
    });
    const responses = Array.from({ length: 16 }, () => post());
    while (uploads.length < 16) {
      await once(arrived, "request");
    }
    const reader = uploads[0]!.getReader();
    expect((await reader.read()).done).toBe(false);
    const incoming = once(relayServer(), "request");
    responses.push(post());
    await incoming;
    expect(transport.fetch).toHaveBeenCalledTimes(16);
    const next = once(arrived, "request");
    expect((await reader.read()).done).toBe(true);
    await next;
    expect(transport.fetch).toHaveBeenCalledTimes(17);
    await Promise.all(uploads.slice(1).map((body) => new Response(body).arrayBuffer()));
    for (const stream of streams) {
      stream.close();
    }
    expect((await Promise.all(responses)).every(({ status }) => status === 200)).toBe(true);
  });

  it("does not evict a completed response until its final frame has drained", async () => {
    const active = await open();
    await send(active.client, active.upstream);
    const downstream = transport.downstreams[0];
    assert(downstream);
    const nativeSend = downstream.send.bind(downstream);
    let drained: (() => void) | undefined;
    vi.spyOn(downstream, "send").mockImplementation((data, options, callback) => {
      nativeSend(data, options, (error) => {
        drained = () => callback?.(error);
      });
    });
    await complete(active.client, active.upstream);
    for (let index = 0; index < 63; index++) {
      const stream = await open();
      await send(stream.client, stream.upstream, prewarm);
      await complete(stream.client, stream.upstream);
    }
    const oldestIdle = clients[1];
    assert(oldestIdle);
    const evicted = Promise.race([
      once(active.client, "close").then(() => "active"),
      once(oldestIdle, "close").then(() => "idle"),
    ]);
    await open();
    expect(await evicted).toBe("idle");
    expect(active.client.readyState).toBe(WebSocket.OPEN);
    expect(drained).toBeTypeOf("function");
    drained?.();
  });

  it("bounds pending handshakes before dialing and drains without leaking permits", async () => {
    const pending: (() => void)[] = [];
    const admitted = createDeferred<void>();
    transport.resolve.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ lookup: undefined }));
          if (pending.length === 16) {
            admitted.resolve();
          }
        }),
    );
    let upgrades = 0;
    const queued = createDeferred<void>();
    relayServer().on("upgrade", () => {
      if (++upgrades === 32) {
        queued.resolve();
      }
    });
    const opened = Array.from({ length: 32 }, () => once(connect(), "open"));
    await admitted.promise;
    await queued.promise;
    const rejected = connect();
    const [, response] = await once(rejected, "unexpected-response");
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      chunks.push(Buffer.from(chunk));
    }
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(JSON.parse(Buffer.concat(chunks).toString())).toMatchObject({
      status: 503,
      error: { code: "inference_relay_busy" },
    });
    expect(upstreams).toHaveLength(0);
    transport.resolve.mockResolvedValue({ lookup: undefined });
    for (const resolve of pending) {
      resolve();
    }
    await Promise.all(opened);
    expect(upstreams).toHaveLength(32);
    expect((await post()).status).toBe(200);
  });

  it("admits 16 uploads and 16 queued frames from one synchronous arrival batch", async () => {
    const streams = [];
    const releases: (() => void)[] = [];
    const busy: number[] = [];
    for (let index = 0; index < 33; index++) {
      const stream = await open();
      const nativeSend = stream.remote.send.bind(stream.remote);
      vi.spyOn(stream.remote, "send").mockImplementation((data, options, callback) => {
        nativeSend(data, options, (error) => releases.push(() => callback?.(error)));
      });
      stream.client.on("message", () => busy.push(index));
      streams.push(stream);
    }
    const first = streams.slice(0, 16).map(({ upstream }) => once(upstream, "message"));
    const second = streams.slice(16, 32).map(({ upstream }) => once(upstream, "message"));
    const rejected = once(streams[32]!.client, "message");
    for (const downstream of transport.downstreams) {
      // Deliver a single event-loop batch at the real WS message boundary.
      downstream.emit("message", Buffer.from(JSON.stringify(child)), false);
    }
    expect(JSON.parse((await rejected)[0].toString())).toMatchObject({ status: 503 });
    await Promise.all(first);
    expect(busy).toEqual([32]);
    expect(releases).toHaveLength(16);
    for (const release of releases.splice(0)) {
      release();
    }
    await Promise.all(second);
    for (const release of releases.splice(0)) {
      release();
    }
  });

  it("keeps a late old send callback from releasing the next frame's upload", async () => {
    const reused = await open();
    const nativeSend = reused.remote.send.bind(reused.remote);
    const callbacks: (() => void)[] = [];
    vi.spyOn(reused.remote, "send").mockImplementation((data, options, callback) => {
      nativeSend(data, options, (error) => callbacks.push(() => callback?.(error)));
    });
    await send(reused.client, reused.upstream);
    await complete(reused.client, reused.upstream);
    await send(reused.client, reused.upstream);
    expect(callbacks).toHaveLength(2);
    // Occupy the other 14 uploads; the same connection currently owns two callbacks.
    const held: (() => void)[] = [];
    for (let index = 0; index < 14; index++) {
      const stream = await open();
      const sendNow = stream.remote.send.bind(stream.remote);
      vi.spyOn(stream.remote, "send").mockImplementation((data, options, callback) => {
        sendNow(data, options, (error) => held.push(() => callback?.(error)));
      });
      await send(stream.client, stream.upstream);
    }
    const firstCallback = callbacks[0]!;
    const received = once(relayServer(), "request");
    const waiting = post();
    await received;
    expect(transport.fetch).not.toHaveBeenCalled();
    firstCallback();
    expect((await waiting).status).toBe(200);
    // An idempotent old callback cannot release the second frame again.
    firstCallback();
    callbacks[1]!();
    for (const release of held) {
      release();
    }
    await complete(reused.client, reused.upstream);
    // Both original leases must be gone; releasing a mutable newer handle would
    // leave the old frame charged and prevent a complete replacement batch.
    for (const stream of await holdUploads()) {
      stream.releaseUpload();
    }
  });

  it("keeps cancelled native decompression charged until its callback settles", async () => {
    const started = createDeferred<void>();
    const jobs: (() => void)[] = [];
    transport.decompressions = jobs;
    transport.decompressionStarted = () => {
      if (jobs.length === 16) {
        started.resolve();
      }
    };
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const closed = [];
    const cancelled = [];
    for (const controller of controllers) {
      const incoming = once(relayServer(), "request");
      cancelled.push(post(controller.signal, true).catch(() => undefined));
      const [req] = await incoming;
      closed.push(once(req.socket, "close"));
    }
    await started.promise;
    for (const controller of controllers) {
      controller.abort();
    }
    await Promise.all([...cancelled, ...closed]);
    const replacements = [];
    for (let index = 0; index < 16; index++) {
      const incoming = once(relayServer(), "request");
      replacements.push(post(undefined, true));
      await incoming;
    }
    // The next request observes the still-full upload queue. Abort cannot cancel
    // a zlib callback already running outside the relay's JavaScript continuation.
    expect((await post()).status).toBe(503);
    expect(jobs).toHaveLength(16);
    transport.decompressions = undefined;
    for (const finish of jobs.splice(0)) {
      finish();
    }
    expect((await Promise.all(replacements)).every(({ status }) => status === 200)).toBe(true);
    expect(transport.fetch).toHaveBeenCalledTimes(16);
  });

  it("expires a queued handshake before native connect timeout without dialing upstream", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await holdUploads();
    const upgrade = once(relayServer(), "upgrade");
    const queued = connect();
    const rejected = once(queued, "unexpected-response");
    await upgrade;
    await vi.advanceTimersByTimeAsync(10_000);
    const [, response] = await rejected;
    response.resume();
    expect(response.statusCode).toBe(503);
    expect(response.headers["retry-after"]).toBe("1");
    expect(transport.resolve).toHaveBeenCalledTimes(16);
    expect(upstreams).toHaveLength(16);
  });

  it("bounds queued HTTP work, cancels waiters, and admits a later request", async () => {
    const streams = await holdUploads();
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const waiting = [];
    const disconnected = [];
    for (const controller of controllers) {
      const received = once(relayServer(), "request");
      waiting.push(post(controller.signal).catch(() => undefined));
      const [incoming] = await received;
      disconnected.push(once(incoming.socket, "close"));
    }
    expect(await post()).toMatchObject({ status: 503, retryAfter: "1" });
    for (const controller of controllers) {
      controller.abort();
    }
    await Promise.all([...waiting, ...disconnected]);
    const first = streams[0];
    assert(first);
    first.releaseUpload();
    expect((await post()).status).toBe(200);
    expect(transport.fetch).toHaveBeenCalledOnce();
  });

  it("cancels a queued handshake on peer FIN before capacity becomes available", async () => {
    const streams = await holdUploads();
    const upgrade = once(relayServer(), "upgrade");
    const queued = connect();
    const [, socket] = await upgrade;
    const ended = once(socket, "end");
    queued.terminate();
    await ended;
    const first = streams[0];
    assert(first);
    first.releaseUpload();
    // HTTP admission is a FIFO barrier after the cancelled handshake's slot.
    expect((await post()).status).toBe(200);
    expect(transport.resolve).toHaveBeenCalledTimes(16);
    expect(socket.destroyed).toBe(true);
  });

  it.each(["generation revoked", "duplicate frame"])(
    "releases queued work after %s without forwarding it or blocking the next frame",
    async (cause) => {
      const stale = await open();
      const next = await open();
      const streams = await holdUploads();
      const registration = proxy.context.register({
        threadId: "root",
        text: "synthetic persona",
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      const staleReceived = once(transport.downstreams[0]!, "message");
      stale.client.send(
        JSON.stringify({
          type: "response.create",
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              thread_id: "root",
              request_kind: "turn",
              [CODEX_INFERENCE_GENERATION_KEY]: registration.generation,
            }),
          },
        }),
      );
      await staleReceived;
      const staleForwarded = vi.fn();
      stale.upstream.on("message", staleForwarded);
      const closed = once(stale.client, "close");
      if (cause === "generation revoked") {
        registration.release();
      } else {
        stale.client.send(JSON.stringify(child));
      }
      await closed;
      const nextReceived = once(transport.downstreams[1]!, "message");
      const forwarded = once(next.upstream, "message");
      next.client.send(JSON.stringify(child));
      await nextReceived;
      const first = streams[0];
      assert(first);
      first.releaseUpload();
      await forwarded;
      expect(staleForwarded).not.toHaveBeenCalled();
      await complete(next.client, next.upstream);
    },
  );

  it("expires admission during DNS and cancels a late dial without leaking the permit", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const started = createDeferred<void>();
    const dns = createDeferred<{ lookup: undefined }>();
    transport.resolve.mockImplementationOnce(() => {
      started.resolve();
      return dns.promise;
    });
    const stalled = connect();
    const closed = new Promise<void>((resolve) => {
      stalled.once("close", () => resolve());
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    await closed;
    dns.resolve({ lookup: undefined });
    const streams = await holdUploads();
    expect(upstreams).toHaveLength(16);
    expect(streams.every(({ client }) => client.readyState === WebSocket.OPEN)).toBe(true);
  });

  it("bounds queued frame bytes and recovers after disconnect", async () => {
    const large = await open();
    const excess = await open();
    const streams = await holdUploads();
    const body = JSON.stringify({ ...child, input: "x".repeat(17 * 1024 * 1024) });
    const received = once(transport.downstreams[0]!, "message");
    large.client.send(body);
    await received;
    const rejected = once(excess.client, "message");
    excess.client.send(body);
    expect(JSON.parse((await rejected)[0].toString())).toMatchObject({ status: 503 });
    const closed = once(transport.downstreams[0]!, "close");
    large.client.terminate();
    await closed;
    const first = streams[0];
    assert(first);
    first.releaseUpload();
    expect((await post()).status).toBe(200);
  });

  it.each(["upgrade", "error body"])(
    "expires a stalled upstream %s and reclaims admission",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const handlers = server.listeners("upgrade");
      server.removeAllListeners("upgrade");
      const received = createDeferred<void>();
      const disconnected = createDeferred<void>();
      server.once("upgrade", (_request, socket) => {
        socket.once("close", () => disconnected.resolve());
        // Raw HTTP-upgrade sockets retain a writable half after peer FIN.
        socket.once("end", () => socket.end());
        socket.on("error", (error) => expect(error).toMatchObject({ code: "ECONNRESET" }));
        if (phase === "error body") {
          socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 1000\r\n\r\nx");
        }
        received.resolve();
      });
      const stalled = connect();
      const closed = new Promise<void>((resolve) => {
        stalled.once("close", () => resolve());
      });
      await received.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all([closed, disconnected.promise]);
      for (const handler of handlers) {
        server.on("upgrade", handler);
      }
      expect(await holdUploads()).toHaveLength(16);
    },
  );

  it("expires only proven idle connections, not active streams, then admits their replacements", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const idle = await open();
    await send(idle.client, idle.upstream, prewarm);
    await complete(idle.client, idle.upstream);
    const active = await open();
    await send(active.client, active.upstream);
    await complete(active.client, active.upstream, '{"type":"response.completed"}');
    await complete(active.client, active.upstream, '{"type":"error","message":"unknown event"}');
    const closed = once(idle.client, "close");
    await vi.advanceTimersByTimeAsync(60_000);
    await closed;
    expect(active.client.readyState).toBe(WebSocket.OPEN);
    await complete(
      active.client,
      active.upstream,
      '{"type":"response.output_text.delta","delta":"alive"}',
    );
    const replacement = await open();
    await send(replacement.client, replacement.upstream);
    await complete(replacement.client, replacement.upstream);
    await complete(active.client, active.upstream);
  });
});
