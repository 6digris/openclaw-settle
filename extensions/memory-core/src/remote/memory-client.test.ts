import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { MemoryEmbeddingProvider } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { resolveMemorySearchConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  MEMORY_SEARCH_DEADLINE_CONTROL,
  createMemorySearchDeadlineControl,
  type MemoryEmbeddingProbeResult,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayMemoryBinding,
  createRemoteMemoryManager,
  type MemoryWorkerProcess,
} from "./memory-client.js";
import { createMemoryPeer } from "./memory-wire.js";

const providerFactory = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => ({
  getMemoryEmbeddingProvider: () => ({ create: providerFactory }),
}));
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", () => ({
  resolveMemorySearchConfig: vi.fn(() => ({
    provider: "openai",
    fallback: "none",
    model: "test",
    sources: ["memory"],
    extraPaths: [],
    multimodal: { enabled: false },
    remote: { apiKey: "synthetic-secret", baseUrl: "https://provider.example/v1" },
    local: { modelPath: "/gateway/models/embedding.gguf" },
    query: { maxResults: 6, minScore: 0.35, hybrid: { enabled: true } },
    cache: { enabled: true, maxEntries: 50000 },
    chunking: { tokens: 400, overlap: 80 },
    sync: { watch: true },
    store: { vector: { enabled: true }, fts: { tokenizer: "unicode61" } },
  })),
  resolveAgentContextLimits: () => ({ memoryGetMaxChars: 256 }),
}));

class WorkerProcess extends EventEmitter implements MemoryWorkerProcess {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(signal: NodeJS.Signals | number = "SIGTERM") {
    this.signalCode = typeof signal === "string" ? signal : "SIGTERM";
    queueMicrotask(() => {
      this.emit("close", null, this.signalCode);
      this.stdout.destroy();
      this.stderr.destroy();
    });
    return true;
  }
}

const config = { provider: "openai", model: "test", identity: "a".repeat(64) };
const status = {
  backend: "builtin",
  provider: "workspace-memory-relay",
  requestedProvider: "workspace-memory-relay",
  model: "test",
  sources: ["memory"],
  custom: { providerState: { mode: "active", providerId: "workspace-memory-relay" } },
};
const hit = {
  path: "memory/pets.md",
  startLine: 1,
  endLine: 2,
  score: 0.9,
  snippet: "A canine",
  source: "memory",
  provenance: { originClass: "agent", sessionKind: "interactive", observedAt: 123 },
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  vi.clearAllMocks();
});

type Handler = NonNullable<Parameters<typeof createMemoryPeer>[0]>["handle"];
function fixture(
  handle: Handler = () => null,
  embedBatch: MemoryEmbeddingProvider["embedBatch"] = async (inputs) => inputs.map(() => [1, 0]),
  reportedStatus: Omit<typeof status, "model"> & { model?: string } = status,
  availability: MemoryEmbeddingProbeResult | null = { ok: true },
) {
  const child = new WorkerProcess();
  const wire: string[] = [];
  child.stdin.on("data", (chunk: Buffer) => wire.push(chunk.toString()));
  const provider = {
    id: "openai",
    model: "test",
    embed: vi.fn(async () => [1, 0]),
    embedBatch: vi.fn(embedBatch),
    close: vi.fn(),
  };
  const peer = createMemoryPeer({
    input: child.stdin,
    output: child.stdout,
    handle: async (method, params, context) => ({
      status: reportedStatus,
      availability,
      value: await handle(method, params, context),
    }),
  });
  const open = async (signal?: AbortSignal) => {
    const manager = await createRemoteMemoryManager({
      child,
      config,
      embedding: { provider },
      signal,
    });
    cleanup.push(manager.close);
    return manager;
  };
  return { child, peer, provider, open, wire };
}

