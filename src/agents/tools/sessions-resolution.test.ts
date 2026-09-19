// Sessions resolution tests cover alias mapping, session-id lookup, and visibility normalization.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../../config/config.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { looksLikeSessionId } from "../../sessions/session-id.js";
const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/call.js")>();
  return {
    ...actual,
    callGateway: (opts: unknown) => callGatewayMock(opts),
  };
});
let resolveCurrentSessionClientAlias: typeof import("./sessions-resolution.js").resolveCurrentSessionClientAlias;
let resolveInternalSessionKey: typeof import("./sessions-resolution.js").resolveInternalSessionKey;
let resolveMainSessionAlias: typeof import("./sessions-resolution.js").resolveMainSessionAlias;
let resolveSessionReference: typeof import("./sessions-resolution.js").resolveSessionReference;
let resolveVisibleSessionReference: typeof import("./sessions-resolution.js").resolveVisibleSessionReference;
let shouldResolveSessionIdInput: typeof import("./sessions-resolution.js").shouldResolveSessionIdInput;

beforeAll(async () => {
  ({
    resolveCurrentSessionClientAlias,
    resolveInternalSessionKey,
    resolveMainSessionAlias,
    resolveSessionReference,
    resolveVisibleSessionReference,
    shouldResolveSessionIdInput,
  } = await import("./sessions-resolution.js"));
});

beforeEach(() => {
  callGatewayMock.mockReset();
});

function expectResolvedSessionReference(
  result: Awaited<ReturnType<typeof resolveSessionReference>>,
  expected: { key: string; displayKey: string; resolvedViaSessionId: boolean },
) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Expected resolved session reference");
  }
  expect(result.key).toBe(expected.key);
  expect(result.displayKey).toBe(expected.displayKey);
  expect(result.resolvedViaSessionId).toBe(expected.resolvedViaSessionId);
}

describe("resolveMainSessionAlias", () => {
  it("uses normalized main key and global alias for global scope", () => {
    const cfg = {
      session: { mainKey: " Primary ", scope: "global" },
    } as OpenClawConfig;

    expect(resolveMainSessionAlias(cfg)).toEqual({
      mainKey: "primary",
      alias: "global",
      scope: "global",
    });
  });

  it("falls back to per-sender defaults", () => {
    expect(resolveMainSessionAlias({} as OpenClawConfig)).toEqual({
      mainKey: "main",
      alias: "main",
      scope: "per-sender",
    });
  });

  it("uses session.mainKey over any legacy routing sessions key", () => {
    const cfg = {
      session: { mainKey: "  work ", scope: "per-sender" },
      routing: { sessions: { mainKey: "legacy-main" } },
    } as OpenClawConfig;

    expect(resolveMainSessionAlias(cfg)).toEqual({
      mainKey: "work",
      alias: "work",
      scope: "per-sender",
    });
  });
});

describe("session key internal mapping", () => {
  it.each([
    { cfg: {}, key: "main", expected: "agent:ops:main" },
    { cfg: { session: { mainKey: " Work " } }, key: "main", expected: "agent:ops:work" },
    {
      cfg: { session: { mainKey: " Work ", scope: "global" } },
      key: "work",
      expected: "agent:ops:global",
    },
    {
      cfg: { session: { mainKey: "global", scope: "per-sender" } },
      key: "main",
      expected: "agent:ops:global",
    },
    {
      cfg: { session: { mainKey: "unknown", scope: "global" } },
      key: "unknown",
      expected: "agent:ops:unknown",
    },
    {
      cfg: { session: { mainKey: "work", scope: "global" } },
      key: "agent:ops:main",
      expected: "agent:ops:main",
    },
    {
      cfg: { session: { mainKey: "work", scope: "global" } },
      key: "agent:ops:work",
      expected: "agent:ops:work",
    },
  ] satisfies Array<{ cfg: OpenClawConfig; key: string; expected: string }>)(
    "resolves $key from the supplied session config to $expected",
    ({ cfg, key, expected }) => {
      expect(resolveInternalSessionKey({ cfg, key, agentId: "ops" })).toBe(expected);
    },
  );

  it("maps current to requester session key", () => {
    expect(
      resolveInternalSessionKey({
        key: "current",
        cfg: { session: { scope: "global" } },
        requesterInternalKey: "agent:support:global",
      }),
    ).toBe("agent:support:global");
  });

  it("refuses unowned aliases", () => {
    expect(() =>
      resolveInternalSessionKey({ key: "global", cfg: { session: { scope: "global" } } }),
    ).toThrow("Session key does not contain an agent id");
  });

  it("maps interactive client ids to the requester session", () => {
    expect(
      resolveCurrentSessionClientAlias({
        key: "openclaw-tui",
        requesterInternalKey: "agent:main:main",
      }),
    ).toBe("agent:main:main");
    expect(resolveCurrentSessionClientAlias({ key: "openclaw-tui" })).toBeUndefined();
    expect(
      resolveCurrentSessionClientAlias({
        key: "node-host",
        requesterInternalKey: "agent:main:main",
      }),
    ).toBeUndefined();
  });
});

