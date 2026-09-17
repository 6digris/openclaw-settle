import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  createMemorySearchDeadlineControl,
  MEMORY_SEARCH_DEADLINE_CONTROL,
  type MemoryProviderStatus,
  type MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  serveMemoryWorker,
  type MemoryWorkerConfiguration,
  type MemoryWorkerHost,
} from "../../worker-api.js";
import { createRemoteMemoryManager, type MemoryWorkerProcess } from "./memory-client.js";
import type { MemoryWorkerManager, OpenNativeMemoryManagerOptions } from "./memory-native.js";
import { createMemoryPeer, embeddingInputs } from "./memory-wire.js";
import type { MemoryWorkerNativeRuntime } from "./memory-worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cleanup: Array<() => void | Promise<void>> = [];
const savedState = process.env.OPENCLAW_STATE_DIR;
const savedConfig = process.env.OPENCLAW_CONFIG_PATH;
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
  if (savedState === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = savedState;
  }
  if (savedConfig === undefined) {
    delete process.env.OPENCLAW_CONFIG_PATH;
  } else {
    process.env.OPENCLAW_CONFIG_PATH = savedConfig;
  }
});

const configuration: MemoryWorkerConfiguration = {
  provider: "relay",
  model: "text",
  identity: "a".repeat(64),
};
const status: MemoryProviderStatus = {
  backend: "builtin",
  provider: "workspace-memory-relay",
  model: "text",
  sources: ["memory"],
  custom: { providerState: { mode: "active" } },
};
const hit: MemorySearchResult = {
  path: "MEMORY.md",
  startLine: 1,
  endLine: 1,
  score: 1,
  snippet: "memory",
  source: "memory",
};

async function fixture(overrides: Partial<MemoryWorkerManager> = {}) {
  const root = tempDirs.make("memory-worker-");
  const input = new PassThrough();
  const output = new PassThrough();
  const manager: MemoryWorkerManager = {
    search: vi.fn(async () => [hit]),
    readFile: vi.fn<MemoryWorkerManager["readFile"]>(async ({ relPath }) => ({
      status: "ok",
      path: relPath,
      text: "memory",
    })),
    status: vi.fn(() => status),
    sync: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    listTriggerCandidates: vi.fn(async () => [hit]),
    listCuratedProjectCandidates: vi.fn(async () => [hit]),
    probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
    probeVectorStoreAvailability: vi.fn(async () => true),
    probeVectorAvailability: vi.fn(async () => true),
    getCachedEmbeddingAvailability: vi.fn(() => null),
    ...overrides,
  };
  const host: MemoryWorkerHost = {
    registerEmbeddingProvider: vi.fn(),
    openShortTermLocks: () => {
      throw new Error("Unused test state store");
    },
  };
  const paths = {
    workspace: path.join(root, "workspace"),
    stateDir: path.join(root, "state"),
    agentId: "main",
  };
  let opened: OpenNativeMemoryManagerOptions | undefined;
  const loadHost = vi.fn(async () => {
    expect(process.env.OPENCLAW_STATE_DIR).toBe(paths.stateDir);
    expect(process.env.OPENCLAW_CONFIG_PATH).toBe(
      path.join(paths.stateDir, "memory-worker-config.json"),
    );
    return host;
  });
  const loadNative = vi.fn<() => Promise<MemoryWorkerNativeRuntime>>(async () => {
    expect(loadHost).toHaveBeenCalledTimes(1);
    expect(process.env.OPENCLAW_STATE_DIR).toBe(paths.stateDir);
    return {
      MEMORY_SEARCH_DEADLINE_CONTROL,
      createMemorySearchDeadlineControl,
      openNativeManager: async (options: OpenNativeMemoryManagerOptions) => {
        opened = options;
        return manager;
      },
    };
  });
  const worker = await serveMemoryWorker({ ...paths, input, output, loadHost, loadNative });
  const embed = vi.fn<(params: unknown, event: (value: unknown) => void) => Promise<unknown>>(
    async (params) => embeddingInputs(params).inputs.map(() => [1]),
  );
  const client = createMemoryPeer({
    input: output,
    output: input,
    handle: (method, params, context) => {
      expect(method).toBe("embed");
      return embed(params, context.event);
    },
  });
  cleanup.push(async () => {
    client.close();
    worker.close();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    input.destroy();
    output.destroy();
  });
  return {
    client,
    worker,
    input,
    output,
    manager,
    loadNative,
    host,
    embed,
    initialize: () => client.call("initialize", configuration),
    getOpened: () => {
      if (!opened) {
        throw new Error("Native manager not opened");
      }
      return opened;
    },
  };
}

