import { once } from "node:events";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GatewayChatClient } from "../tui/gateway-chat.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "./minimal-gateway.test-helpers.js";

it("advertises task progress through the TUI's explicit WebSocket capability list", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const connected = createDeferred();
    const received = createDeferred<unknown>();
    let client: GatewayChatClient | undefined;
    try {
      server.on("connection", (socket) => {
        sendMinimalGatewayConnectChallenge(socket, "tui-task-progress");
        socket.once("message", (raw) => {
          const frame = parseMinimalGatewayRequestFrame(raw);
          if (frame.type !== "req" || frame.method !== "connect" || !frame.id) {
            connected.reject(new Error("Expected the TUI connect request"));
            return;
          }
          received.resolve(frame.params);
          sendMinimalGatewayResponse(socket, frame.id, buildMinimalGatewayHelloOkPayload());
        });
      });
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a listening TCP WebSocket server");
      }
      const url = `ws://127.0.0.1:${address.port}`;
      client = new GatewayChatClient({ url, deviceAuthScope: url, token: "test-token" });
      client.onConnected = () => connected.resolve();
      client.onConnectError = connected.reject;
      client.start();
      await connected.promise;
      expect(await received.promise).toMatchObject({
        caps: [
          "agent-kind",
          "plugin-approvals",
          "task-progress",
          "task-suggestions",
          "tool-events",
        ],
      });
    } finally {
      await client?.stop();
      await closeMinimalGatewayServer(server);
    }
  });
});