describe("session reference shape detection", () => {
  it("detects session ids", () => {
    expect(looksLikeSessionId("d4f5a5a1-9f75-42cf-83a6-8d170e6a1538")).toBe(true);
    expect(looksLikeSessionId("not-a-uuid")).toBe(false);
  });

  it("treats non-keys as session-id candidates", () => {
    expect(shouldResolveSessionIdInput("main")).toBe(false);
    expect(shouldResolveSessionIdInput("agent:main:main")).toBe(false);
    expect(shouldResolveSessionIdInput("current")).toBe(false);
    expect(shouldResolveSessionIdInput("cron:daily-report")).toBe(false);
    expect(shouldResolveSessionIdInput("node:macbook")).toBe(false);
    expect(shouldResolveSessionIdInput("forum:group:123")).toBe(false);
    expect(shouldResolveSessionIdInput("d4f5a5a1-9f75-42cf-83a6-8d170e6a1538")).toBe(true);
    expect(shouldResolveSessionIdInput("random-slug")).toBe(true);
  });
});

describe("resolved session visibility checks", () => {
  it("rejects incognito targets without consulting Gateway", async () => {
    const sessionKey = "agent:main:dashboard:incognito-private";

    await expect(
      resolveVisibleSessionReference({
        cfg: {},
        action: "history",
        resolvedSession: {
          ok: true,
          key: sessionKey,
          displayKey: sessionKey,
          resolvedViaSessionId: false,
        },
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        restrictToSpawned: false,
        visibilitySessionKey: sessionKey,
      }),
    ).resolves.toMatchObject({ ok: false, status: "forbidden" });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });
});

