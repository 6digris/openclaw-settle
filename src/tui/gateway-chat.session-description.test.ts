import { describe, expect, it, vi } from "vitest";
import {
  validateChatHistoryParams,
  validateSessionsDescribeParams,
  validateSessionsListParams,
} from "../../packages/gateway-protocol/src/index.js";
import { GatewayClient, GatewayClientRequestError } from "../gateway/client.js";
import {
  resolveRequestedSessionAgentId,
  resolveRequestedSessionListScope,
} from "../gateway/session-request-agent.js";
import { GatewayChatClient } from "./gateway-chat.js";
import type { TuiSessionList } from "./tui-backend.js";
import {
  createBaseState,
  createTestSessionActions,
  makeTuiSessionList,
} from "./tui-session-actions-test-support.js";

describe("GatewayChatClient session description", () => {
  it("refreshes an exact session behind more than five newer prefix and label matches", async () => {
    const sessionKey = "agent:work:notes";
    const selected = { key: sessionKey, sessionId: "selected-session", model: "selected-model" };
    const rows: TuiSessionList["sessions"] = [
      ...Array.from({ length: 3 }, (_, index) => ({
        key: `${sessionKey}-${index}`,
        sessionId: `prefix-${index}`,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        key: `agent:work:other-${index}`,
        label: `${sessionKey} label ${index}`,
        sessionId: `label-${index}`,
      })),
      selected,
    ];
    const defaults = { model: "default-model", modelProvider: "openai", contextTokens: 16000 };
    const request = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method, params) => {
        if (method === "sessions.describe" && validateSessionsDescribeParams(params)) {
          return { session: rows.find((row) => row.key === params.key) ?? null };
        }
        if (method === "sessions.list" && validateSessionsListParams(params)) {
          const search = params.search ?? "";
          const matches = rows.filter(
            (row) => row.key.includes(search) || row.label?.includes(search),
          );
          return makeTuiSessionList({
            sessions: matches.slice(params.offset ?? 0, params.limit),
            defaults,
          });
        }
        throw new Error(`Unexpected request: ${method}`);
      });
    try {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      const state = createBaseState({ currentSessionKey: sessionKey, currentAgentId: "work" });
      const { refreshSessionInfo } = createTestSessionActions({ client, state });

      await refreshSessionInfo();

      expect(state.currentSessionId).toBe("selected-session");
      expect(state.sessionInfo).toMatchObject({
        model: "selected-model",
        modelProvider: "openai",
        contextTokens: 16000,
      });
    } finally {
      request.mockRestore();
    }
  });

  it.each([
    { kind: "ordinary", key: "agent:work:notes", sessionId: "empty-transcript", visible: true },
    { kind: "archived", key: "agent:work:notes", archived: true, visible: false },
    { kind: "incognito row", key: "agent:work:notes", incognito: true, visible: false },
    { kind: "incognito key", key: "agent:work:dashboard:incognito-private", visible: false },
    { kind: "cron run", key: "agent:work:cron:job:run:run-id", visible: false },
    { kind: "phantom", key: "agent:work:sessions", sessionId: " ", visible: false },
    {
      kind: "materialized sessions key",
      key: "agent:work:sessions",
      sessionId: "real",
      visible: true,
    },
  ])(
    "preserves $kind discovery eligibility in exact metadata reads",
    async ({ kind: _kind, visible, ...session }) => {
      const defaults = { model: "work-default" };
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (method) => {
          if (method === "sessions.describe") {
            return { session };
          }
          if (method === "sessions.list") {
            return makeTuiSessionList({ defaults });
          }
          throw new Error(`Unexpected request: ${method}`);
        });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        await expect(client.describeSession({ sessionKey: session.key })).resolves.toEqual({
          session: visible ? session : null,
          defaults,
        });
        expect(request).toHaveBeenCalledWith("sessions.describe", { key: session.key });
        expect(request).toHaveBeenCalledWith("sessions.list", { agentId: "work", limit: 1 });
      } finally {
        request.mockRestore();
      }
    },
  );

  it.each([
    {
      name: "literal main",
      tail: "main",
      wireKey: "agent:work:main",
      sessionId: "literal",
      targetIntent: undefined,
    },
    {
      name: "empty stored ID",
      tail: "main",
      wireKey: "agent:work:main",
      sessionId: "",
      targetIntent: undefined,
    },
    {
      name: "legacy global",
      tail: "global",
      wireKey: "global",
      sessionId: "legacy",
      targetIntent: undefined,
    },
    {
      name: "legacy unknown",
      tail: "unknown",
      wireKey: "unknown",
      sessionId: "legacy",
      targetIntent: undefined,
    },
    {
      name: "Home",
      tail: "global",
      wireKey: "global",
      sessionId: "home",
      targetIntent: "home" as const,
    },
    {
      name: "missing main",
      tail: "main",
      wireKey: "agent:work:main",
      sessionId: undefined,
      targetIntent: undefined,
    },
    {
      name: "missing Home",
      tail: "global",
      wireKey: "global",
      sessionId: undefined,
      targetIntent: "home" as const,
    },
  ])(
    "reuses the admitted $name history fact without describing a different legacy target",
    async ({ tail, wireKey, sessionId, targetIntent }) => {
      const key = `agent:work:${tail}`;
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (method, params) => {
          if (method === "chat.history" && validateChatHistoryParams(params)) {
            const selected = params.sessionKey === (targetIntent === "home" ? "main" : wireKey);
            return {
              sessionId: selected ? sessionId : undefined,
              sessionInfo: {
                key: selected ? wireKey : params.sessionKey,
                agentId: "work",
                updatedAt: null,
                model: "selected-model",
              },
            };
          }
          if (method === "sessions.list") {
            return makeTuiSessionList({ defaults: { model: "fresh-default" } });
          }
          throw new Error(`Unexpected request: ${method}`);
        });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        await expect(client.describeSession({ sessionKey: key, targetIntent })).resolves.toEqual({
          session:
            sessionId === undefined
              ? null
              : { key, sessionId, agentId: "work", updatedAt: null, model: "selected-model" },
          defaults: { model: "fresh-default" },
        });
        expect(request.mock.calls.some(([method]) => method === "sessions.describe")).toBe(false);
        expect(request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(
          tail === "main" ? 1 : 2,
        );
      } finally {
        request.mockRestore();
      }
    },
  );

  it("reads a retained owner by qualified key while rejecting an explicitly unconfigured owner", async () => {
    const key = "agent:retired:notes";
    const config = { agents: { entries: { work: {} } } };
    const request = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method, params) => {
        if (method === "sessions.describe" && validateSessionsDescribeParams(params)) {
          const owner = resolveRequestedSessionAgentId(config, params.key, params.agentId);
          if (!owner.ok) {
            throw new GatewayClientRequestError(owner.error);
          }
          return { session: { key, sessionId: "retained" } };
        }
        if (method === "sessions.list" && validateSessionsListParams(params)) {
          const scope = resolveRequestedSessionListScope(config, params);
          if (!scope.ok) {
            throw new GatewayClientRequestError(scope.error);
          }
          return makeTuiSessionList({ defaults: { model: "retained-default" } });
        }
        throw new Error(`Unexpected request: ${method}`);
      });
    try {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      await expect(client.describeSession({ sessionKey: key })).resolves.toEqual({
        session: { key, sessionId: "retained" },
        defaults: { model: "retained-default" },
      });
      expect(request).toHaveBeenCalledWith("sessions.describe", { key });
      expect(request).toHaveBeenCalledWith("sessions.list", { agentId: "retired", limit: 1 });
      await expect(client.describeSession({ sessionKey: key, agentId: "retired" })).rejects.toThrow(
        'Unknown agent id "retired"',
      );
      await expect(client.describeSession({ sessionKey: key, agentId: "work" })).rejects.toThrow(
        'does not match session key agent "retired"',
      );
    } finally {
      request.mockRestore();
    }
  });
});
