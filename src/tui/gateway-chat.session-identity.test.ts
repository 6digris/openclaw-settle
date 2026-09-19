import { describe, expect, it, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequestedSessionAgentId } from "../gateway/session-request-agent.js";

const { GatewayChatClient } = await import("./gateway-chat.js");
const { GatewayClient, GatewayClientRequestError } = await import("../gateway/client.js");

function authorizedHello(): HelloOk {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "2026.9.4", connId: "legacy-main-test" },
    features: { methods: [], events: [] },
    snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 0 },
    auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
  };
}

describe("GatewayChatClient session identity", () => {
  it.each(["ops", "retired"])(
    "uses negotiated canonical identity across fixed-store owner %s",
    async (owner) => {
      const cfg: OpenClawConfig = {
        session: { store: "/synthetic/shared.sqlite", scope: "global" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: owner } },
          entries: { ops: {}, research: {} },
        },
      };
      const selectedKey = "agent:research:main";
      expect(resolveRequestedSessionAgentId(cfg, selectedKey, "research")).toEqual({
        ok: true,
        agentId: "research",
      });
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (method, params) => {
          const target = params as { sessionKey: string; agentId?: string };
          const admitted = resolveRequestedSessionAgentId(cfg, target.sessionKey, target.agentId);
          if (!admitted.ok) {
            throw new GatewayClientRequestError(admitted.error);
          }
          return method === "chat.history"
            ? {
                sessionInfo: { key: selectedKey, agentId: admitted.agentId },
                sessionId: "research-main",
                messages: [],
              }
            : { runId: "research-send" };
        });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        client.hello = authorizedHello();
        client.hello.features.capabilities = ["canonical-session-keys"];
        await expect(client.loadHistory({ sessionKey: selectedKey })).resolves.toMatchObject({
          sessionId: "research-main",
        });
        await client.sendChat({ sessionKey: selectedKey, message: "selected research target" });
        expect(
          request.mock.calls.every(
            ([, params]) => (params as { sessionKey: string }).sessionKey === selectedKey,
          ),
        ).toBe(true);
      } finally {
        request.mockRestore();
      }
    },
  );

  it.each([
    { peer: "published", wireKey: "global" },
    { peer: "published empty", wireKey: "global", leaf: null },
    { peer: "canonical", wireKey: "agent:work:global" },
    { peer: "canonical stop", wireKey: "agent:work:global", message: "please stop" },
    { peer: "mixed-case", wireKey: "agent:work:global", requestKey: "AGENT:Work:GLOBAL" },
    { peer: "missing", wireKey: undefined },
  ])(
    "binds canonical global requests to the $peer Gateway wire identity",
    async ({ wireKey, requestKey, leaf = "global-leaf", message = "hello" }) => {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      if (wireKey === "agent:work:global") {
        client.hello = authorizedHello();
        client.hello.features.capabilities = ["canonical-session-keys"];
      }
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (method, params) => {
          if (method === "chat.history") {
            const key = (params as { sessionKey: string }).sessionKey;
            const canonical = wireKey === "agent:work:global";
            return {
              messages: [],
              sessionId: key === "global" && wireKey ? "global-id" : undefined,
              sessionInfo: {
                key: key === "global" && canonical ? wireKey : key,
                activeLeafEntryId: leaf,
              },
            };
          }
          if (method === "config.get") {
            return {
              valid: true,
              configRevisionHash: "applied",
              appliedConfigHash: "applied",
              runtimeConfig: { session: { scope: "global" }, agents: { entries: { work: {} } } },
            };
          }
          if (method === "agents.list") {
            return { scope: "global", ownership: "sole", defaultId: "work" };
          }
          return { messages: [], sessions: [] };
        });
      try {
        const sessionKey = "agent:work:global";
        const expectedKey = wireKey ?? sessionKey;
        const wireOwner = wireKey === "agent:work:global" ? {} : { agentId: "work" };
        const send = client.sendChat({
          sessionKey: requestKey ?? sessionKey,
          message,
          runId: "run-global-work",
        });
        await send;
        await client.loadHistory({ sessionKey, limit: 50 });
        await client.abortChat({ sessionKey, runId: "run-global-work" });
        await client.patchSession({ key: sessionKey, thinkingLevel: "low" });
        await client.resetSession(sessionKey);
        await client.createSession({ key: "agent:work:child", parentSessionKey: sessionKey });
        await client.describeSession({ sessionKey });
        await client.listSessions({ search: sessionKey });
        await client.createSession({ key: "agent:work:legacy-child", parentSessionKey: "main" });
        expect(request).toHaveBeenCalledWith("sessions.create", {
          key: "agent:work:legacy-child",
          parentSessionKey: "main",
          emitCommandHooks: true,
        });
        expect(request).toHaveBeenCalledWith("sessions.list", { agentId: "work", limit: 1 });
        if (wireKey === "agent:work:global") {
          expect(request).toHaveBeenCalledWith("sessions.describe", { key: sessionKey });
        } else {
          expect(request.mock.calls.some(([method]) => method === "sessions.describe")).toBe(false);
        }
        expect(request).toHaveBeenCalledWith("sessions.list", { search: sessionKey });
        const crossAgentChild = client.createSession({
          key: "agent:other:child",
          agentId: "other",
          parentSessionKey: sessionKey,
        });
        if (expectedKey === sessionKey) {
          await crossAgentChild;
          expect(request).toHaveBeenCalledWith("sessions.create", {
            key: "agent:other:child",
            agentId: "other",
            parentSessionKey: sessionKey,
            emitCommandHooks: true,
          });
        } else {
          await expect(crossAgentChild).rejects.toThrow("Update this Gateway");
          expect(request).not.toHaveBeenCalledWith(
            "sessions.create",
            expect.objectContaining({ key: "agent:other:child" }),
          );
        }
        expect(request).toHaveBeenCalledWith("chat.send", {
          sessionKey: expectedKey,
          ...wireOwner,
          message,
          thinking: undefined,
          deliver: undefined,
          timeoutMs: undefined,
          idempotencyKey: "run-global-work",
          ...(wireKey === "global"
            ? {
                expectedSessionRoutingContract: "global|main|work",
                sessionId: "global-id",
                expectedLeafEntryId: leaf,
              }
            : {}),
        });
        expect(request).toHaveBeenCalledWith("chat.history", {
          sessionKey: expectedKey,
          ...wireOwner,
          limit: 50,
        });
        expect(request).toHaveBeenCalledWith("chat.abort", {
          sessionKey: expectedKey,
          ...wireOwner,
          runId: "run-global-work",
        });
        expect(request).toHaveBeenCalledWith("sessions.patch", {
          key: expectedKey,
          ...wireOwner,
          thinkingLevel: "low",
        });
        expect(request).toHaveBeenCalledWith("sessions.reset", {
          key: expectedKey,
          ...wireOwner,
        });
        expect(request).toHaveBeenCalledWith("sessions.create", {
          key: "agent:work:child",
          parentSessionKey: expectedKey,
          ...wireOwner,
          emitCommandHooks: true,
        });
        if (wireKey === "agent:work:global") {
          expect(
            request.mock.calls.filter(
              ([method, params]) =>
                method === "chat.history" &&
                (params as { sessionKey?: string }).sessionKey === "global",
            ),
          ).toHaveLength(0);
        }
      } finally {
        request.mockRestore();
      }
    },
  );

  it.each([true, false])(
    "rejects a qualified main remap before sending (existing=%s)",
    async (existing) => {
      const request = vi.spyOn(GatewayClient.prototype, "request").mockImplementation(async () => ({
        sessionKey: "agent:work:main",
        sessionId: existing ? "global-id" : undefined,
        sessionInfo: { key: "global" },
        messages: [],
      }));
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        await expect(
          client.sendChat({ sessionKey: "agent:work:main", message: "hello" }),
        ).rejects.toThrow("different conversation");
        expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
      } finally {
        request.mockRestore();
      }
    },
  );

  it("rechecks qualified main routing before each operation", async () => {
    let remapped = false;
    const request = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method, params) => {
        const key = (params as { sessionKey?: string }).sessionKey;
        if (method === "chat.history") {
          return {
            sessionKey: key,
            sessionId: "main-id",
            sessionInfo: { key: key === "global" || remapped ? "global" : "agent:work:main" },
            messages: [],
          };
        }
        return { ok: true };
      });
    try {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      await client.loadHistory({ sessionKey: "agent:work:main" });
      remapped = true;
      await expect(
        client.patchSession({ key: "agent:work:main", thinkingLevel: "low" }),
      ).rejects.toThrow("different conversation");
      expect(request.mock.calls.some(([method]) => method === "sessions.patch")).toBe(false);
    } finally {
      request.mockRestore();
    }
  });

  it.each([
    {
      ownership: "sole",
      config: { agents: { entries: { work: {} } } },
      defaultId: "work",
      expected: "work",
    },
    {
      ownership: "legacy",
      config: { agents: { entries: { other: {}, work: {} } } },
      defaultId: "work",
      expected: "work",
    },
    {
      ownership: "explicit",
      config: { agents: { ownership: "explicit", entries: { other: {}, work: {} } } },
      defaultId: "other",
      expected: "unowned",
    },
    {
      ownership: "legacy",
      config: {
        agents: {
          entries: { other: {}, work: {} },
          defaults: { systemAgent: { agentId: "other" } },
        },
      },
      defaultId: "work",
      expected: "other",
    },
  ] satisfies Array<{
    ownership: string;
    config: OpenClawConfig;
    defaultId: string;
    expected: string;
  }>)(
    "protects read/write exact main sends using the authoritative $ownership owner $expected",
    async ({ ownership, config, defaultId, expected }) => {
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (method, params) => {
          if (method === "chat.history") {
            return { sessionInfo: { key: (params as { sessionKey: string }).sessionKey } };
          }
          if (method === "config.get") {
            return {
              valid: true,
              runtimeConfig: config,
              configRevisionHash: "applied",
              appliedConfigHash: "applied",
            };
          }
          if (method === "agents.list") {
            return { scope: "per-sender", ownership, defaultId, agents: [] };
          }
          return { runId: "guarded-main" };
        });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        client.hello = authorizedHello();
        for (const message of ["hello", "please stop"]) {
          await client.sendChat({ sessionKey: "agent:work:main", message });
        }
        expect(request).toHaveBeenCalledWith(
          "chat.send",
          expect.objectContaining({
            sessionKey: "agent:work:main",
            agentId: "work",
            expectedSessionRoutingContract: `per-sender|main|${expected}`,
          }),
        );
        expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(1);
        expect(request.mock.calls.filter(([method]) => method === "agents.list")).toHaveLength(1);
      } finally {
        request.mockRestore();
      }
    },
  );

  it.each(["config.get", "agents.list"])(
    "preserves a remote %s denial without issuing chat.send",
    async (deniedMethod) => {
      const denied = new GatewayClientRequestError({
        code: "FORBIDDEN",
        message: "missing scope: operator.read",
      });
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (method, params) => {
          if (method === "chat.history") {
            return { sessionInfo: { key: (params as { sessionKey: string }).sessionKey } };
          }
          if (method === deniedMethod) {
            throw denied;
          }
          return {};
        });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        client.hello = authorizedHello();
        await expect(
          client.sendChat({ sessionKey: "agent:work:main", message: "must not write" }),
        ).rejects.toBe(denied);
        expect(request).toHaveBeenCalledWith(deniedMethod, {});
        expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
      } finally {
        request.mockRestore();
      }
    },
  );

  it.each(["per-sender", "global"] as const)(
    "checks the required global scope when main routing was cached before %s",
    async (nextScope) => {
      let scope = "per-sender";
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (method, params) => {
          if (method === "chat.history") {
            const key = (params as { sessionKey: string }).sessionKey;
            return {
              sessionId: key === "agent:work:global" ? undefined : "selected-row",
              sessionInfo: { key, activeLeafEntryId: "selected-leaf" },
            };
          }
          if (method === "config.get") {
            return {
              valid: true,
              configRevisionHash: "applied",
              appliedConfigHash: "applied",
              runtimeConfig: { session: { scope }, agents: { entries: { work: {} } } },
            };
          }
          if (method === "agents.list") {
            return { scope, ownership: "sole", defaultId: "work" };
          }
          return { runId: "accepted" };
        });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        await client.sendChat({ sessionKey: "agent:work:main", message: "main" });
        scope = nextScope;
        const send = client.sendChat({ sessionKey: "agent:work:global", message: "global" });
        if (scope === "global") {
          await send;
          expect(request).toHaveBeenLastCalledWith(
            "chat.send",
            expect.objectContaining({
              sessionKey: "global",
              agentId: "work",
              expectedSessionRoutingContract: "global|main|work",
              sessionId: "selected-row",
              expectedLeafEntryId: "selected-leaf",
            }),
          );
        } else {
          await expect(send).rejects.toThrow("requires global session scope");
          expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
        }
        expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(2);
      } finally {
        request.mockRestore();
      }
    },
  );

  it.each([
    { store: "/remote/shared/sessions.json", expectedOwner: "work" },
    { store: "/remote/{agentId}/sessions.json", expectedOwner: "unowned" },
  ])(
    "uses remote store ownership for exact global sends ($expectedOwner)",
    async ({ store, expectedOwner }) => {
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (method, params) => {
          if (method === "chat.history") {
            const key = (params as { sessionKey: string }).sessionKey;
            return {
              sessionId: key === "global" ? "global-row" : undefined,
              sessionInfo: { key, activeLeafEntryId: null },
            };
          }
          if (method === "config.get") {
            return {
              valid: true,
              configRevisionHash: "applied",
              appliedConfigHash: "applied",
              runtimeConfig: {
                session: { scope: "global", store },
                agents: {
                  ownership: "explicit",
                  entries: { other: {}, work: {} },
                  defaults: { sessionStore: { agentId: "work" } },
                },
              },
            };
          }
          if (method === "agents.list") {
            return { scope: "global", ownership: "explicit", defaultId: "other" };
          }
          return { runId: "accepted" };
        });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        await client.sendChat({ sessionKey: "agent:work:global", message: "hello" });
        expect(request).toHaveBeenLastCalledWith(
          "chat.send",
          expect.objectContaining({
            sessionKey: "global",
            agentId: "work",
            expectedSessionRoutingContract: `global|main|${expectedOwner}`,
            sessionId: "global-row",
            expectedLeafEntryId: null,
          }),
        );
      } finally {
        request.mockRestore();
      }
    },
  );

  it.each([
    { failure: "scope" },
    { failure: "replacement" },
    { failure: "supplied-id" },
    { failure: "missing-leaf" },
    { failure: "stop", message: "/stop" },
    { failure: "stop", message: "please stop" },
    { failure: "stop", message: "st\u0001op" },
    { failure: "stop", message: "arre\u0302te" },
  ])(
    "does not send or retry an unsafe exact legacy global operation ($failure/$message)",
    async ({ failure, message = "must not write" }) => {
      let writes = 0;
      const rejected = new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "captured session changed",
        details: {
          reason: failure === "scope" ? "session-routing-changed" : "active-leaf-changed",
        },
      });
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (method, params) => {
          if (method === "chat.history") {
            const key = (params as { sessionKey: string }).sessionKey;
            return {
              sessionId: key === "global" ? "captured-row" : undefined,
              sessionInfo: {
                key,
                ...(failure === "missing-leaf" ? {} : { activeLeafEntryId: "captured-leaf" }),
              },
            };
          }
          if (method === "config.get") {
            return {
              valid: true,
              configRevisionHash: "applied",
              appliedConfigHash: "applied",
              runtimeConfig: { session: { scope: "global" }, agents: { entries: { work: {} } } },
            };
          }
          if (method === "agents.list") {
            return { scope: "global", ownership: "sole", defaultId: "work" };
          }
          if (method === "chat.send") {
            const wire = params as {
              sessionId?: string;
              expectedLeafEntryId?: string | null;
              expectedSessionRoutingContract?: string;
            };
            if (
              (failure === "scope" && wire.expectedSessionRoutingContract === "global|main|work") ||
              (failure === "replacement" &&
                wire.sessionId === "captured-row" &&
                wire.expectedLeafEntryId === "captured-leaf") ||
              (failure === "supplied-id" &&
                wire.sessionId === "caller-row" &&
                wire.expectedLeafEntryId === "captured-leaf")
            ) {
              throw rejected;
            }
            writes += 1;
          }
          return { runId: "wrongly-accepted" };
        });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        const send = client.sendChat({
          sessionKey: "agent:work:global",
          message,
          ...(failure === "supplied-id" ? { sessionId: "caller-row" } : {}),
        });
        if (failure === "stop") {
          await expect(send).rejects.toThrow(
            "Update this Gateway to stop this exact legacy global",
          );
        } else if (failure === "missing-leaf") {
          await expect(send).rejects.toThrow("physical session guard");
        } else {
          await expect(send).rejects.toBe(rejected);
        }
        expect(writes).toBe(0);
        expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(
          failure === "missing-leaf" || failure === "stop" ? 0 : 1,
        );
      } finally {
        request.mockRestore();
      }
    },
  );

  it("refreshes an unapplied or server-rejected main routing guard without retrying a send", async () => {
    let applied = false;
    let stale = false;
    let owner = "work";
    const request = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method, params) => {
        if (method === "chat.history") {
          return { sessionInfo: { key: (params as { sessionKey: string }).sessionKey } };
        }
        if (method === "config.get") {
          return {
            valid: true,
            runtimeConfig: { agents: { entries: { work: {}, other: {} } } },
            configRevisionHash: "disk",
            appliedConfigHash: applied ? "disk" : "old",
          };
        }
        if (method === "agents.list") {
          return { scope: "per-sender", ownership: "legacy", defaultId: owner, agents: [] };
        }
        if (stale) {
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "routing changed",
            details: { reason: "session-routing-changed" },
          });
        }
        return { runId: "guarded-main" };
      });
    try {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      client.hello = authorizedHello();
      const send = () => client.sendChat({ sessionKey: "agent:work:main", message: "hello" });
      await expect(send()).rejects.toThrow("routing is not ready");
      expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
      applied = true;
      await send();
      stale = true;
      await expect(send()).rejects.toThrow("routing changed");
      expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(2);
      owner = "other";
      stale = false;
      await send();
      expect(request).toHaveBeenLastCalledWith(
        "chat.send",
        expect.objectContaining({ expectedSessionRoutingContract: "per-sender|main|other" }),
      );
      expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(3);
    } finally {
      request.mockRestore();
    }
  });

  it("keeps a new connection's routing guard when an old send rejects late", async () => {
    let options: import("../gateway/client.js").GatewayClientOptions | undefined;
    let rejectOldSend: ((error: Error) => void) | undefined;
    let owner = "work";
    const request = vi.fn(async (method: string, params: { sessionKey?: string }) => {
      if (method === "chat.history") {
        return { sessionInfo: { key: params.sessionKey } };
      }
      if (method === "config.get") {
        return {
          valid: true,
          runtimeConfig: { agents: { entries: { work: {}, other: {} } } },
          configRevisionHash: "applied",
          appliedConfigHash: "applied",
        };
      }
      if (method === "agents.list") {
        return { scope: "per-sender", ownership: "legacy", defaultId: owner, agents: [] };
      }
      if (owner === "work") {
        return new Promise((_, reject) => {
          rejectOldSend = reject;
        });
      }
      return { runId: "new-connection" };
    });
    vi.resetModules();
    vi.doMock("../gateway/client.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../gateway/client.js")>();
      return {
        ...actual,
        GatewayClient: class {
          request = request;
          constructor(opts: import("../gateway/client.js").GatewayClientOptions) {
            options = opts;
          }
        },
      };
    });
    try {
      const { GatewayChatClient: ReconnectingClient } = await import("./gateway-chat.js");
      const { GatewayClientRequestError: RequestError } = await import("../gateway/client.js");
      const client = new ReconnectingClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      options?.onHelloOk?.(authorizedHello());
      const onEvent = vi.fn();
      client.onEvent = onEvent;
      for (const event of ["chat", "agent", "session.message"]) {
        options?.onEvent?.({
          type: "event",
          event,
          payload: { sessionKey: "global", agentId: "work" },
        });
        expect(onEvent).toHaveBeenLastCalledWith({
          event,
          payload: { sessionKey: "agent:work:global", agentId: "work" },
          seq: undefined,
        });
      }
      const oldSend = client
        .sendChat({ sessionKey: "agent:work:main", message: "old" })
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(rejectOldSend).toBeTypeOf("function"));
      options?.onClose?.(1001, "reconnecting");
      owner = "other";
      options?.onHelloOk?.(authorizedHello());
      await client.sendChat({ sessionKey: "agent:work:main", message: "new" });
      const error = new RequestError({
        code: "INVALID_REQUEST",
        message: "old routing changed",
        details: { reason: "session-routing-changed" },
      });
      rejectOldSend?.(error);
      expect(await oldSend).toBe(error);
      await client.sendChat({ sessionKey: "agent:work:main", message: "still new" });
      expect(request).toHaveBeenLastCalledWith(
        "chat.send",
        expect.objectContaining({ expectedSessionRoutingContract: "per-sender|main|other" }),
      );
      expect(request.mock.calls.filter(([method]) => method === "config.get")).toHaveLength(2);
      expect(
        request.mock.calls.filter(
          ([method, params]) => method === "chat.history" && params.sessionKey === "global",
        ),
      ).toHaveLength(0);
    } finally {
      vi.doUnmock("../gateway/client.js");
      vi.resetModules();
    }
  });

  it("keeps Home usable on published peers and strips local selector intent", async () => {
    const request = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method) =>
        method === "chat.history"
          ? { sessionInfo: { key: "global" }, messages: [] }
          : { ok: true, runId: "home-run", key: "agent:work:new" },
      );
    try {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      await client.sendChat({
        sessionKey: "agent:work:main",
        targetIntent: "home",
        message: "hello",
      });
      await client.sendChat({
        sessionKey: "agent:work:main",
        targetIntent: "home",
        message: "please stop",
      });
      await client.loadHistory({ sessionKey: "agent:work:main", targetIntent: "home" });
      await client.patchSession({
        key: "agent:work:main",
        targetIntent: "home",
        thinkingLevel: "low",
      });
      await client.resetSession("agent:work:main", "reset", { targetIntent: "home" });
      await client.abortChat({ sessionKey: "agent:work:main", targetIntent: "home" });
      await client.createSession({
        key: "agent:work:new",
        agentId: "work",
        parentSessionKey: "agent:work:main",
        parentTargetIntent: "home",
      });
      for (const [method, params] of request.mock.calls) {
        expect(params).not.toHaveProperty("targetIntent");
        expect(params).not.toHaveProperty("parentTargetIntent");
        if (method === "chat.send" || method === "chat.abort") {
          expect(params).toMatchObject({ sessionKey: "main", agentId: "work" });
        }
        if (method === "sessions.patch" || method === "sessions.reset") {
          expect(params).toMatchObject({ key: "main", agentId: "work" });
        }
        if (method === "sessions.create") {
          expect(params).toMatchObject({ parentSessionKey: "main", agentId: "work" });
        }
      }
      expect(request.mock.calls.some(([method]) => method === "config.get")).toBe(false);
    } finally {
      request.mockRestore();
    }
  });

  it("qualifies published results with their owners and keeps Home lookup on its physical row", async () => {
    let collision = false;
    const request = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method, params) => {
        if (method === "chat.history") {
          const key = (params as { sessionKey: string }).sessionKey;
          return key === "agent:work:global"
            ? {
                sessionId: collision ? "qualified" : undefined,
                sessionInfo: { key, agentId: "work" },
              }
            : {
                sessionKey: key,
                sessionId: "raw-home",
                sessionInfo: { key: "global", agentId: "work" },
              };
        }
        if (method === "sessions.resolve") {
          return { ok: true, key: "global", agentId: "work" };
        }
        if (method === "sessions.list") {
          return {
            sessions: [
              {
                key: collision ? "agent:work:global" : "agent:work:global-extra",
                sessionId: "qualified",
                agentId: "work",
              },
              { key: "global", sessionId: "raw-home", agentId: "work" },
            ],
          };
        }
        return { ok: true, key: "global", entry: { sessionId: "raw-home" } };
      });
    try {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      const home = { sessionKey: "agent:work:global", targetIntent: "home" as const };
      expect(await client.loadHistory(home)).toMatchObject({
        sessionKey: "agent:work:global",
        sessionInfo: { key: "agent:work:global", agentId: "work" },
      });
      expect(
        await client.describeSession({
          sessionKey: home.sessionKey,
          targetIntent: home.targetIntent,
          agentId: "work",
        }),
      ).toMatchObject({ session: { key: "agent:work:global", sessionId: "raw-home" } });
      expect(request).toHaveBeenCalledWith("sessions.list", { agentId: "work", limit: 1 });
      expect(
        await client.patchSession({ key: home.sessionKey, targetIntent: home.targetIntent }),
      ).toMatchObject({ key: "agent:work:global" });
      expect(await client.resetSession(home.sessionKey, "reset", home)).toMatchObject({
        key: "agent:work:global",
      });
      expect(await client.createSession({ key: "global", agentId: "work" })).toMatchObject({
        key: "agent:work:global",
      });
      collision = true;
      await expect(client.listSessions({ agentId: "work", includeGlobal: true })).rejects.toThrow(
        "distinct qualified and legacy sessions",
      );
      await expect(client.loadHistory(home)).rejects.toThrow(
        "distinct qualified and legacy sessions",
      );
      await expect(client.sendChat({ ...home, message: "must not write" })).rejects.toThrow(
        "distinct qualified and legacy sessions",
      );
      expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    } finally {
      request.mockRestore();
    }
  });

  it.each(["shared", "different", undefined])(
    "collapses only proven same-session list aliases (qualified id=%s)",
    async (qualifiedId) => {
      const request = vi.spyOn(GatewayClient.prototype, "request").mockResolvedValue({
        count: 3,
        sessions: [
          { key: "global", agentId: "work", sessionId: "shared" },
          { key: "agent:work:global", agentId: "work", sessionId: qualifiedId },
          { key: "agent:work:ordinary", sessionId: "ordinary" },
        ],
      });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        const result = client.listSessions({ agentId: "work", includeGlobal: true });
        if (qualifiedId === "shared") {
          await expect(result).resolves.toMatchObject({
            count: 2,
            sessions: [
              { key: "agent:work:global", sessionId: "shared" },
              { key: "agent:work:ordinary", sessionId: "ordinary" },
            ],
          });
        } else {
          await expect(result).rejects.toThrow("distinct qualified and legacy sessions");
        }
      } finally {
        request.mockRestore();
      }
    },
  );

  it.each(["sessions.reset", "sessions.create", "chat.abort"] as const)(
    "refuses unsafe published exact-main %s before write",
    async (method) => {
      const writes: string[] = [];
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (name, params) => {
          if (name === "chat.history") {
            const key = (params as { sessionKey: string }).sessionKey;
            return { sessionId: "main-id", sessionInfo: { key }, messages: [] };
          }
          writes.push(name);
          return { ok: true, key: (params as { key?: string }).key, aborted: true };
        });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        const operation =
          method === "sessions.reset"
            ? client.resetSession("agent:work:main")
            : method === "sessions.create"
              ? client.createSession({
                  key: "agent:work:child",
                  parentSessionKey: "agent:work:main",
                })
              : client.abortChat({ sessionKey: "agent:work:main" });
        await expect(operation).rejects.toThrow("Update this Gateway");
        expect(writes).toEqual([]);
        await client.createSession({ key: "agent:work:ordinary-fresh" });
        expect(writes).toEqual(["sessions.create"]);
      } finally {
        request.mockRestore();
      }
    },
  );

  it("protects a published exact-main patch with the observed transcript id", async () => {
    let mutated = false;
    const request = vi
      .spyOn(GatewayClient.prototype, "request")
      .mockImplementation(async (method, params) => {
        if (method === "chat.history") {
          const key = (params as { sessionKey: string }).sessionKey;
          return { sessionId: "original-main", sessionInfo: { key } };
        }
        if (
          method === "sessions.patch" &&
          (params as { expectedSessionId?: string }).expectedSessionId === "original-main"
        ) {
          throw new GatewayClientRequestError({
            code: "INVALID_REQUEST",
            message: "session changed",
          });
        }
        mutated = true;
        return { ok: true, key: "global" };
      });
    try {
      const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
      await expect(
        client.patchSession({ key: "agent:work:main", thinkingLevel: "high" }),
      ).rejects.toThrow("session changed");
      expect(mutated).toBe(false);
      expect(request).toHaveBeenCalledWith(
        "sessions.patch",
        expect.objectContaining({ key: "agent:work:main", expectedSessionId: "original-main" }),
      );
    } finally {
      request.mockRestore();
    }
  });

  it.each([
    { collision: false, sessionKey: "agent:work:global", message: "hello" },
    { collision: true, sessionKey: "agent:work:global", message: "hello" },
    { collision: false, sessionKey: "agent:work:global", message: "please stop" },
    { collision: false, sessionKey: "agent:work:ordinary", message: "please stop" },
  ])(
    "preserves published qualified $sessionKey ($message, collision=$collision)",
    async ({ collision, sessionKey, message }) => {
      const request = vi
        .spyOn(GatewayClient.prototype, "request")
        .mockImplementation(async (method, params) => {
          if (method === "chat.history") {
            const key = (params as { sessionKey: string }).sessionKey;
            return {
              sessionInfo: { key },
              sessionId:
                key === "agent:work:global" ? "fq-row" : collision ? "legacy-row" : undefined,
            };
          }
          return { runId: "sent" };
        });
      try {
        const client = new GatewayChatClient({ url: "ws://127.0.0.1:18789", token: "test-token" });
        const send = client.sendChat({ sessionKey, agentId: "work", message });
        if (collision) {
          await expect(send).rejects.toThrow("distinct qualified and legacy sessions");
          expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
        } else {
          await send;
          expect(request).toHaveBeenCalledWith(
            "chat.send",
            expect.objectContaining({ sessionKey, agentId: "work", message }),
          );
        }
      } finally {
        request.mockRestore();
      }
    },
  );
});
