import { EventEmitter } from "node:events";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HelloOk, SessionsResolveResult } from "../../packages/gateway-protocol/src/index.js";

const spawnedChild = Object.assign(new EventEmitter(), { kill: vi.fn() });
vi.mock("node:child_process", () => ({ spawn: vi.fn(() => spawnedChild) }));

const gatewayCalls: Array<{
  method: string;
  params: Record<string, unknown>;
  mode?: string;
  caps?: string[];
  url?: string;
  token?: string;
  useStoredDeviceAuth?: boolean;
  requiredStoredDeviceAuthScopes?: string[];
  requiredCapabilities?: string[];
  hasDeviceIdentityKey: boolean;
}> = [];

function gatewayParams(params: unknown): Record<string, unknown> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new TypeError("Expected gateway params to be an object");
  }
  return params as Record<string, unknown>;
}

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(
    async (p: {
      method: string;
      params: Record<string, unknown>;
      mode?: string;
      caps?: string[];
      url?: string;
      token?: string;
      useStoredDeviceAuth?: boolean;
      requiredStoredDeviceAuthScopes?: string[];
      requiredCapabilities?: string[];
      onHelloOk?: (hello: HelloOk) => void;
    }) => {
      const dialect =
        p.method === "attach.grant" ? (grantDialect ?? sessionDialect) : sessionDialect;
      const capabilities = dialect === "canonical" ? ["canonical-session-keys"] : [];
      p.onHelloOk?.({
        type: "hello-ok",
        protocol: 4,
        server: { version: "test", connId: "attach-test" },
        features: { methods: [], events: [], capabilities },
        auth: { role: "operator", scopes: ["operator.read", "operator.admin"] },
        snapshot: {
          presence: [],
          health: {},
          stateVersion: { presence: 0, health: 0 },
          uptimeMs: 0,
        },
        policy: { maxPayload: 1024, maxBufferedBytes: 1024, tickIntervalMs: 1000 },
      });
      if (p.requiredCapabilities?.some((capability) => !capabilities.includes(capability))) {
        throw new Error("Gateway is missing required capability: canonical-session-keys");
      }
      gatewayCalls.push({
        method: p.method,
        params: gatewayParams(p.params),
        mode: p.mode,
        caps: p.caps,
        url: p.url,
        token: p.token,
        useStoredDeviceAuth: p.useStoredDeviceAuth,
        requiredStoredDeviceAuthScopes: p.requiredStoredDeviceAuthScopes,
        requiredCapabilities: p.requiredCapabilities,
        hasDeviceIdentityKey: "deviceIdentity" in p,
      });
      if (p.method === "sessions.resolve") {
        if (sessionResolveResult) {
          return sessionResolveResult;
        }
        return p.params.key === "global"
          ? { ok: true, key: "global", agentId: "ops" }
          : { ok: true, key: "agent:ops:thread:resolved", agentId: "ops" };
      }
      if (p.method === "agents.list") {
        return { defaultId: "ops", mainKey: "main", scope: sessionScope, agents: [] };
      }
      if (p.method === "chat.history") {
        const key = String(p.params.sessionKey);
        const owner =
          typeof p.params.agentId === "string" ? p.params.agentId : key.split(":")[1] || "ops";
        if (key === "global" && fixedStoreOwner && owner !== fixedStoreOwner) {
          throw new Error(`agent "${owner}" does not match session key agent "${fixedStoreOwner}"`);
        }
        const mainKey = sessionScope === "global" ? "global" : `agent:${owner}:main`;
        const selected = key === "main" ? mainKey : key;
        const observed =
          (key.endsWith(":main") && sessionHistoryKey) ||
          (sessionDialect === "canonical" && !selected.startsWith("agent:")
            ? `agent:${owner}:${selected}`
            : selected);
        return {
          sessionId: sessionHistoryRows[observed],
          sessionInfo: { key: observed, agentId: owner },
        };
      }
      if (p.method === "attach.grant") {
        if (grantResponse !== undefined) {
          return grantResponse;
        }
        const requestedKey = (p.params.sessionKey as string) ?? "agent:main:main";
        const sessionKey =
          grantedSessionKey ??
          ((requestedKey === "global" || requestedKey === "unknown") &&
          typeof p.params.agentId === "string"
            ? `agent:${p.params.agentId}:${requestedKey}`
            : requestedKey);
        return {
          sessionKey,
          token: "tok-123",
          expiresAtMs: 2_000_000_000_000,
          mcpConfig: {
            mcpServers: {
              openclaw: {
                type: "http",
                url: "http://127.0.0.1:9999/mcp",
                headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
              },
            },
          },
          env: { OPENCLAW_MCP_TOKEN: "tok-123" },
        };
      }
      if (p.method === "attach.revoke" && revokeFailure) {
        throw new Error("synthetic revoke failure");
      }
      return {};
    },
  ),
  GatewayStoredDeviceAuthUnavailableError: class extends Error {},
  GatewayTransportError: class extends Error {},
}));

