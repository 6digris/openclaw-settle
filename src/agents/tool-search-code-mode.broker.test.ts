import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { runWithSpawnBroker } from "../process/spawn-broker/context.js";
import { createSpawnBrokerHost, type SpawnBrokerHost } from "../process/spawn-broker/host.js";
import { isPidDefinitelyDead } from "../shared/pid-alive.js";
import { runCodeModeChild } from "./tool-search-code-mode.js";
import { resolveToolSearchConfig } from "./tool-search-config.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(() => Promise.resolve(actual), { spawn: vi.fn(actual.spawn) });
});

const nativeSpawn = vi.mocked(spawn);
const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("Tool Search code-mode spawn broker", () => {
  let host: SpawnBrokerHost;

  beforeEach(async () => {
    host = createSpawnBrokerHost();
    await host.ready();
    nativeSpawn.mockClear();
  });

  afterEach(async () => {
    await host.close();
    vi.restoreAllMocks();
  });

  function execute(code: string, signal?: AbortSignal) {
    const config = resolveToolSearchConfig({ tools: { toolSearch: true } });
    const runtime = new ToolSearchRuntime({}, config);
    const logs: string[] = [];
    const brokerSpawn = vi.spyOn(host, "spawn");
    const promise = runWithSpawnBroker(host, () =>
      runCodeModeChild({
        code,
        config,
        logs,
        parentToolCallId: "broker-code-mode",
        runtime,
        signal,
      }),
    );
    return { promise, runtime, logs, brokerSpawn };
  }

  it("runs permission-restricted code and its IPC tool bridge without spawning in the Gateway", async () => {
    const { promise, runtime, logs, brokerSpawn } = execute(`
      console.log("broker", 42);
      const matches = await openclaw.tools.search("fixture");
      try { await openclaw.tools.call("fixture", { value: 42 }); }
      catch (error) { return { matches, error: error.message, process: typeof process }; }
    `);
    const search = vi.spyOn(runtime, "search").mockResolvedValue([]);
    const call = vi.spyOn(runtime, "call").mockRejectedValue(new Error("synthetic tool failure"));

    await expect(promise).resolves.toEqual({
      matches: [],
      error: "synthetic tool failure",
      process: "undefined",
    });
    expect(logs).toEqual(["broker 42"]);
    expect(search).toHaveBeenCalledWith("fixture", { limit: undefined });
    expect(call).toHaveBeenCalledWith(
      "fixture",
      { value: 42 },
      expect.objectContaining({ parentToolCallId: "broker-code-mode" }),
    );
    expect(nativeSpawn).not.toHaveBeenCalled();
    expect(brokerSpawn).toHaveBeenCalledOnce();
    const child = brokerSpawn.mock.results[0]!.value;
    await withTestTimeout(child.waitForClose(), 2000, "code-mode child cleanup did not settle");
    expect(isPidDefinitelyDead(child.pid!)).toBe(true);
  });

  it("cancels a bridged tool and reaps its broker-owned child", async () => {
    const parent = new AbortController();
    const started = createDeferred<AbortSignal>();
    const { promise, runtime, brokerSpawn } = execute(
      'return await openclaw.tools.call("pending", {});',
      parent.signal,
    );
    const outcome = expect(promise).rejects.toThrow("tool_search_code aborted");
    vi.spyOn(runtime, "call").mockImplementation(async (_id, _input, options) => {
      const signal = options!.signal!;
      started.resolve(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      throw signal.reason;
    });
    const bridgeSignal = await withTestTimeout(started.promise, 2000, "tool bridge did not start");
    const reason = new Error("operator canceled code mode");
    parent.abort(reason);
    await outcome;
    expect(bridgeSignal.aborted).toBe(true);
    expect(bridgeSignal.reason).toBe(reason);
    expect(nativeSpawn).not.toHaveBeenCalled();
    expect(brokerSpawn).toHaveBeenCalledOnce();
    const child = brokerSpawn.mock.results[0]!.value;
    await withTestTimeout(child.waitForClose(), 2000, "canceled code-mode child was not reaped");
    expect(isPidDefinitelyDead(child.pid!)).toBe(true);
  });

  it("settles cancellation before broker readiness and cleans the late child", async () => {
    const parent = new AbortController();
    process.kill(host.pid!, "SIGSTOP");
    try {
      const { promise, brokerSpawn } = execute("return 42;", parent.signal);
      const outcome = expect(promise).rejects.toThrow("tool_search_code aborted");
      const child = brokerSpawn.mock.results[0]!.value;
      const kill = vi.spyOn(child, "kill");
      parent.abort();
      await outcome;
      expect(kill).toHaveBeenLastCalledWith("SIGKILL");
      expect(nativeSpawn).not.toHaveBeenCalled();
      expect(brokerSpawn).toHaveBeenCalledOnce();
      expect(child.connected).toBe(false);
      process.kill(host.pid!, "SIGCONT");
      await withTestTimeout(child.waitForClose(), 2000, "late code-mode child was not reaped");
      expect(child.signalCode).toBe("SIGKILL");
      expect(isPidDefinitelyDead(child.pid!)).toBe(true);
    } finally {
      process.kill(host.pid!, "SIGCONT");
    }
  });
});