describe("remote memory client", () => {
  it.each([true, false])("expires the native cached availability result (ok: %s)", async (ok) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    try {
      const availability = { ok, checkedAtMs: 10_000, cacheExpiresAtMs: 11_000 };
      const f = fixture(undefined, undefined, status, availability);
      const manager = await f.open();
      expect(manager.getCachedEmbeddingAvailability()).toEqual(availability);
      now.mockReturnValue(11_000);
      expect(manager.getCachedEmbeddingAvailability()).toBeNull();
    } finally {
      now.mockRestore();
    }
  });
  it("preserves the native candidate-list size instead of imposing a smaller wire cap", async () => {
    const candidates = Array.from({ length: 512 }, (_, index) => ({
      ...hit,
      path: `memory/entry-${index}.md`,
    }));
    const f = fixture((method) =>
      ["listTriggerCandidates", "listCuratedProjectCandidates"].includes(String(method))
        ? candidates
        : null,
    );
    const manager = await f.open();
    expect(await manager.listTriggerCandidates()).toHaveLength(512);
    expect(
      await manager.listCuratedProjectCandidates({ activeProjectKeys: ["project"], limit: 512 }),
    ).toHaveLength(512);
  });

  it("keeps keyword-only memory searchable without creating an embedding provider", async () => {
    const settings = resolveMemorySearchConfig({}, "main")!;
    vi.mocked(resolveMemorySearchConfig).mockReturnValueOnce({
      ...settings,
      provider: "none",
      model: "",
    });
    const f = fixture((method) => (method === "search" ? [hit] : null), undefined, {
      ...status,
      provider: "none",
      requestedProvider: "none",
      model: undefined,
      custom: { providerState: { mode: "fts-only", providerId: "none" } },
    });
    const manager = await createGatewayMemoryBinding({
      cfg: {},
      agentId: "main",
      openWorker: async () => f.child,
    });
    cleanup.push(() => manager.close!());
    expect(providerFactory).not.toHaveBeenCalled();
    expect(JSON.parse(f.wire[0]!).params).toMatchObject({ provider: "none", model: "" });
    await expect(manager.search("canine")).resolves.toMatchObject([hit]);
    expect(manager.status()).toMatchObject({
      provider: "none",
      custom: { providerState: { mode: "fts-only" } },
    });
    await expect(f.peer.call("embed", { inputs: ["query"], inputType: "query" })).rejects.toThrow();
    expect(f.provider.embedBatch).not.toHaveBeenCalled();
  });

  it.each(["openai", "auto"])(
    "keeps %s provider credentials local and sends only worker configuration",
    async (provider) => {
      const settings = resolveMemorySearchConfig({}, "main")!;
      vi.mocked(resolveMemorySearchConfig).mockReturnValueOnce({ ...settings, provider });
      const f = fixture();
      providerFactory.mockResolvedValue({
        provider: f.provider,
        runtime: { id: "openai", cacheKeyData: { header: "synthetic-secret" } },
      });
      const manager = await createGatewayMemoryBinding({
        cfg: {},
        agentId: "main",
        openWorker: async () => f.child,
      });
      cleanup.push(() => manager.close!());
      expect(providerFactory.mock.calls[0]?.[0].provider).toBe("openai");
      expect(providerFactory.mock.calls[0]?.[0].remote.apiKey).toBe("synthetic-secret");
      expect(providerFactory.mock.calls[0]?.[0].local).toEqual({
        modelPath: "/gateway/models/embedding.gguf",
      });
      const initialization = JSON.parse(f.wire[0]!).params;
      expect(initialization).toEqual({
        ...config,
        identity: expect.stringMatching(/^[a-f0-9]{64}$/),
        memoryGetMaxChars: 256,
        query: { maxResults: 6, minScore: 0.35 },
        cache: { enabled: true },
        vectorEnabled: true,
        tokenizer: "unicode61",
      });
      expect(f.wire.join("")).not.toMatch(
        /synthetic-secret|provider\.example|embedding\.gguf|chunking|sync|hybrid|maxEntries/,
      );
    },
  );

  it("projects the Gateway provider in status and search diagnostics", async () => {
    const f = fixture((method, _params, { event }) => {
      if (method === "search") {
        event({
          kind: "debug",
          value: {
            backend: "builtin",
            embeddingBootstrap: {
              provider: "workspace-memory-relay",
              ok: false,
              reason: "test failure",
              degradedTo: "keyword-only",
            },
          },
        });
        return [];
      }
      return null;
    });
    const manager = await f.open();
    expect(manager.status()).toMatchObject({
      provider: "openai",
      requestedProvider: "openai",
      custom: { providerState: { mode: "active", providerId: "openai" } },
    });
    const onDebug = vi.fn();
    await manager.search("query", { onDebug });
    expect(onDebug).toHaveBeenCalledWith({
      backend: "builtin",
      embeddingBootstrap: {
        provider: "openai",
        ok: false,
        reason: "test failure",
        degradedTo: "keyword-only",
      },
    });
  });

  it("preserves native provenance for final and partial results and forwards debug/progress", async () => {
    const f = fixture((method, _params, { event }) => {
      if (method === "search") {
        event({ kind: "debug", value: { backend: "builtin", effectiveMode: "hybrid" } });
        event({ kind: "partial", value: [hit] });
        return [hit, { ...hit, provenance: undefined, originClass: "owner" }];
      }
      if (method === "sync") {
        event({ kind: "progress", value: { completed: 1, total: 1 } });
      }
      if (method === "readFile") {
        return { status: "ok", path: "memory/pets.md", text: "A canine" };
      }
      return null;
    });
    const manager = await f.open();
    const onDebug = vi.fn();
    const onPartialResults = vi.fn();
    const result = await manager.search("dog", { onDebug, onPartialResults });
    expect(result[0]).toMatchObject(hit);
    expect(result[1]).toMatchObject({ originClass: "untrusted" });
    expect(result[1]?.provenance).toBeUndefined();
    expect(onPartialResults).toHaveBeenCalledWith([expect.objectContaining(hit)]);
    expect(onDebug).toHaveBeenCalledWith({ backend: "builtin", effectiveMode: "hybrid" });
    const progress = vi.fn();
    await manager.sync({ progress });
    expect(progress).toHaveBeenCalledWith({ completed: 1, total: 1 });
    expect(await manager.readFile({ relPath: "memory/pets.md" })).toMatchObject({
      text: "A canine",
    });
  });

  it.each(["../escape.md", "/tmp/escape.md", "C:\\escape.md", "memory/../escape.md"])(
    "rejects nonrelative normalized search paths: %s",
    async (path) => {
      const f = fixture((method) => (method === "search" ? [{ ...hit, path }] : null));
      const manager = await f.open();
      await expect(manager.search("dog")).rejects.toThrow("Invalid workspace memory hit");
    },
  );

  it("services worker embeddings while search is pending without serializing caller controls", async () => {
    const f = fixture(async (method, params) => {
      if (method !== "search") {
        return null;
      }
      const { searchId } = params as { searchId: number };
      expect(await f.peer.call("embed", { inputs: ["dog"], inputType: "query", searchId })).toEqual(
        [[1, 0]],
      );
      return [hit];
    });
    const manager = await f.open();
    const control = createMemorySearchDeadlineControl();
    expect(await manager.search("dog", { [MEMORY_SEARCH_DEADLINE_CONTROL]: control })).toEqual([
      expect.objectContaining(hit),
    ]);
    expect(f.provider.embedBatch).toHaveBeenCalledWith(
      ["dog"],
      expect.objectContaining({
        inputType: "query",
        signal: expect.any(AbortSignal),
        [MEMORY_SEARCH_DEADLINE_CONTROL]: expect.any(Object),
      }),
    );
    expect(f.wire.join("")).not.toMatch(/deadline.control|subscribe|report/);
  });

  it("does not trust incomplete native provenance", async () => {
    const f = fixture((method) =>
      method === "search"
        ? [{ ...hit, provenance: { ...hit.provenance, sessionKind: "invalid" } }]
        : null,
    );
    const manager = await f.open();
    expect(await manager.search("dog")).toEqual([
      expect.objectContaining({ originClass: "untrusted" }),
    ]);
    expect((await manager.search("dog"))[0]?.provenance).toBeUndefined();
  });

  it("cancels reverse embeddings, balances paused deadlines, and reaps the worker before provider close", async () => {
    let announce!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let providerAborted = false;
    const f = fixture(
      async (method, params) => {
        if (method !== "search") {
          return null;
        }
        const { searchId } = params as { searchId: number };
        await f.peer.call("embed", { inputs: ["dog"], inputType: "query", searchId });
        return [hit];
      },
      async (_inputs, options) => {
        options?.[MEMORY_SEARCH_DEADLINE_CONTROL]?.report("pause");
        announce();
        await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => {
              providerAborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
        return [];
      },
    );
    const manager = await f.open();
    const control = createMemorySearchDeadlineControl();
    const actions: string[] = [];
    control.subscribe((action) => actions.push(action));
    const controller = new AbortController();
    const search = manager.search("dog", {
      signal: controller.signal,
      [MEMORY_SEARCH_DEADLINE_CONTROL]: control,
    });
    await started;
    controller.abort();
    await expect(search).rejects.toThrow("cancelled");
    await manager.close();
    expect(providerAborted).toBe(true);
    expect(actions).toEqual(["pause", "resume"]);
    expect(f.child.signalCode).toBe("SIGTERM");
    expect(f.provider.close).toHaveBeenCalledTimes(1);
    expect(() => manager.status()).toThrow("closed");
  });

  it("closes the provider when worker launch fails", async () => {
    const f = fixture();
    providerFactory.mockResolvedValue({ provider: f.provider });
    await expect(
      createGatewayMemoryBinding({
        cfg: {},
        agentId: "main",
        openWorker: async () => {
          throw new Error("launch failed");
        },
      }),
    ).rejects.toThrow("launch failed");
    expect(f.provider.close).toHaveBeenCalledTimes(1);
    f.peer.close();
  });

  it("reaps an already exited worker on initialization failure", async () => {
    const f = fixture();
    f.child.exitCode = 1;
    const controller = new AbortController();
    controller.abort();
    await expect(f.open(controller.signal)).rejects.toBeDefined();
    expect(f.provider.close).toHaveBeenCalledTimes(1);
  });
});
