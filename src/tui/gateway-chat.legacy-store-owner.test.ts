import { describe, expect, it, vi } from "vitest";
import { validateChatHistoryParams } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayClient, GatewayClientRequestError } from "../gateway/client.js";
import { resolveRequestedSessionAgentId } from "../gateway/session-request-agent.js";
import { GatewayChatClient } from "./gateway-chat.js";

const ownerConflict = 'agent "research" does not match session key agent "ops"';

describe("GatewayChatClient published fixed-store ownership", () => {
  it.each([
    { sentinel: "global", exists: true },
    { sentinel: "unknown", exists: true },
    { sentinel: "global", exists: false },
    { sentinel: "unknown", exists: false },
  ])("preserves the qualified $sentinel target (exists=$exists)", async ({ sentinel, exists }) => {
    const sessionKey = `agent:research:${sentinel}`;
    const sessionId = exists ? "research-transcript" : undefined;
    const request = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method, params) => {
        if (method === "sessions.list") {
          return { sessions: [], defaults: { model: "research-default" } };
        }
        if (method !== "chat.history") {
          return { ok: true, key: sessionKey, runId: "research-run" };
        }
        if (!validateChatHistoryParams(params)) {
          throw new Error("Expected a valid chat.history request");
        }
        const target = params;
        if (target.sessionKey === sessionKey) {
          return {
            sessionId,
            sessionInfo: { key: sessionKey, agentId: "research" },
            messages: exists ? [{ role: "assistant", content: "research history" }] : [],
          };
        }
        if (target.agentId) {
          throw new GatewayClientRequestError({ code: "INVALID_REQUEST", message: ownerConflict });
        }
        return {
          sessionId: "foreign-transcript",
          sessionInfo: { key: sentinel, agentId: "ops", activeLeafEntryId: "foreign-leaf" },
          messages: [{ role: "assistant", content: "foreign history" }],
        };
      });
    try {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      await expect(client.loadHistory({ sessionKey })).resolves.toEqual({
        sessionKey,
        sessionId,
        sessionInfo: { key: sessionKey, agentId: "research" },
        messages: exists ? [{ role: "assistant", content: "research history" }] : [],
      });
      await expect(client.describeSession({ sessionKey })).resolves.toMatchObject({
        session: exists ? { key: sessionKey, sessionId } : null,
        defaults: { model: "research-default" },
      });
      if (exists) {
        await client.sendChat({ sessionKey, message: "selected research target" });
        expect(request).toHaveBeenLastCalledWith(
          "chat.send",
          expect.objectContaining({ sessionKey, agentId: "research" }),
        );
      } else {
        await client.createSession({ key: sessionKey, agentId: "research" });
        expect(request).toHaveBeenLastCalledWith(
          "sessions.create",
          expect.objectContaining({ key: sessionKey, agentId: "research" }),
        );
      }
      const mutation = request.mock.calls.at(-1)?.[1];
      expect(mutation).not.toHaveProperty("sessionId");
      expect(mutation).not.toHaveProperty("expectedLeafEntryId");
      expect(mutation).not.toHaveProperty("expectedSessionRoutingContract");
    } finally {
      request.mockRestore();
    }
  });

  it.each([
    "forbidden",
    "unrelated invalid request",
    "non-Gateway failure",
    "unconfirmed exact owner",
    "unscoped read failure",
    "missing raw owner",
    "malformed raw owner",
    "same raw owner",
    "uncorroborated raw owner",
    "different raw key",
  ])("preserves %s without dispatching a mutation", async (failure) => {
    const sessionKey = "agent:research:global";
    const selectedError =
      failure === "non-Gateway failure"
        ? new Error(ownerConflict)
        : new GatewayClientRequestError({
            code: failure === "forbidden" ? "FORBIDDEN" : "INVALID_REQUEST",
            message:
              failure === "unrelated invalid request"
                ? "session access denied"
                : failure === "same raw owner"
                  ? 'agent "research" does not match session key agent "research"'
                  : ownerConflict,
          });
    const readError = new GatewayClientRequestError({
      code: "FORBIDDEN",
      message: "raw alias is not visible",
    });
    const request = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method, params) => {
        if (method !== "chat.history") {
          throw new Error("Unexpected mutation");
        }
        if (!validateChatHistoryParams(params)) {
          throw new Error("Expected a valid chat.history request");
        }
        const target = params;
        if (target.sessionKey === sessionKey) {
          return {
            sessionId: "research-transcript",
            sessionInfo: {
              key: sessionKey,
              agentId: failure === "unconfirmed exact owner" ? undefined : "research",
            },
          };
        }
        if (target.agentId) {
          throw selectedError;
        }
        if (failure === "unscoped read failure") {
          throw readError;
        }
        return {
          sessionId: "foreign-transcript",
          sessionInfo: {
            key: failure === "different raw key" ? "agent:ops:global" : "global",
            agentId:
              failure === "missing raw owner"
                ? undefined
                : failure === "malformed raw owner"
                  ? "ops!"
                  : failure === "same raw owner"
                    ? "research"
                    : failure === "uncorroborated raw owner"
                      ? "other"
                      : "ops",
          },
        };
      });
    try {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      await expect(client.sendChat({ sessionKey, message: "must not send" })).rejects.toBe(
        failure === "unscoped read failure" ? readError : selectedError,
      );
      expect(request.mock.calls.every(([method]) => method === "chat.history")).toBe(true);
      if (
        [
          "forbidden",
          "unrelated invalid request",
          "non-Gateway failure",
          "unconfirmed exact owner",
        ].includes(failure)
      ) {
        expect(request.mock.calls).toHaveLength(2);
      }
    } finally {
      request.mockRestore();
    }
  });
});

describe("GatewayChatClient canonical owner constraints", () => {
  it.each(["main", "global", "unknown", "ordinary"])(
    "reads qualified retired %s history without inventing an explicit roster constraint",
    async (rest) => {
      const cfg: OpenClawConfig = {
        session: { scope: "global" },
        agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      };
      const sessionKey = `agent:retired:${rest}`;
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (_method, params) => {
          if (!validateChatHistoryParams(params)) {
            throw new Error("Expected a valid chat.history request");
          }
          const target = params;
          const owner = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
          if (!owner.ok) {
            throw new GatewayClientRequestError(owner.error);
          }
          return {
            sessionId: "retained-transcript",
            sessionInfo: { key: sessionKey, agentId: owner.agentId },
            messages: [],
          };
        });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        client.hello = {
          type: "hello-ok",
          protocol: 4,
          server: { version: "test", connId: "canonical-owner" },
          features: { methods: [], events: [], capabilities: ["canonical-session-keys"] },
          auth: { role: "operator", scopes: ["operator.read"] },
          snapshot: {
            presence: [],
            health: {},
            stateVersion: { presence: 0, health: 0 },
            uptimeMs: 0,
          },
          policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
        };
        await expect(client.loadHistory({ sessionKey })).resolves.toMatchObject({
          sessionId: "retained-transcript",
          sessionInfo: { key: sessionKey, agentId: "retired" },
        });
        expect(request).toHaveBeenLastCalledWith("chat.history", { sessionKey, limit: undefined });
        await expect(client.loadHistory({ sessionKey, agentId: "retired" })).rejects.toThrow(
          'Unknown agent id "retired"',
        );
        await expect(client.loadHistory({ sessionKey, agentId: "research" })).rejects.toThrow(
          "does not match",
        );
      } finally {
        request.mockRestore();
      }
    },
  );
});