describe("memory worker entry point", () => {
  it("lets the native manager apply search and candidate limits above one hundred", async () => {
    const f = await fixture();
    await f.initialize();
    await f.client.call("search", { query: "memory", maxResults: 101 });
    expect(f.manager.search).toHaveBeenCalledWith(
      "memory",
      expect.objectContaining({ maxResults: 101 }),
    );
    await f.client.call("listTriggerCandidates", { limit: 512 });
    expect(f.manager.listTriggerCandidates).toHaveBeenCalledWith({ limit: 512 });
    await f.client.call("listCuratedProjectCandidates", {
      activeProjectKeys: ["project"],
      limit: 512,
    });
    expect(f.manager.listCuratedProjectCandidates).toHaveBeenCalledWith({
      activeProjectKeys: ["project"],
      limit: 512,
    });
  });

  it("accepts keyword-only initialization without requiring an embedding model", async () => {
    const f = await fixture();
    await f.client.call("initialize", { ...configuration, provider: "none", model: "" });
    expect(f.getOpened().config).toMatchObject({ provider: "none", model: "" });
    expect(f.manager.probeEmbeddingAvailability).toHaveBeenCalledTimes(1);
    expect(f.manager.probeVectorAvailability).not.toHaveBeenCalled();
    await expect(f.client.call("search", { query: "memory" })).resolves.toMatchObject({
      value: [hit],
    });
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("loads host after environment setup and native runtime only on initialize", async () => {
    const f = await fixture();
    expect(f.loadNative).not.toHaveBeenCalled();
    await expect(f.client.call("search", { query: "text" })).rejects.toThrow(/failed/);
    await f.initialize();
    expect(f.loadNative).toHaveBeenCalledTimes(1);
    expect(f.getOpened().host).toBe(f.host);
    expect(f.getOpened().config).toMatchObject(configuration);
    expect(f.manager.probeVectorAvailability).toHaveBeenCalledTimes(1);
    expect(f.manager.probeEmbeddingAvailability).not.toHaveBeenCalled();
    await expect(f.initialize()).rejects.toThrow(/failed/);
  });

  it.each([
    { workspace: "/" },
    { workspace: "relative" },
    { workspace: "/memory/../workspace" },
    { workspace: "/memory", stateDir: "/memory/state" },
    { workspace: "/state/workspace", stateDir: "/state" },
    { workspace: "/same", stateDir: "/same" },
    { agentId: "../other" },
  ])("rejects invalid worker paths before importing host/native %#", async (override) => {
    const loadHost = vi.fn();
    const loadNative = vi.fn();
    const input = new PassThrough();
    const output = new PassThrough();
    try {
      await expect(
        serveMemoryWorker({
          workspace: "/workspace",
          stateDir: "/state",
          agentId: "main",
          input,
          output,
          loadHost,
          loadNative,
          ...override,
        }),
      ).rejects.toThrow(/Invalid worker/);
      expect(loadHost).not.toHaveBeenCalled();
      expect(loadNative).not.toHaveBeenCalled();
    } finally {
      input.destroy();
      output.destroy();
    }
  });

  it("delegates search, read, sync, candidates, probes and close through native contracts", async () => {
    const progress = { completed: 1, total: 1, label: "indexed" };
    const sync = vi.fn<MemoryWorkerManager["sync"]>(async (options) => {
      options?.progress?.(progress);
    });
    const f = await fixture({ sync });
    await f.initialize();
    await expect(
      f.client.call("readFile", { relPath: "MEMORY.md", from: 1, lines: 2 }),
    ).resolves.toMatchObject({
      value: { status: "ok", path: "MEMORY.md", text: "memory" },
      status,
    });
    expect(f.manager.readFile).toHaveBeenCalledWith({ relPath: "MEMORY.md", from: 1, lines: 2 });
    await expect(f.client.call("search", { query: "text", maxResults: 3 })).resolves.toMatchObject({
      value: [hit],
    });
    expect(f.manager.search).toHaveBeenCalledWith(
      "text",
      expect.objectContaining({
        sources: ["memory"],
        maxResults: 3,
        signal: expect.any(AbortSignal),
      }),
    );
    const events: unknown[] = [];
    await f.client.call(
      "sync",
      { reason: "manual", force: true },
      { event: (event) => events.push(event) },
    );
    expect(events).toEqual([{ kind: "progress", value: progress }]);
    for (const method of ["listTriggerCandidates", "listCuratedProjectCandidates"]) {
      await expect(
        f.client.call(method, { activeProjectKeys: ["project"], limit: 2 }),
      ).resolves.toMatchObject({ value: [hit] });
    }
    for (const method of ["probeVectorAvailability", "probeVectorStoreAvailability"]) {
      await expect(f.client.call(method, {})).resolves.toMatchObject({ value: true });
    }
    await expect(f.client.call("probeEmbeddingAvailability", {})).resolves.toMatchObject({
      value: { ok: true },
    });
    await f.client.call("close", {});
    expect(f.manager.close).toHaveBeenCalledTimes(1);
  });

  it("relays partial invalidation, debug events and balanced embedding deadlines", async () => {
    const actions: string[] = [];
    const f = await fixture({
      search: async (_query, options) => {
        options?.onDebug?.({ backend: "builtin" });
        options?.onPartialResults?.([hit]);
        options?.onPartialResults?.(null);
        options?.[MEMORY_SEARCH_DEADLINE_CONTROL]?.subscribe((action) => actions.push(action));
        await f.getOpened().embed(["query"], {
          inputType: "query",
          signal: options?.signal,
          [MEMORY_SEARCH_DEADLINE_CONTROL]: options?.[MEMORY_SEARCH_DEADLINE_CONTROL],
        });
        return [hit];
      },
    });
    f.embed.mockImplementation(async (params, event) => {
      expect(embeddingInputs(params).searchId).toBe(7);
      event({ kind: "deadline", value: "pause" });
      event({ kind: "deadline", value: "resume" });
      return [[1]];
    });
    await f.initialize();
    const events: unknown[] = [];
    await f.client.call(
      "search",
      { query: "query", searchId: 7 },
      { event: (event) => events.push(event) },
    );
    expect(actions).toEqual(["pause", "resume"]);
    expect(events).toEqual([
      { kind: "debug", value: { backend: "builtin" } },
      { kind: "partial", value: [hit] },
      { kind: "partial", value: null },
    ]);
  });

  it.each(["relay", "relay-no-vector", "none"])(
    "connects public client and worker with provider %s",
    async (provider) => {
      const keywordOnly = provider === "none";
      const vectorDisabled = provider === "relay-no-vector";
      let keywordMode = "pending";
      const f = await fixture({
        ...(keywordOnly || vectorDisabled
          ? {
              status: () => ({
                ...status,
                provider: keywordOnly ? "none" : status.provider,
                model: keywordOnly ? undefined : status.model,
                custom: { providerState: { mode: keywordMode } },
              }),
              probeEmbeddingAvailability: async () => {
                keywordMode = keywordOnly ? "fts-only" : "active";
                return { ok: !keywordOnly };
              },
            }
          : {}),
        search: async (_query, options) => {
          options?.onPartialResults?.([hit]);
          if (!keywordOnly) {
            await f.getOpened().embed(["query"], {
              inputType: "query",
              signal: options?.signal,
              [MEMORY_SEARCH_DEADLINE_CONTROL]: options?.[MEMORY_SEARCH_DEADLINE_CONTROL],
            });
          }
          return [hit];
        },
      });
      // Replace the low-level test caller with the real client on these same streams.
      f.client.close();
      const events = new EventEmitter();
      const stderr = new PassThrough();
      const child: MemoryWorkerProcess = {
        stdin: f.input,
        stdout: f.output,
        stderr,
        exitCode: null,
        signalCode: null,
        once: (event, listener) => events.once(event, listener),
        kill: () => {
          f.worker.close();
          queueMicrotask(() => events.emit("close"));
          return true;
        },
      };
      const embedBatch = vi.fn(async () => [[1]]);
      const remote = await createRemoteMemoryManager({
        child,
        config: keywordOnly
          ? { ...configuration, provider: "none", model: "" }
          : { ...configuration, vectorEnabled: !vectorDisabled },
        embedding: keywordOnly
          ? null
          : { provider: { id: "relay", model: "text", embed: async () => [1], embedBatch } },
      });
      cleanup.push(async () => {
        await remote.close();
        stderr.destroy();
      });
      // These operations do not initialize native embedding state themselves.
      expect(await remote.listTriggerCandidates!()).toMatchObject([hit]);
      expect(
        await remote.listCuratedProjectCandidates!({ activeProjectKeys: ["project"] }),
      ).toMatchObject([hit]);
      const partials: unknown[] = [];
      expect(
        await remote.search("query", { onPartialResults: (partial) => partials.push(partial) }),
      ).toMatchObject([hit]);
      expect(partials).toHaveLength(1);
      if (keywordOnly) {
        expect(embedBatch).not.toHaveBeenCalled();
      } else {
        expect(embedBatch).toHaveBeenCalledWith(
          ["query"],
          expect.objectContaining({ inputType: "query" }),
        );
      }
      expect(await remote.readFile({ relPath: "MEMORY.md" })).toMatchObject({
        status: "ok",
        text: "memory",
      });
      await remote.sync({ reason: "manual" });
      expect(f.manager.sync).toHaveBeenCalledTimes(1);
    },
  );

  it("batches text embeddings and rejects multimodal inputs before relay", async () => {
    const f = await fixture();
    await f.initialize();
    const embed = f.getOpened().embed;
    expect(await embed(Array<string>(33).fill("text"))).toHaveLength(33);
    expect(f.embed.mock.calls.map(([params]) => embeddingInputs(params).inputs.length)).toEqual([
      32, 1,
    ]);
    await expect(
      embed([{ text: "text", parts: [{ type: "text", text: "other" }] }]),
    ).rejects.toThrow(/Only text/);
    expect(f.embed).toHaveBeenCalledTimes(2);
  });

  it("fails sync when native status records an indexing failure", async () => {
    const f = await fixture({ status: () => ({ ...status, lastSyncError: "index failed" }) });
    await f.initialize();
    await expect(f.client.call("sync", {})).rejects.toThrow(/failed/);
  });

  it.each([
    ["initialize", { ...configuration, sync: {} }],
    ["initialize", { ...configuration, chunking: {} }],
    ["initialize", { ...configuration, query: { hybrid: {} } }],
    ["initialize", { ...configuration, cache: { maxEntries: 1 } }],
    ["search", { query: "x".repeat(8193) }],
    ["search", { query: "query", sources: ["sessions"] }],
    ["search", { query: "query", maxResults: 0 }],
    ["readFile", { relPath: "../outside.md" }],
    ["readFile", { relPath: "C:/outside.md" }],
    ["readFile", { relPath: "memory//day.md" }],
    ["listCuratedProjectCandidates", {}],
    ["probeVectorAvailability", { unexpected: true }],
  ])("rejects invalid %s arguments before native execution", async (method, params) => {
    const f = await fixture();
    await expect(f.client.call(method, params)).rejects.toThrow(/failed/);
    expect(f.loadNative).not.toHaveBeenCalled();
    expect(f.manager.search).not.toHaveBeenCalled();
    expect(f.manager.readFile).not.toHaveBeenCalled();
  });

  it("cancels active native search before queued operations start and closes afterward", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const f = await fixture({
      search: async (_query, options) => {
        signal = options?.signal;
        started();
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error("Search aborted", { cause: signal?.reason })),
            { once: true },
          );
        });
      },
    });
    await f.initialize();
    const controller = new AbortController();
    const rejected = expect(
      f.client.call("search", { query: "text" }, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/);
    await ready;
    const queued = expect(f.client.call("sync", {})).rejects.toThrow(/cancelled/);
    f.worker.close();
    controller.abort();
    await Promise.all([rejected, queued]);
    expect(f.manager.sync).not.toHaveBeenCalled();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(signal?.aborted).toBe(true);
    expect(f.manager.close).toHaveBeenCalledTimes(1);
  });
});
