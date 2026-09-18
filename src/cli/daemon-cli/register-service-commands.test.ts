// Register service command tests cover daemon service subcommand registration.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { addGatewayServiceCommands } from "./register-service-commands.js";

const runDaemonInstall = vi.fn(async (_opts: unknown) => {});
const runDaemonRestart = vi.fn(async (_opts: unknown) => {});
const runDaemonStart = vi.fn(async (_opts: unknown) => {});
const runDaemonStatus = vi.fn(async (_opts: unknown) => {});
const runDaemonStop = vi.fn(async (_opts: unknown) => {});
const runDaemonUninstall = vi.fn(async (_opts: unknown) => {});

vi.mock("./install.runtime.js", () => ({
  runDaemonInstall: (opts: unknown) => runDaemonInstall(opts),
}));

vi.mock("./status.runtime.js", () => ({
  runDaemonStatus: (opts: unknown) => runDaemonStatus(opts),
}));

vi.mock("./lifecycle.runtime.js", () => ({
  runDaemonRestart: (opts: unknown) => runDaemonRestart(opts),
  runDaemonStart: (opts: unknown) => runDaemonStart(opts),
  runDaemonStop: (opts: unknown) => runDaemonStop(opts),
  runDaemonUninstall: (opts: unknown) => runDaemonUninstall(opts),
}));

function createGatewayParentLikeCommand() {
  const gateway = new Command().name("gateway");
  // Mirror overlapping root gateway options that conflict with service subcommand options.
  gateway.option("--port <port>", "Port for the gateway WebSocket");
  gateway.option("--token <token>", "Gateway token");
  gateway.option("--password <password>", "Gateway password");
  gateway.option("--force", "Gateway run --force", false);
  addGatewayServiceCommands(gateway);
  return gateway;
}

function expectSingleDaemonCall(mockFn: ReturnType<typeof vi.fn>) {
  expect(mockFn).toHaveBeenCalledTimes(1);
  const opts = mockFn.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  if (opts === undefined) {
    throw new Error("expected daemon call options");
  }
  return opts;
}

const restartRouteEnvKeys = ["OPENCLAW_SERVICE_MARKER", "OPENCLAW_SERVICE_KIND"];

function setRestartRouteEnv(env: Record<string, string | undefined>) {
  for (const key of restartRouteEnvKeys) {
    const value = env[key];
    if (value === undefined) {
      deleteTestEnvValue(key);
    } else {
      setTestEnvValue(key, value);
    }
  }
}

describe("addGatewayServiceCommands", () => {
  let restartRouteEnvSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    restartRouteEnvSnapshot = captureEnv(restartRouteEnvKeys);
    setRestartRouteEnv({});
    runDaemonInstall.mockClear();
    runDaemonRestart.mockClear();
    runDaemonStart.mockClear();
    runDaemonStatus.mockClear();
    runDaemonStop.mockClear();
    runDaemonUninstall.mockClear();
  });

  afterEach(() => {
    restartRouteEnvSnapshot.restore();
    vi.restoreAllMocks();
  });

  it.each([
    {
      name: "forwards install option collisions from parent gateway command",
      argv: ["install", "--force", "--port", "19000", "--token", "tok_test"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonInstall);
        expect(opts.force).toBe(true);
        expect(opts.port).toBe("19000");
        expect(opts.token).toBe("tok_test");
      },
    },
    {
      name: "forwards restart force and wait controls",
      argv: ["restart", "--wait", "30s"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonRestart);
        expect(opts.wait).toBe("30s");
      },
    },
    {
      name: "forwards restart safe control",
      argv: ["restart", "--safe"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonRestart);
        expect(opts.safe).toBe(true);
      },
    },
    {
      name: "forwards restart force control",
      argv: ["restart", "--force"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonRestart);
        expect(opts.force).toBe(true);
      },
    },
    {
      name: "forwards status auth collisions from parent gateway command",
      argv: ["status", "--token", "tok_status", "--password", "pw_status"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonStatus);
        const rpc = opts.rpc as { token?: unknown; password?: unknown } | undefined;
        expect(rpc?.token).toBe("tok_status");
        expect(rpc?.password).toBe("pw_status"); // pragma: allowlist secret
      },
    },
    {
      name: "forwards require-rpc for status",
      argv: ["status", "--require-rpc"],
      assert: () => {
        const opts = expectSingleDaemonCall(runDaemonStatus);
        expect(opts.requireRpc).toBe(true);
      },
    },
  ])("$name", async ({ argv, assert }) => {
    const gateway = createGatewayParentLikeCommand();
    await gateway.parseAsync(argv, { from: "user" });
    assert();
  });

  it.each([
    {
      name: "uses safe restart for a plain Windows Gateway service restart",
      platform: "win32" as const,
      env: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      argv: ["restart"],
      expected: { safe: true, force: false },
    },
    {
      name: "keeps a plain restart non-safe outside a service process",
      platform: "win32" as const,
      env: {},
      argv: ["restart"],
      expected: { safe: false },
    },
    {
      name: "keeps a plain restart non-safe inside a node service",
      platform: "win32" as const,
      env: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "node" },
      argv: ["restart"],
      expected: { safe: false },
    },
    {
      name: "keeps a plain Gateway service restart non-safe outside Windows",
      platform: "linux" as const,
      env: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      argv: ["restart"],
      expected: { safe: false },
    },
    {
      name: "preserves explicit force instead of adding implicit safe mode",
      platform: "win32" as const,
      env: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      argv: ["restart", "--force"],
      expected: { safe: false, force: true },
    },
    {
      name: "preserves wait instead of adding implicit safe mode",
      platform: "win32" as const,
      env: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      argv: ["restart", "--wait", "30s"],
      expected: { safe: false, wait: "30s" },
    },
    {
      name: "preserves skip-deferral validation instead of adding implicit safe mode",
      platform: "win32" as const,
      env: { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
      argv: ["restart", "--skip-deferral"],
      expected: { safe: false, skipDeferral: true },
    },
  ])("$name", async ({ platform, env, argv, expected }) => {
    mockProcessPlatform(platform);
    setRestartRouteEnv(env);
    const gateway = createGatewayParentLikeCommand().enablePositionalOptions();

    await gateway.parseAsync(argv, { from: "user" });

    expect(expectSingleDaemonCall(runDaemonRestart)).toMatchObject(expected);
  });
});