describe("resolveSessionReference", () => {
  it.each(["main", "global", "unknown"])(
    "qualifies %s separately for each selected agent",
    async (sessionKey) => {
      const keys = [];
      for (const agentId of ["ops", "research"]) {
        const result = await resolveSessionReference({
          action: "history",
          sessionKey,
          keyAgentId: agentId,
          cfg: { session: { scope: "global" } },
          requesterInternalKey: `agent:${agentId}:global`,
          restrictToSpawned: false,
        });
        const expectedKey = `agent:${agentId}:${sessionKey === "main" ? "global" : sessionKey}`;
        expectResolvedSessionReference(result, {
          key: expectedKey,
          displayKey: expectedKey,
          resolvedViaSessionId: false,
        });
        keys.push(result.ok && result.key);
      }
      expect(new Set(keys).size).toBe(2);
      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { key: "global", cfg: { session: { scope: "global" } }, expected: "global" },
    { key: "main", cfg: { session: { mainKey: "work" } }, expected: "work" },
    {
      key: "main",
      cfg: { session: { scope: "global", mainKey: "work" } },
      expected: "global",
    },
  ] satisfies Array<{ key: string; cfg: OpenClawConfig; expected: string }>)(
    "qualifies an older Gateway $key reply with its owner and configured $expected target",
    async ({ key, cfg, expected }) => {
      callGatewayMock.mockResolvedValueOnce({ key, agentId: "research" });
      const result = await resolveSessionReference({
        action: "history",
        sessionKey: "saved-session",
        keyAgentId: "ops",
        cfg,
        requesterInternalKey: "agent:ops:global",
        restrictToSpawned: false,
      });
      expectResolvedSessionReference(result, {
        key: `agent:research:${expected}`,
        displayKey: `agent:research:${expected}`,
        resolvedViaSessionId: false,
      });
    },
  );

  it("uses a scoped key's encoded owner before visibility policy", async () => {
    callGatewayMock.mockImplementation(
      async (request: { method?: string; params?: { key?: string; agentId?: string } }) => {
        expect(request.method).toBe("sessions.resolve");
        expect(request.params).toMatchObject({ key: "Agent:ops:main", agentId: "ops" });
        return { key: "agent:ops:main", agentId: "ops" };
      },
    );

    const result = await resolveSessionReference({
      action: "history",
      sessionKey: "Agent:ops:main",
      keyAgentId: "main",
      agentId: "main",
      cfg: {},
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });

    expectResolvedSessionReference(result, {
      key: "agent:ops:main",
      displayKey: "agent:ops:main",
      resolvedViaSessionId: false,
    });
  });

  for (const { name, input, expected } of [
    {
      name: "resolves current directly to the requester without probing another owner",
      input: () => ({
        action: "history" as const,
        sessionKey: "current",
        cfg: {},
        requesterInternalKey: "agent:main:subagent:child",
        restrictToSpawned: false,
      }),
      expected: {
        ok: true,
        agentId: "main",
        key: "agent:main:subagent:child",
        displayKey: "agent:main:subagent:child",
        resolvedViaSessionId: false,
        requesterOwned: true,
      },
    },
    {
      name: "resolves current to the requester before any ownership lookup",
      input: () => ({
        action: "status" as const,
        sessionKey: "current",
        keyAgentId: "ops",
        cfg: {},
        requesterInternalKey: "agent:research:subagent:child",
        restrictToSpawned: false,
      }),
      expected: {
        ok: true,
        agentId: "research",
        key: "agent:research:subagent:child",
        displayKey: "agent:research:subagent:child",
        resolvedViaSessionId: false,
        requesterOwned: true,
      },
    },
  ]) {
    it(name, async () => {
      const result = await resolveSessionReference(input());
      expect(result).toEqual(expected);
      expect(callGatewayMock).not.toHaveBeenCalled();
    });
  }

  it("does not reinterpret a failed custom-key lookup as a sessionId miss", async () => {
    callGatewayMock.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "gateway unavailable",
        retryable: true,
      }),
    );

    await expect(
      resolveSessionReference({
        action: "send",
        sessionKey: "custom-selector",
        cfg: {},
        requesterInternalKey: "agent:main:main",
        restrictToSpawned: true,
      }),
    ).resolves.toEqual({
      ok: false,
      status: "forbidden",
      error:
        "Session send denied because spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.",
    });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "tries the session ID only after a key miss, preserving spawned scope=%s",
    async (restrictToSpawned) => {
      callGatewayMock
        .mockRejectedValueOnce(new Error("No session found: saved-session"))
        .mockResolvedValueOnce({ key: "agent:research:notes", agentId: "research" });
      const requesterInternalKey = "agent:ops:parent";
      const result = await resolveSessionReference({
        action: "history",
        sessionKey: "saved-session",
        keyAgentId: "ops",
        cfg: {},
        requesterInternalKey,
        restrictToSpawned,
      });
      const shared = {
        method: "sessions.resolve",
        caps: [GATEWAY_CLIENT_CAPS.CANONICAL_SESSION_KEYS],
      };
      const spawnedBy = restrictToSpawned ? requesterInternalKey : undefined;
      expect(callGatewayMock.mock.calls).toEqual([
        [{ ...shared, params: { key: "saved-session", agentId: "ops", spawnedBy } }],
        [
          {
            ...shared,
            params: {
              sessionId: "saved-session",
              agentId: undefined,
              spawnedBy,
              includeGlobal: !restrictToSpawned,
              includeUnknown: !restrictToSpawned,
            },
          },
        ],
      ]);
      expect(result).toEqual({
        ok: true,
        agentId: "research",
        key: "agent:research:notes",
        displayKey: "agent:research:notes",
        resolvedViaSessionId: true,
        requesterOwned: restrictToSpawned,
      });
    },
  );

  it("treats the TUI client label as the requester session", async () => {
    const result = await resolveSessionReference({
      action: "history",
      sessionKey: "openclaw-tui",
      cfg: {},
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    expectResolvedSessionReference(result, {
      key: "agent:main:main",
      displayKey: "agent:main:main",
      resolvedViaSessionId: false,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("qualifies the main alias without probing configured-main bootstrap", async () => {
    const result = await resolveSessionReference({
      action: "history",
      sessionKey: "main",
      cfg: {},
      requesterInternalKey: "agent:main:dashboard:requester",
      restrictToSpawned: false,
    });

    expectResolvedSessionReference(result, {
      key: "agent:main:main",
      displayKey: "agent:main:main",
      resolvedViaSessionId: false,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("defers explicit-key lookup to action-aware visibility resolution", async () => {
    const result = await resolveSessionReference({
      action: "history",
      sessionKey: "agent:main:worker",
      cfg: {},
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });

    expect(result).toEqual({
      ok: true,
      agentId: "main",
      key: "agent:main:worker",
      displayKey: "agent:main:worker",
      resolvedViaSessionId: false,
      requesterOwned: false,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  for (const { name, owner, error } of [
    {
      name: "rejects an unknown explicit session key for history",
      owner: {},
      error: () =>
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "No session found: agent:main:missing",
        }),
    },
    {
      name: "still rejects an unknown non-alias explicit key",
      owner: { keyAgentId: "main" },
      error: () => new Error("No session found: agent:main:missing"),
    },
  ]) {
    it(name, async () => {
      callGatewayMock.mockRejectedValueOnce(error());

      const resolvedSession = await resolveSessionReference({
        action: "history",
        sessionKey: "agent:main:missing",
        ...owner,
        cfg: {},
        requesterInternalKey: "agent:main:main",
        restrictToSpawned: false,
      });
      if (!resolvedSession.ok) {
        throw new Error("Expected session reference");
      }
      const result = await resolveVisibleSessionReference({
        cfg: {},
        action: "history",
        resolvedSession,
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        restrictToSpawned: false,
        visibilitySessionKey: "agent:main:missing",
      });

      expect(result).toEqual({
        ok: false,
        status: "error",
        error: "No session found: agent:main:missing",
        displayKey: "agent:main:missing",
      });
      expect(callGatewayMock).toHaveBeenCalledWith({
        method: "sessions.resolve",
        caps: [GATEWAY_CLIENT_CAPS.CANONICAL_SESSION_KEYS],
        params: {
          key: "agent:main:missing",
          agentId: "main",
          spawnedBy: undefined,
        },
      });
    });
  }

  it("canonicalizes an existing explicit session key", async () => {
    callGatewayMock.mockResolvedValueOnce({ key: "agent:ops:main" });

    const resolvedSession = await resolveSessionReference({
      action: "send",
      sessionKey: "agent:OPS:main",
      cfg: {},
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      cfg: {},
      action: "send",
      resolvedSession,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      restrictToSpawned: false,
      visibilitySessionKey: "agent:OPS:main",
    });

    expect(result).toEqual({
      ok: true,
      agentId: "ops",
      key: "agent:ops:main",
      displayKey: "agent:ops:main",
      requesterOwned: false,
    });
  });

  it("rejects an explicit key that canonicalizes to an incognito session", async () => {
    callGatewayMock.mockResolvedValueOnce({ key: "agent:ops:dashboard:incognito-private" });

    const resolvedSession = await resolveSessionReference({
      action: "history",
      sessionKey: "agent:OPS:dashboard:private",
      cfg: {},
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      cfg: {},
      action: "history",
      resolvedSession,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      restrictToSpawned: false,
      visibilitySessionKey: "agent:OPS:dashboard:private",
    });

    expect(result).toEqual({
      ok: false,
      status: "forbidden",
      error: "Session not visible from session tools: agent:OPS:dashboard:private",
      displayKey: "agent:ops:dashboard:incognito-private",
    });
  });

  it("propagates explicit-key gateway failures", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("gateway unavailable"));

    const resolvedSession = await resolveSessionReference({
      action: "send",
      sessionKey: "agent:main:worker",
      cfg: {},
      requesterInternalKey: "agent:main:main",
      restrictToSpawned: false,
    });
    if (!resolvedSession.ok) {
      throw new Error("Expected session reference");
    }
    const result = await resolveVisibleSessionReference({
      cfg: {},
      action: "send",
      resolvedSession,
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      restrictToSpawned: false,
      visibilitySessionKey: "agent:main:worker",
    });

    expect(result).toEqual({
      ok: false,
      status: "error",
      error: "gateway unavailable",
      displayKey: "agent:main:worker",
    });
  });

  for (const { name, owner } of [
    { name: "reports an allowed missing explicit key for deliberate bootstrap", owner: {} },
    {
      name: "carries an allowed missing fact only for deliberate main bootstrap",
      owner: { keyAgentId: "main" },
    },
  ]) {
    it(name, async () => {
      callGatewayMock.mockResolvedValueOnce({});

      const resolvedSession = await resolveSessionReference({
        action: "send",
        sessionKey: "agent:main:main",
        ...owner,
        cfg: {},
        requesterInternalKey: "agent:main:dashboard:requester",
        restrictToSpawned: false,
      });
      if (!resolvedSession.ok) {
        throw new Error("Expected session reference");
      }
      const result = await resolveVisibleSessionReference({
        cfg: {},
        action: "send",
        resolvedSession,
        requesterSessionKey: "agent:main:dashboard:requester",
        requesterAgentId: "main",
        restrictToSpawned: false,
        visibilitySessionKey: "agent:main:main",
        allowMissingKey: true,
      });

      expect(result).toEqual({
        ok: true,
        agentId: "main",
        key: "agent:main:main",
        displayKey: "agent:main:main",
        missing: true,
        requesterOwned: false,
      });
      expect(callGatewayMock).toHaveBeenCalledWith({
        method: "sessions.resolve",
        caps: [GATEWAY_CLIENT_CAPS.CANONICAL_SESSION_KEYS],
        params: {
          key: "agent:main:main",
          agentId: "main",
          spawnedBy: undefined,
          allowMissing: true,
        },
      });
    });
  }
});
