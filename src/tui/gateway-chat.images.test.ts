import { X509Certificate } from "node:crypto";
import http, { type RequestListener } from "node:http";
import https from "node:https";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import type { SessionWireHistory } from "../cli/session-target.js";
import { GatewayClient, type GatewayClientOptions } from "../gateway/client.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { readImageMetadataFromHeader, resizeToJpeg } from "../media/image-ops.js";
import { GatewayChatClient } from "./gateway-chat.js";
import { TUI_IMAGE_MAX_BYTES } from "./tui-image-data.js";

const sessionKey = "agent:main:images";
const attachmentId = "11111111-1111-4111-8111-111111111111";
const artifactId = `artifact_managed_image_${attachmentId}`;
const managedSource = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/${attachmentId}/full`;
const request = (source: string) => ({ sessionKey, source, signal: new AbortController().signal });

describe("GatewayChatClient image previews", () => {
  const requests: Array<{ url?: string; authorization?: string; edge?: string }> = [];
  let handler: RequestListener;
  const serve: RequestListener = (req, res) => {
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      edge: String(req.headers["x-image-proof"] ?? ""),
    });
    handler(req, res);
  };
  const server = http.createServer(serve);
  const tlsServer = https.createServer({ key: TEST_TLS_KEY_PEM, cert: TEST_TLS_CERT_PEM }, serve);
  let origin: string;
  let tlsOrigin: string;
  let jpeg: Buffer;

  beforeAll(async () => {
    const listen = async (target: http.Server) => {
      await new Promise<void>((resolve) => {
        target.listen(0, "127.0.0.1", resolve);
      });
      const address = target.address();
      if (!address || typeof address === "string") {
        throw new Error("Missing test server address");
      }
      return `127.0.0.1:${address.port}`;
    };
    origin = `ws://${await listen(server)}/gateway`;
    tlsOrigin = `wss://${await listen(tlsServer)}/gateway`;
    jpeg = await resizeToJpeg({
      buffer: createSolidPngBuffer(640, 320, { r: 24, g: 64, b: 128 }),
      maxSide: 640,
      quality: 80,
    });
  });

  beforeEach(() => {
    requests.length = 0;
    vi.spyOn(GatewayClient.prototype, "request").mockResolvedValue({ runtimeConfig: {} });
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(jpeg);
    };
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    for (const target of [server, tlsServer]) {
      target.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        target.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("loads inbound images from the connected subpath, authenticates, and emits a bounded PNG", async () => {
    handler = (req, res) => {
      if (req.headers.authorization !== "Bearer image-password") {
        res.writeHead(401).end();
      } else {
        res.writeHead(200, { "content-type": "image/jpeg" }).end(jpeg);
      }
    };
    const client = new GatewayChatClient({
      url: origin,
      token: "stale-image-token",
      password: "image-password",
      edgeAuthHeaders: { "x-image-proof": "bound-edge-header" },
    });
    const result = await client.loadImage({
      ...request("media://inbound/photo.jpg"),
      agentId: "main",
    });
    expect(result.mimeType).toBe("image/png");
    expect(readImageMetadataFromHeader(Buffer.from(result.data, "base64"))).toEqual({
      width: 300,
      height: 150,
    });
    expect(requests).toHaveLength(2);
    expect(requests.map((entry) => entry.authorization)).toEqual([
      "Bearer stale-image-token",
      "Bearer image-password",
    ]);
    const url = new URL(requests[1]!.url!, "http://localhost");
    expect(url.pathname).toBe("/gateway/__openclaw__/assistant-media");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      source: "media://inbound/photo.jpg",
      sessionKey,
      agentId: "main",
    });
    expect(requests[1]?.edge).toBe("bound-edge-header");
  });

  it.each([
    { wsPath: "/", basePath: "/console", expectedBase: "/console" },
    { wsPath: "/console", basePath: "console/", expectedBase: "/console" },
    { wsPath: "/proxy", basePath: "/console", expectedBase: "/proxy/console" },
    { wsPath: "/proxy/console/", basePath: "/console", expectedBase: "/proxy/console" },
    { wsPath: "/proxy", basePath: "", expectedBase: "/proxy" },
  ])(
    "resolves media mount $basePath through WebSocket path $wsPath",
    async ({ wsPath, basePath, expectedBase }) => {
      const rpc = vi.spyOn(GatewayClient.prototype, "request").mockResolvedValue({
        runtimeConfig: { gateway: { controlUi: { enabled: false, basePath } } },
      });
      const gatewayUrl = new URL(origin);
      gatewayUrl.pathname = wsPath;
      const client = new GatewayChatClient({ url: gatewayUrl.href, token: "media-token" });
      expect((await client.loadImage(request("media://inbound/photo.jpg"))).mimeType).toBe(
        "image/png",
      );
      expect(rpc).toHaveBeenCalledExactlyOnceWith(
        "config.get",
        {},
        { signal: expect.any(AbortSignal) },
      );
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0]!.url!, "http://localhost").pathname).toBe(
        `${expectedBase}/__openclaw__/assistant-media`,
      );
    },
  );

  it("does not guess an image mount when the config owner fails", async () => {
    vi.spyOn(GatewayClient.prototype, "request").mockRejectedValue(new Error("config unavailable"));
    const client = new GatewayChatClient({ url: origin, token: "media-token" });
    await expect(client.loadImage(request("media://inbound/photo.jpg"))).rejects.toThrow(
      "config unavailable",
    );
    expect(requests).toHaveLength(0);
  });

  it("resolves generated images through the selected session and uses only the ticket for HTTP", async () => {
    const rpc = vi.spyOn(GatewayClient.prototype, "request").mockResolvedValue({
      artifact: { id: artifactId, type: "image", sessionKey, download: { mode: "url" } },
      url: `${managedSource}?mediaTicket=synthetic-ticket`,
    });
    const client = new GatewayChatClient({ url: origin, token: "gateway-secret" });
    const result = await client.loadImage({
      ...request(managedSource),
      agentId: "main",
      artifactId,
    });
    expect(result.mimeType).toBe("image/png");
    expect(rpc).toHaveBeenCalledExactlyOnceWith(
      "artifacts.download",
      { sessionKey, agentId: "main", artifactId },
      { signal: expect.any(AbortSignal) },
    );
    expect(requests).toEqual([
      {
        url: `/gateway${managedSource.replace(/\/full$/, "/thumbnail")}?mediaTicket=synthetic-ticket`,
        authorization: undefined,
        edge: "",
      },
    ]);
  });

  it.each([false, true])("carries Home intent to an image read (inbound=%s)", async (inbound) => {
    const key = inbound ? "agent:main:global" : "agent:main:main";
    const source = inbound
      ? "media://inbound/home.jpg"
      : `/api/chat/media/outgoing/global/${attachmentId}/full`;
    if (inbound) {
      handler = (req, res) => {
        const query = new URL(req.url ?? "", "http://localhost").searchParams;
        if (query.get("sessionKey") !== "main" || query.get("agentId") !== "main") {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "image/jpeg" }).end(jpeg);
      };
    }
    const rpc = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method, params) => {
        if (method === "config.get") {
          return { runtimeConfig: {} };
        }
        const target = params as { sessionKey: string };
        if (method === "chat.history") {
          const isHome = target.sessionKey === "main" || target.sessionKey === "agent:main:main";
          return {
            sessionInfo: { key: isHome ? "global" : target.sessionKey },
            sessionId: isHome ? "home-session" : undefined,
          };
        }
        if (method !== "artifacts.download" || target.sessionKey !== "main") {
          throw new Error("Home artifact requires the admitted Home alias");
        }
        return {
          artifact: {
            id: artifactId,
            type: "image",
            sessionKey: "global",
            download: { mode: "url" },
          },
          url: `${source}?mediaTicket=synthetic-home-ticket`,
        };
      });
    const client = new GatewayChatClient({ url: origin, token: "gateway-secret" });
    const selectedImage = {
      ...request(source),
      sessionKey: key,
      targetIntent: "home" as const,
    };
    expect((await client.loadImage(selectedImage)).mimeType).toBe("image/png");
    if (inbound) {
      expect(
        rpc.mock.calls.every(([method]) => method === "config.get" || method === "chat.history"),
      ).toBe(true);
      expect(requests).toHaveLength(1);
      const url = new URL(requests[0]!.url!, "http://localhost");
      expect(Object.fromEntries(url.searchParams)).toEqual({
        source,
        sessionKey: "main",
        agentId: "main",
      });
      return;
    }
    expect(rpc).toHaveBeenLastCalledWith(
      "artifacts.download",
      { sessionKey: "main", agentId: "main", artifactId },
      { signal: expect.any(AbortSignal) },
    );
    expect(requests).toEqual([
      {
        url: `/gateway${source.replace(/\/full$/, "/thumbnail")}?mediaTicket=synthetic-home-ticket`,
        authorization: undefined,
        edge: "",
      },
    ]);
  });

  it("rejects a conflicting Home owner before inbound HTTP starts", async () => {
    const client = new GatewayChatClient({ url: origin, token: "image-token" });
    await expect(
      client.loadImage({
        ...request("media://inbound/home.jpg"),
        sessionKey: "agent:main:global",
        agentId: "other",
        targetIntent: "home",
      }),
    ).rejects.toThrow("Session key does not match the selected agent");
    expect(requests).toHaveLength(0);
  });

  it.each([
    { stage: "initial identity", owner: "caller", inbound: false },
    { stage: "foreign owner", owner: "caller", inbound: false },
    { stage: "reconnect", owner: "caller", inbound: false },
    { stage: "reconnect", owner: "client", inbound: false },
    { stage: "initial identity", owner: "caller", inbound: true },
    { stage: "reconnect", owner: "caller", inbound: true },
    { stage: "reconnect", owner: "client", inbound: true },
    { stage: "reconnect ready", owner: "caller", inbound: true },
  ])(
    "settles an image $stage wait from its $owner (inbound=$inbound)",
    async ({ stage, owner, inbound }) => {
      let options: GatewayClientOptions | undefined;
      const history = createDeferred<SessionWireHistory>();
      const enteredHistory = createDeferred();
      const key = stage === "foreign owner" ? "agent:main:global" : "agent:main:main";
      const rpc = vi.fn(
        async (method: string, params: unknown, requestOptions?: { signal?: AbortSignal }) => {
          if (inbound && method === "config.get") {
            return { runtimeConfig: {} };
          }
          if (method !== "chat.history") {
            throw new Error(`Unexpected request after image cancellation: ${method}`);
          }
          if (stage === "foreign owner") {
            const target = params as { sessionKey: string; agentId?: string };
            if (target.sessionKey === key) {
              return {
                sessionInfo: { key, agentId: "main" },
                sessionId: "selected-image-session",
              };
            }
            if (target.agentId) {
              throw new RequestError({
                code: "INVALID_REQUEST",
                message: 'agent "main" does not match session key agent "ops"',
              });
            }
          }
          enteredHistory.resolve();
          return await (requestOptions?.signal
            ? racePromiseWithAbortSignal(history.promise, requestOptions.signal)
            : history.promise);
        },
      );
      const stop = vi.fn(async () => {});
      vi.resetModules();
      vi.doMock("../gateway/client.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../gateway/client.js")>()),
        GatewayClient: class {
          request = rpc;
          stopAndWait = stop;
          constructor(opts: GatewayClientOptions) {
            options = opts;
          }
        },
      }));
      const { GatewayChatClient: ConnectedClient } = await import("./gateway-chat.js");
      const { GatewayClientRequestError: RequestError } = await import("../gateway/client.js");
      const client = new ConnectedClient({ url: origin, token: "image-token" });
      const hello: HelloOk = {
        type: "hello-ok",
        protocol: 4,
        server: { version: "legacy", connId: "image-cancel" },
        features: { methods: [], events: [] },
        auth: { role: "operator", scopes: ["operator.read"] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
      };
      const controller = new AbortController();
      let failure: unknown;
      options?.onHelloOk?.(hello);
      const image = client
        .loadImage({
          sessionKey: key,
          source: inbound
            ? "media://inbound/photo.jpg"
            : `/api/chat/media/outgoing/${encodeURIComponent(key)}/${attachmentId}/full`,
          signal: controller.signal,
        })
        .catch((error: unknown) => {
          failure = error;
        });
      try {
        await Promise.race([
          enteredHistory.promise,
          image.then(() => {
            throw new Error("Image settled before its identity read", { cause: failure });
          }),
        ]);
        if (stage.startsWith("reconnect")) {
          options?.onClose?.(1001, "reconnecting");
          history.resolve({ sessionInfo: { key }, sessionId: "selected-image-session" });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
        if (stage === "reconnect ready") {
          options?.onHelloOk?.({
            ...hello,
            server: { ...hello.server, connId: "image-reconnected" },
            features: { ...hello.features, capabilities: ["canonical-session-keys"] },
          });
          expect(await image).toMatchObject({ mimeType: "image/png" });
          expect(failure).toBeUndefined();
          expect(requests).toHaveLength(1);
          const query = new URL(requests[0]!.url!, "http://localhost").searchParams;
          expect(query.get("sessionKey")).toBe(key);
          expect(query.has("agentId")).toBe(false);
          expect(rpc.mock.calls.map(([method]) => method)).toEqual(["config.get", "chat.history"]);
          return;
        }
        if (owner === "caller") {
          controller.abort();
        } else {
          await client.stop();
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(failure).toMatchObject({ name: "AbortError" });
        expect(rpc.mock.calls.map(([method]) => method)).toEqual([
          ...(inbound ? ["config.get"] : []),
          ...Array.from({ length: stage === "foreign owner" ? 3 : 1 }, () => "chat.history"),
        ]);
        expect(requests).toHaveLength(0);
        if (owner === "caller") {
          expect(stop).not.toHaveBeenCalled();
        }
      } finally {
        history.resolve({ sessionInfo: { key }, sessionId: "selected-image-session" });
        await client.stop();
        await image;
        vi.doUnmock("../gateway/client.js");
        vi.resetModules();
      }
    },
  );

  it("never follows a redirect carrying Gateway credentials", async () => {
    handler = (_req, res) => res.writeHead(302, { location: "/stolen-credentials" }).end();
    const client = new GatewayChatClient({ url: origin, token: "gateway-secret" });
    await expect(client.loadImage(request("media://inbound/photo.jpg"))).rejects.toThrow("302");
    expect(requests).toHaveLength(1);
  });

  it("renders inline PNGs and rejects excessive header dimensions before decoding", async () => {
    const rpc = vi.spyOn(GatewayClient.prototype, "request");
    const client = new GatewayChatClient({ url: origin });
    const png = createSolidPngBuffer(4, 2, { r: 24, g: 64, b: 128 });
    const inlineRequest = (buffer: Buffer) =>
      request(`data:image/png;base64,${buffer.toString("base64")}`);
    const image = await client.loadImage(inlineRequest(png));
    expect(image.mimeType).toBe("image/png");
    expect(readImageMetadataFromHeader(Buffer.from(image.data, "base64"))).toEqual({
      width: 4,
      height: 2,
    });
    const oversizedHeader = Buffer.from(png);
    oversizedHeader.writeUInt32BE(100_000, 16);
    oversizedHeader.writeUInt32BE(100_000, 20);
    await expect(client.loadImage(inlineRequest(oversizedHeader))).rejects.toThrow("pixel limit");
    expect(requests).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    "https://remote.example/image.png",
    "//remote.example/image.png",
    "file:///tmp/image.png",
    "media://inbound/nested%2Fphoto.png",
    "data:text/plain;base64,SGVsbG8=",
  ])("rejects unsupported source %s without making a request", async (source) => {
    const client = new GatewayChatClient({ url: origin });
    await expect(client.loadImage(request(source))).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });

  it("rejects artifact responses that cross session or origin boundaries", async () => {
    const rpc = vi.spyOn(GatewayClient.prototype, "request");
    const client = new GatewayChatClient({ url: origin });
    for (const url of [
      `https://remote.example${managedSource}`,
      managedSource.replace(
        encodeURIComponent(sessionKey),
        encodeURIComponent("agent:other:images"),
      ),
    ]) {
      rpc.mockResolvedValue({
        artifact: { id: artifactId, type: "image", sessionKey, download: { mode: "url" } },
        url,
      });
      await expect(client.loadImage(request(managedSource))).rejects.toThrow("unavailable");
    }
    expect(requests).toHaveLength(0);
  });

  it("rejects oversized images before reading the response body and honors cancellation", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-length": TUI_IMAGE_MAX_BYTES + 1 });
      res.flushHeaders();
    };
    const client = new GatewayChatClient({ url: origin });
    await expect(client.loadImage(request("media://inbound/photo.jpg"))).rejects.toThrow(
      "byte limit",
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.loadImage({ ...request("media://inbound/photo.jpg"), signal: controller.signal }),
    ).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it("verifies pinned TLS before sending credentials", async () => {
    const valid = new GatewayChatClient({
      url: tlsOrigin,
      token: "tls-image-token",
      tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
    });
    expect((await valid.loadImage(request("media://inbound/photo.jpg"))).mimeType).toBe(
      "image/png",
    );
    expect(requests[0]?.authorization).toBe("Bearer tls-image-token");
    const invalid = new GatewayChatClient({
      url: tlsOrigin,
      token: "must-not-be-sent",
      tlsFingerprint: "ab".repeat(32),
    });
    await expect(invalid.loadImage(request("media://inbound/photo.jpg"))).rejects.toThrow(
      "fingerprint mismatch",
    );
    expect(requests).toHaveLength(1);
  });
});
