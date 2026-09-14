import { once } from "node:events";
import { expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { writeConfigFile } from "../config/config.js";
import { issueDevicePairSetupBootstrapToken } from "../infra/device-bootstrap.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import type { GatewayRequestHandlerOptions as CoreOptions } from "../plugin-sdk/core.js";
import type { GatewayRequestHandlerOptions as RuntimeOptions } from "../plugin-sdk/gateway-runtime.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { loadDeviceIdentity, pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { serializeEventPayload } from "./node-registry.js";
import * as gatewayWsRuntime from "./server-ws-runtime.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import {
  connectOk,
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
} from "./test-helpers.server.js";
import { connectWatchNode, readJson } from "./watch-node-http.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

test("registered SDK V2 handlers retain real WS and authenticated polling nodes without changing wire payloads", async () => {
  const builder = createTestPluginRegistry();
  const record = createPluginRecord({
    id: "transport-v2",
    source: "test",
    origin: "global",
    enabled: true,
    configSchema: true,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const instance = getPluginInstance(record);
  if (!instance) {
    throw new Error("expected managed plugin instance");
  }
  let context: CoreOptions["context"] | undefined;
  let ingress: Parameters<typeof gatewayWsRuntime.attachGatewayWsHandlers>[0] | undefined;
  const physicalSockets = new Set<WebSocket>();
  const inventory = (options: CoreOptions) => {
    context = options.context;
    options.respond(
      true,
      options.context.nodeRegistry
        .listConnected()
        .map((node) => ({
          nodeId: node.nodeId,
          transport: node.client.webSocket
            ? "websocket"
            : node.client.socket
              ? "framed"
              : "polling",
        }))
        .toSorted((a, b) => a.nodeId.localeCompare(b.nodeId)),
    );
  };
  // Both existing SDK imports type the actual registration boundary.
  const runtimeHandler: (options: RuntimeOptions) => void = inventory;
  api.registerGatewayMethod("transportv2.inventory", runtimeHandler, { scope: "operator.read" });
  setTestPluginRegistry(builder.registry);
  const attach = gatewayWsRuntime.attachGatewayWsHandlers;
  const observation = vi
    .spyOn(gatewayWsRuntime, "attachGatewayWsHandlers")
    .mockImplementation((params) => {
      ingress = params;
      params.wss.on("connection", (socket) => physicalSockets.add(socket));
      attach(params);
    });
  let gateway: Awaited<ReturnType<typeof createGatewaySuiteHarness>> | undefined;
  const peers: WebSocket[] = [];
  try {
    await writeConfigFile({
      gateway: {
        nodes: { commands: { allow: ["device.info", "device.status", "system.notify"] } },
      },
    });
    gateway = await createGatewaySuiteHarness({
      serverOptions: { bind: "loopback", auth: { mode: "token", token: "secret" } },
    });
    await gateway.server.startupSettled;
    const operator = await gateway.openWs();
    peers.push(operator);
    await connectOk(operator, { token: "secret", scopes: ["operator.admin"] });
    const paired = await pairDeviceIdentity({
      name: "transport-v2-node",
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
      platform: "linux",
      deviceFamily: "Linux",
    });
    const pairing = await requestNodePairing({
      nodeId: paired.identity.deviceId,
      platform: "linux",
      deviceFamily: "Linux",
      commands: ["device.info"],
      permissions: { accessibility: true },
    });
    await approveNodePairing(pairing.request.requestId, {
      callerScopes: ["operator.pairing", "operator.write"],
    });
    const connectNode = async () => {
      if (!gateway) {
        throw new Error("expected live test Gateway");
      }
      const peer = await gateway.openWs();
      peers.push(peer);
      const response = await connectReq(peer, {
        token: "secret",
        role: "node",
        scopes: [],
        client: {
          id: GATEWAY_CLIENT_NAMES.NODE_HOST,
          version: "dev",
          platform: "linux",
          deviceFamily: "Linux",
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
        commands: ["device.info"],
        permissions: { accessibility: true },
        deviceIdentityPath: paired.identityPath,
        prePairDevice: false,
      });
      expect(response.ok, JSON.stringify(response)).toBe(true);
      expect(response.payload).toMatchObject({ type: "hello-ok", protocol: PROTOCOL_VERSION });
      return peer;
    };
    const peer = await connectNode();
    const watch = loadDeviceIdentity("transport-v2-watch");
    const bootstrap = await issueDevicePairSetupBootstrapToken({
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    const baseUrl = `http://127.0.0.1:${gateway.port}/api/nodes/watch`;
    const watchResponse = await connectWatchNode({
      baseUrl,
      identity: watch.identity,
      bootstrapToken: bootstrap.token,
    });
    expect(watchResponse.status).toBe(200);
    const connected = await readJson(watchResponse);
    expect(connected).toMatchObject({
      ok: true,
      nodeId: watch.identity.deviceId,
      protocol: PROTOCOL_VERSION,
      pollTimeoutMs: 20_000,
    });
    const headers = {
      authorization: `Bearer ${String(connected.sessionToken)}`,
      "content-type": "application/json",
    };
    expect((await fetch(`${baseUrl}/poll`, { method: "POST" })).status).toBe(401);
    const listing = await rpcReq(operator, "transportv2.inventory", {});
    expect(listing).toMatchObject({
      ok: true,
      payload: [
        { nodeId: paired.identity.deviceId, transport: "websocket" },
        { nodeId: watch.identity.deviceId, transport: "polling" },
      ].toSorted((a, b) => a.nodeId.localeCompare(b.nodeId)),
    });
    if (!context || !ingress) {
      throw new Error("expected actual registered-handler context and WS ingress");
    }
    expect(context).toBe(ingress.context);
    const registry = context.nodeRegistry;
    const wsNode = registry.get(paired.identity.deviceId);
    const httpNode = registry.get(watch.identity.deviceId);
    const socket = wsNode?.client.webSocket;
    if (!wsNode || !httpNode || !socket) {
      throw new Error("expected both transports and physical WS capability");
    }
    expect(physicalSockets.has(socket)).toBe(true);
    expect(wsNode.client.socket).toBe(socket);
    expect([...ingress.clients].some((client) => client === wsNode.client)).toBe(true);
    expect(Object.hasOwn(httpNode.client, "socket")).toBe(false);
    expect(Object.hasOwn(httpNode.client, "webSocket")).toBe(false);
    if (!httpNode.pairingIdentity || !httpNode.pairingGeneration) {
      throw new Error("expected authenticated watch pairing");
    }
    const projections = [
      ...registry.listConnected(),
      ...registry.listCurrentConnectedSync(),
      ...(await registry.listCurrentConnected()),
      ...registry.listConnectedForPairingStates(
        new Map([
          [
            httpNode.nodeId,
            {
              identity: httpNode.pairingIdentity,
              generation: httpNode.pairingGeneration,
            },
          ],
        ]),
      ),
      ...registry.refreshRuntimePolicy(),
      await registry.getCurrentConnected(httpNode.nodeId),
      registry.getForPairingGeneration(httpNode.nodeId, httpNode.pairingGeneration),
      registry.updateNodePluginTools(httpNode.nodeId, httpNode.connId, []),
      registry.updateNodeSkills(httpNode.nodeId, httpNode.connId, []),
      registry.updateSurface(httpNode.nodeId, { commands: httpNode.commands }),
    ];
    expect(projections.filter((node) => node === httpNode)).toHaveLength(10);
    expect(projections.filter((node) => node === wsNode)).toHaveLength(4);
    expect(
      registry.updateDesktopAvailability({
        nodeId: httpNode.nodeId,
        connId: httpNode.connId,
        availability: { state: "unlocked" },
      }),
    ).toBeNull();
    // APIs outside the old Pick<ping, once, off> operate on the original socket.
    socket.pause();
    expect(socket.isPaused).toBe(true);
    socket.resume();
    expect(socket.isPaused).toBe(false);
    const pong = once(socket, "pong");
    socket.ping("transport-v2-physical");
    expect((await pong)[0]).toEqual(Buffer.from("transport-v2-physical"));
    await expect(registry.checkConnectivity(wsNode.nodeId)).resolves.toEqual({ ok: true });
    await expect(registry.checkConnectivity(httpNode.nodeId)).resolves.toEqual({ ok: true });
    expect(
      registry.updatePresenceActivity({
        nodeId: wsNode.nodeId,
        connId: wsNode.connId,
        idleSeconds: 0,
      }),
    ).toBe(wsNode);
    expect(registry.getActiveNode()).toBe(wsNode);

    const event = "transport.v2.bytes";
    const payload = { text: 'quote" newline\n 🦀', count: 2 };
    for (const raw of [false, true]) {
      const received = once(peer, "message");
      expect(
        raw
          ? registry.sendEventRaw(wsNode.nodeId, event, serializeEventPayload(payload))
          : registry.sendEvent(wsNode.nodeId, event, payload),
      ).toBe(true);
      expect(String((await received)[0])).toBe(JSON.stringify({ type: "event", event, payload }));
      expect(
        raw
          ? registry.sendEventRaw(httpNode.nodeId, event, serializeEventPayload(payload))
          : registry.sendEvent(httpNode.nodeId, event, payload),
      ).toBe(true);
      expect(await (await fetch(`${baseUrl}/poll`, { method: "POST", headers })).text()).toBe(
        JSON.stringify({ ok: true, event: { event, payload } }),
      );
    }
    // Invoke through authenticated operator dispatch, then reply through each real transport.
    const invocation = rpcReq(operator, "node.invoke", {
      nodeId: httpNode.nodeId,
      command: "device.info",
      params: {},
      idempotencyKey: "transport-v2-poll-invoke",
    });
    const request = await readJson(await fetch(`${baseUrl}/poll`, { method: "POST", headers }));
    expect(request).toMatchObject({
      ok: true,
      event: {
        event: "node.invoke.request",
        payload: { nodeId: httpNode.nodeId, command: "device.info", paramsJSON: "{}" },
      },
    });
    const invokeEvent = request.event;
    if (!invokeEvent || typeof invokeEvent !== "object" || !("payload" in invokeEvent)) {
      throw new Error("expected polling invoke event");
    }
    const invokePayload = invokeEvent.payload;
    if (
      !invokePayload ||
      typeof invokePayload !== "object" ||
      !("id" in invokePayload) ||
      typeof invokePayload.id !== "string"
    ) {
      throw new Error("expected polling invoke id");
    }
    expect(
      await readJson(
        await fetch(`${baseUrl}/result`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: invokePayload.id,
            ok: true,
            payload: { transport: "polling" },
          }),
        }),
      ),
    ).toEqual({ ok: true });
    expect(await invocation).toMatchObject({
      ok: true,
      payload: { payload: { transport: "polling" } },
    });
    const wsRequest = onceMessage<{ type: string; event: string; payload: { id: string } }>(
      peer,
      (frame) => frame.event === "node.invoke.request",
    );
    const wsInvocation = rpcReq(operator, "node.invoke", {
      nodeId: wsNode.nodeId,
      command: "device.info",
      params: {},
      idempotencyKey: "transport-v2-ws-invoke",
    });
    const wsInvoke = await wsRequest;
    expect(
      (
        await rpcReq(peer, "node.invoke.result", {
          id: wsInvoke.payload.id,
          nodeId: wsNode.nodeId,
          ok: true,
          payload: { transport: "websocket" },
        })
      ).ok,
    ).toBe(true);
    expect(await wsInvocation).toMatchObject({
      ok: true,
      payload: { payload: { transport: "websocket" } },
    });

    const replacementResponse = await connectWatchNode({
      baseUrl,
      identity: watch.identity,
      deviceToken: String(connected.deviceToken),
    });
    expect(replacementResponse.status).toBe(200);
    const replacement = await readJson(replacementResponse);
    expect(registry.get(httpNode.nodeId)).not.toBe(httpNode);
    expect((await fetch(`${baseUrl}/poll`, { method: "POST", headers })).status).toBe(401);
    const replacementHeaders = { authorization: `Bearer ${String(replacement.sessionToken)}` };
    expect(registry.sendEvent(httpNode.nodeId, "transport.recovered", { ok: true })).toBe(true);
    expect(
      await readJson(
        await fetch(`${baseUrl}/poll`, { method: "POST", headers: replacementHeaders }),
      ),
    ).toEqual({ ok: true, event: { event: "transport.recovered", payload: { ok: true } } });
    const replacementPeer = await connectNode();
    const replacementWs = registry.get(wsNode.nodeId);
    expect(replacementWs).not.toBe(wsNode);
    expect(replacementWs?.client.webSocket).not.toBe(socket);
    await closeGatewayTestWebSocket(peer);
    expect(registry.get(wsNode.nodeId)).toBe(replacementWs);
    await closeGatewayTestWebSocket(replacementPeer);
    await vi.waitFor(() => expect(registry.get(wsNode.nodeId)).toBeUndefined());
    expect(
      (await fetch(`${baseUrl}/disconnect`, { method: "POST", headers: replacementHeaders }))
        .status,
    ).toBe(200);
    expect(registry.listConnected()).toEqual([]);
    await instance.dispose();
    const retired = builder.registry.gatewayHandlers["transportv2.inventory"];
    if (!retired) {
      throw new Error("expected retained registered handler");
    }
    await expect(
      retired({
        req: { type: "req", id: "retired", method: "transportv2.inventory" },
        params: {},
        client: null,
        context,
        respond: vi.fn(),
        isWebchatConnect: () => false,
      }),
    ).rejects.toThrow(/reloaded or disabled/i);
  } finally {
    await Promise.all(peers.map((peer) => closeGatewayTestWebSocket(peer)));
    await gateway?.server.close({ drainTimeoutMs: 0 });
    await instance.dispose();
    observation.mockRestore();
    resetTestPluginRegistry();
  }
});