let sessionResolveResult: SessionsResolveResult | undefined;
let sessionHistoryKey: string | undefined;
let sessionDialect: "canonical" | "legacy";
let sessionScope: "global" | "per-sender";
let sessionHistoryRows: Record<string, string>;
let fixedStoreOwner: string | undefined;
let grantDialect: "canonical" | "legacy" | undefined;
let grantResponse: unknown;
let revokeFailure: boolean;
let grantedSessionKey: string | undefined;

const logs: string[] = [];
let exitCode: number | undefined;
vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (m: string) => logs.push(m),
    error: (m: string) => logs.push(`ERR:${m}`),
    exit: (c: number) => {
      exitCode = c;
    },
  },
}));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));

import { callGateway } from "../gateway/call.js";
import { registerAttachCli } from "./attach-cli.js";

async function runAttach(...args: string[]) {
  const program = new Command().name("openclaw").exitOverride();
  await registerAttachCli(program);
  await program.parseAsync(["node", "openclaw", "attach", ...args]);
}
const tick = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

describe("openclaw attach (action)", () => {
  beforeEach(() => {
    gatewayCalls.length = 0;
    sessionResolveResult = undefined;
    sessionHistoryKey = undefined;
    sessionDialect = "canonical";
    sessionScope = "global";
    sessionHistoryRows = {};
    fixedStoreOwner = undefined;
    grantDialect = undefined;
    grantResponse = undefined;
    revokeFailure = false;
    grantedSessionKey = undefined;
    logs.length = 0;
    exitCode = undefined;
    spawnedChild.removeAllListeners();
    spawnedChild.kill.mockClear();
  });

  it.each([
    {
      name: "fitting ASCII labels",
      labels: ["Alpha", "  Beta  "],
      expectedLines: [
        "SESSION  ID PREFIX",
        "Alpha    123456780aaa4000",
        "Beta     123456780bbb4000",
      ],
    },
    {
      name: "sanitized wide labels",
      labels: ["\u001b[31m界界界\u001b[0m", "Alpha"],
      expectedLines: [
        "SESSION  ID PREFIX",
        "界界界   123456780aaa4000",
        "Alpha    123456780bbb4000",
      ],
    },
    {
      name: "an emoji crossing the name limit",
      labels: ["A".repeat(39) + "😀", "Alpha"],
      expectedLines: [
        `SESSION${" ".repeat(35)}ID PREFIX`,
        `${"A".repeat(39)}…  123456780aaa4000`,
        `Alpha${" ".repeat(37)}123456780bbb4000`,
      ],
    },
    {
      name: "a combining label that exactly fits",
      labels: ["A".repeat(39) + "e\u0301", "Alpha"],
      expectedLines: [
        `SESSION${" ".repeat(35)}ID PREFIX`,
        `${"A".repeat(39)}e\u0301  123456780aaa4000`,
        `Alpha${" ".repeat(37)}123456780bbb4000`,
      ],
    },
    {
      name: "a bounded zero-width label",
      labels: ["\u200b".repeat(512), "Alpha"],
      expectedLines: [
        "SESSION  ID PREFIX",
        `${"\u200b".repeat(49)}…        123456780aaa4000`,
        "Alpha    123456780bbb4000",
      ],
    },
    {
      name: "an oversized combining grapheme",
      labels: ["e" + "\u0301".repeat(512), "Alpha"],
      expectedLines: [
        "SESSION  ID PREFIX",
        "…        123456780aaa4000",
        "Alpha    123456780bbb4000",
      ],
    },
    {
      name: "an oversized ZWJ grapheme",
      labels: ["👩" + "\u200d👩".repeat(128), "Alpha"],
      expectedLines: [
        "SESSION  ID PREFIX",
        "…        123456780aaa4000",
        "Alpha    123456780bbb4000",
      ],
    },
    {
      name: "ordinary multi-person emoji",
      labels: ["👨‍👩‍👧‍👦".repeat(5), "Alpha"],
      expectedLines: [
        "SESSION     ID PREFIX",
        `${"👨‍👩‍👧‍👦".repeat(5)}  123456780aaa4000`,
        "Alpha       123456780bbb4000",
      ],
    },
  ])("renders ambiguous session candidates with $name", async ({ labels, expectedLines }) => {
    const response = {
      ok: false,
      candidates: [
        {
          key: "agent:main:thread:12345678-0aaa-4000-8000-000000000001",
          agentId: "main",
          displayName: labels[0],
        },
        {
          key: "agent:main:thread:12345678-0bbb-4000-8000-000000000002",
          agentId: "main",
          displayName: labels[1],
        },
      ],
    } satisfies SessionsResolveResult;
    const gateway = vi.mocked(callGateway);
    const originalImplementation = gateway.getMockImplementation();
    const { spawn } = await import("node:child_process");
    const spawnCount = vi.mocked(spawn).mock.calls.length;
    gateway.mockReset();
    // Any request after resolution must fail before a grant can reach config writing or spawn.
    gateway.mockRejectedValue(new Error("Unexpected Gateway request after session resolution"));
    gateway.mockResolvedValueOnce(response);
    try {
      const error = await runAttach("12345678").catch((caught: unknown) => caught);
      if (!(error instanceof Error)) {
        throw new Error("Expected ambiguous session target rejection");
      }
      expect(error.message).toBe(
        [
          "Session reference is ambiguous:",
          ...expectedLines,
          "Pass a longer reference. Run `openclaw sessions list` to choose a full session key.",
        ].join("\n"),
      );
      expect(Buffer.from(error.message, "utf8").toString("utf8")).toBe(error.message);
      expect(gateway).toHaveBeenCalledTimes(1);
      expect(gateway).toHaveBeenCalledWith(
        expect.objectContaining({ method: "sessions.resolve", params: { shortId: "12345678" } }),
      );
      expect(vi.mocked(spawn).mock.calls.length).toBe(spawnCount);
    } finally {
      gateway.mockReset();
      if (originalImplementation) {
        gateway.mockImplementation(originalImplementation);
      }
    }
  });

  it("--print-config: mints + writes config + prints launch, does NOT revoke or name a nonexistent command", async () => {
    await runAttach("--print-config", "--session", "agent:main:cli");
    expect(gatewayCalls.find((c) => c.method === "attach.grant")?.params.sessionKey).toBe(
      "agent:main:cli",
    );
    // setup mode leaves the grant live (no revoke) and must not point at a revoke command that does not exist
    expect(gatewayCalls.find((c) => c.method === "attach.revoke")).toBeUndefined();
    const out = logs.join("\n");
    expect(out).toContain("agent:main:cli");
    expect(out).toContain("--mcp-config");
    expect(out).toContain("--strict-mcp-config");
    expect(out).toContain("OPENCLAW_MCP_TOKEN");
    expect(out).not.toContain("attach.revoke");
  });

  it("attaches a canonical exact session without probing another fixed-store owner", async () => {
    fixedStoreOwner = "ops";
    await runAttach("--session", "agent:research:main", "--print-config");
    expect(gatewayCalls.find((call) => call.method === "attach.grant")?.params).toMatchObject({
      sessionKey: "agent:research:main",
      agentId: "research",
    });
    expect(
      gatewayCalls
        .filter((call) => call.method === "chat.history")
        .every((call) => call.params.sessionKey === "agent:research:main"),
    ).toBe(true);
  });

  it("requires canonical support on the actual grant connection after a peer downgrade", async () => {
    grantDialect = "legacy";
    const { spawn } = await import("node:child_process");
    const spawnCount = vi.mocked(spawn).mock.calls.length;
    try {
      await expect(runAttach("--session", "agent:research:main")).rejects.toThrow(
        "missing required capability",
      );
      expect(gatewayCalls.some((call) => call.method === "attach.grant")).toBe(false);
      expect(vi.mocked(spawn).mock.calls.length).toBe(spawnCount);
    } finally {
      spawnedChild.emit("exit", 0, null);
      await tick();
      await tick();
    }
  });

  it("calls attach.grant in CLI mode with an auto-resolved device identity (operator.admin regression guard)", async () => {
    // Regression guard: attach.grant is operator.admin-scoped. mode BACKEND or an explicit
    // deviceIdentity:null drops the operator device identity → the gateway rejects with
    // "missing scope: operator.admin". This was a real bug found via a live-gateway proof.
    await runAttach("--print-config", "--session", "agent:main:cli");
    const grant = gatewayCalls.find((c) => c.method === "attach.grant");
    expect(grant?.mode).toBe("cli");
    expect(grant?.hasDeviceIdentityKey).toBe(false);
  });

  it("resolves a URL target before granting on the same origin", async () => {
    await runAttach(
      "https://gateway.example/base/dashboard/ops/movies-a1166b81",
      "--token",
      "explicit-token",
      "--print-config",
    );

    const resolve = gatewayCalls.find((call) => call.method === "sessions.resolve");
    expect(resolve).toMatchObject({
      url: "wss://gateway.example/base",
      token: "explicit-token",
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.read"],
      params: { shortId: "a1166b81", slugHint: "movies" },
    });
    expect(gatewayCalls.find((call) => call.method === "attach.grant")).toMatchObject({
      url: "wss://gateway.example/base",
      token: "explicit-token",
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.admin"],
      params: { sessionKey: "agent:ops:thread:resolved" },
    });
  });

  it("preserves a global-scope URL main session when granting attach access", async () => {
    await runAttach(
      "https://gateway.example/base/dashboard/ops",
      "--token",
      "explicit-token",
      "--print-config",
    );

    expect(gatewayCalls.every((call) => call.caps?.includes("canonical-session-keys"))).toBe(true);
    expect(gatewayCalls.find((call) => call.method === "agents.list")).toMatchObject({
      url: "wss://gateway.example/base",
      token: "explicit-token",
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.read"],
      params: {},
    });
    expect(gatewayCalls.find((call) => call.method === "attach.grant")).toMatchObject({
      url: "wss://gateway.example/base",
      token: "explicit-token",
      useStoredDeviceAuth: true,
      requiredStoredDeviceAuthScopes: ["operator.admin"],
      params: { sessionKey: "agent:ops:global", agentId: "ops" },
    });
  });

  it.each([
    {
      target: "https://gateway.example/dashboard/ops/movies-a1166b81",
      key: "agent:ops:global",
      agentId: "ops",
    },
    {
      target: "https://gateway.example/dashboard/ops/movies-a1166b81",
      key: "agent:ops:unknown",
      agentId: "ops",
    },
    {
      target: "https://gateway.example/dashboard/ops/movies-a1166b81",
      key: "agent:research:global",
      agentId: "research",
    },
    { target: "a1166b81", key: "agent:research:unknown", agentId: "research" },
    {
      target: "https://gateway.example/dashboard/ops/~key/global",
      key: "agent:ops:global",
      agentId: "ops",
    },
  ])(
    "retains resolved session ownership for $target → $agentId/$key",
    async ({ target, key, agentId }) => {
      sessionResolveResult = { ok: true, key, agentId };
      try {
        await runAttach(target);
        expect(gatewayCalls.find((call) => call.method === "attach.grant")?.params).toMatchObject({
          sessionKey: key,
          agentId,
        });
        expect(gatewayCalls.every((call) => call.caps?.includes("canonical-session-keys"))).toBe(
          true,
        );
        expect(
          gatewayCalls.find((call) => call.method === "sessions.resolve")?.params,
        ).not.toHaveProperty("agentId");
      } finally {
        spawnedChild.emit("exit", 0, null);
        await tick();
        await tick();
      }
    },
  );

  it.each([
    { target: "agent:ops:main", response: { ok: true, key: "global", agentId: "ops" } },
    {
      target: "https://gateway.example/dashboard/ops/~key/main",
      response: { ok: true, key: "global", agentId: "ops" },
    },
    {
      target: "agent:ops:thread:original",
      response: { ok: true, key: "agent:ops:thread:other", agentId: "ops" },
    },
    { target: "a1166b81", response: { ok: true, key: "global", agentId: "!!!" } },
    { target: "a1166b81", response: { ok: true, key: "global" } },
    { target: "a1166b81", response: { ok: true, key: "agent:ops:global", agentId: "research" } },
    { target: "a1166b81", response: { ok: true, key: "agent:!!!:global", agentId: "main" } },
    {
      target: "https://gateway.example/dashboard/ops/~key/global",
      response: { ok: true, key: "global", agentId: "research" },
    },
  ])(
    "rejects conflicting resolved session ownership for $target/$response.key",
    async ({ target, response }) => {
      vi.mocked(callGateway).mockResolvedValueOnce(response);
      try {
        await expect(runAttach(target)).rejects.toThrow(
          "Gateway resolved the session to a different conversation.",
        );
        expect(gatewayCalls.some((call) => call.method === "attach.grant")).toBe(false);
      } finally {
        spawnedChild.emit("exit", 0, null);
        await tick();
        await tick();
      }
    },
  );

  it("rejects legacy qualified main remapping before granting", async () => {
    sessionDialect = "legacy";
    sessionHistoryKey = "global";
    await expect(runAttach("--session", "agent:ops:main")).rejects.toThrow(
      "different conversation",
    );
    expect(gatewayCalls.some((call) => call.method === "attach.grant")).toBe(false);
  });

  it.each([
    { dialect: "canonical", key: "agent:ops:main", existing: false },
    { dialect: "canonical", key: "agent:ops:main", existing: true },
    { dialect: "legacy", key: "agent:ops:global", existing: true },
    { dialect: "legacy", key: "agent:ops:unknown", existing: true },
    { dialect: "legacy", key: "agent:ops:ordinary", existing: true },
  ] as const)(
    "supports $dialect exact $key (existing=$existing)",
    async ({ dialect, key, existing }) => {
      sessionDialect = dialect;
      sessionScope = "per-sender";
      sessionHistoryRows = existing ? { [key]: "selected-id" } : {};
      try {
        await runAttach("--session", key);
        expect(gatewayCalls.find((call) => call.method === "attach.grant")?.params).toEqual({
          sessionKey: key,
          agentId: "ops",
          ttlMs: undefined,
        });
        expect(gatewayCalls.some((call) => call.method === "attach.revoke")).toBe(false);
      } finally {
        spawnedChild.emit("exit", 0, null);
        await tick();
        await tick();
      }
    },
  );

  it.each([false, true])(
    "revokes a grant remapped after the identity probe before spawning (revoke fails=%s)",
    async (revokeFails) => {
      grantedSessionKey = "agent:ops:global";
      revokeFailure = revokeFails;
      const { spawn } = await import("node:child_process");
      const spawnCount = vi.mocked(spawn).mock.calls.length;
      try {
        await expect(runAttach("--session", "agent:ops:main")).rejects.toThrow(
          "different conversation",
        );
        expect(gatewayCalls.filter((call) => call.method === "attach.revoke")).toHaveLength(1);
        expect(vi.mocked(spawn).mock.calls.length).toBe(spawnCount);
        if (revokeFails) {
          expect(logs.join("\n")).toContain("failed to revoke attach grant");
        }
      } finally {
        spawnedChild.emit("exit", 0, null);
        await tick();
        await tick();
      }
    },
  );

  it.each([
    { args: [], scope: "global", key: "agent:ops:global" },
    { args: ["--session", "main"], scope: "per-sender", key: "agent:ops:main" },
    { args: ["--session", "global"], scope: "global", key: "agent:ops:global" },
  ] as const)(
    "binds the current $scope Home/alias selection once ($args)",
    async ({ args, scope, key }) => {
      sessionScope = scope;
      try {
        await runAttach(...args);
        expect(gatewayCalls.find((call) => call.method === "attach.grant")?.params.sessionKey).toBe(
          key,
        );
        expect(gatewayCalls.some((call) => call.method === "sessions.resolve")).toBe(false);
      } finally {
        spawnedChild.emit("exit", 0, null);
        await tick();
        await tick();
      }
    },
  );

  it.each<{
    args: readonly string[];
    scope: "global" | "per-sender";
    rows: Record<string, string>;
  }>([
    { args: ["--session", "agent:ops:main"], scope: "per-sender", rows: {} },
    {
      args: ["--session", "agent:ops:main"],
      scope: "per-sender",
      rows: { "agent:ops:main": "main-id" },
    },
    { args: ["--session", "agent:ops:global"], scope: "global", rows: { global: "raw-id" } },
    { args: ["--session", "agent:ops:unknown"], scope: "per-sender", rows: { unknown: "raw-id" } },
    { args: ["--session", "global"], scope: "global", rows: { global: "raw-id" } },
    {
      args: ["--session", "global"],
      scope: "global",
      rows: { "agent:ops:global": "qualified-id" },
    },
    { args: ["--session", "main"], scope: "per-sender", rows: {} },
    { args: [], scope: "global", rows: { global: "raw-id" } },
    { args: [], scope: "global", rows: { "agent:ops:global": "qualified-id" } },
    {
      args: ["https://gateway.example/dashboard/ops"],
      scope: "global",
      rows: { global: "raw-id" },
    },
  ] as const)(
    "refuses an unrepresentable legacy $scope bind before granting ($args)",
    async ({ args, scope, rows }) => {
      sessionDialect = "legacy";
      sessionScope = scope;
      sessionHistoryRows = rows;
      const { spawn } = await import("node:child_process");
      const spawnCount = vi.mocked(spawn).mock.calls.length;
      try {
        await expect(runAttach(...args)).rejects.toThrow("Update the Gateway before attaching");
        expect(gatewayCalls.some((call) => call.method === "attach.grant")).toBe(false);
        expect(vi.mocked(spawn).mock.calls.length).toBe(spawnCount);
      } finally {
        spawnedChild.emit("exit", 0, null);
        await tick();
        await tick();
      }
    },
  );

  it("rejects a non-positive --ttl before minting", async () => {
    await runAttach("--ttl", "-5", "--print-config");
    expect(exitCode).toBe(1);
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeUndefined();
  });

  it.each(["0x10", "1.5", "1e3"])("rejects malformed --ttl %s before minting", async (ttl) => {
    await runAttach("--ttl", ttl, "--print-config");
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("--ttl must be a positive integer of milliseconds");
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeUndefined();
  });

  it("rejects an empty --ttl rather than silently defaulting", async () => {
    await runAttach("--ttl", "", "--print-config");
    expect(exitCode).toBe(1);
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeUndefined();
  });

  it("passes a positive --ttl through to attach.grant", async () => {
    await runAttach("--ttl", "600000", "--print-config");
    expect(gatewayCalls.find((c) => c.method === "attach.grant")?.params.ttlMs).toBe(600_000);
  });

  it("errors on a malformed attach.grant response instead of crashing", async () => {
    grantResponse = {};
    await runAttach("--print-config", "--session", "agent:ops:ordinary");
    expect(exitCode).toBe(1);
  });

  it("spawns Claude Code and revokes the grant when the child exits", async () => {
    await runAttach("--session", "agent:main:spawn");
    expect(gatewayCalls.find((c) => c.method === "attach.grant")).toBeTruthy();
    const { spawn } = await import("node:child_process");
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual([
      "--strict-mcp-config",
      "--mcp-config",
      expect.stringContaining(".mcp.json"),
    ]);
    spawnedChild.emit("exit", 0, null);
    await tick();
    await tick();
    expect(gatewayCalls.find((c) => c.method === "attach.revoke")?.params.token).toBe("tok-123");
    expect(exitCode).toBe(0);
  });

  it("revokes once and surfaces a launch failure when the child errors", async () => {
    await runAttach("--session", "agent:main:spawn-err");
    spawnedChild.emit("error", new Error("ENOENT"));
    await tick();
    await tick();
    expect(gatewayCalls.filter((c) => c.method === "attach.revoke")).toHaveLength(1);
    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Failed to launch");
  });

  it("warns when revoke fails but still exits with the child status", async () => {
    revokeFailure = true;

    await runAttach("--session", "agent:main:spawn");
    spawnedChild.emit("exit", 0, null);
    await tick();
    await tick();

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("failed to revoke attach grant");
  });

  it("detaches its signal handlers after the child exits (no listener leak)", async () => {
    const baseInt = process.listenerCount("SIGINT");
    const baseTerm = process.listenerCount("SIGTERM");
    await runAttach("--session", "agent:main:spawn");
    expect(process.listenerCount("SIGINT")).toBe(baseInt + 1);
    spawnedChild.emit("exit", 0, null);
    await tick();
    await tick();
    expect(process.listenerCount("SIGINT")).toBe(baseInt);
    expect(process.listenerCount("SIGTERM")).toBe(baseTerm);
  });

  it("errors on a grant with a non-numeric expiresAtMs instead of crashing on toISOString", async () => {
    grantResponse = {
      sessionKey: "agent:main:x",
      token: "tok-123",
      expiresAtMs: "soon",
      mcpConfig: { mcpServers: { openclaw: {} } },
      env: {},
    };
    await runAttach("--print-config", "--session", "agent:ops:ordinary");
    expect(exitCode).toBe(1);
  });
});
