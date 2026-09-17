import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { describe, expect, it, vi } from "vitest";
import { openMemoryCoreStateStore } from "../dreaming-state.js";
import { openNativeManager, type MemoryWorkerHost } from "./memory-native.js";

const get = vi.hoisted(() => vi.fn(async (): Promise<object | null> => null));
vi.mock("../memory/manager.js", () => ({ MemoryIndexManager: { get } }));

function fixture() {
  let adapter: MemoryEmbeddingProviderAdapter | undefined;
  const openShortTermLocks = vi.fn((): never => {
    throw new Error("lock store opened");
  });
  const host: MemoryWorkerHost = {
    registerEmbeddingProvider: (value) => {
      adapter = value;
    },
    openShortTermLocks,
  };
  const embed = vi.fn(async () => [[1, 2]]);
  return {
    host,
    embed,
    openShortTermLocks,
    getAdapter: () => {
      if (!adapter) {
        throw new Error("No relay registered");
      }
      return adapter;
    },
  };
}

const options = {
  workspace: "/workspace",
  agentId: "main",
  config: {
    provider: "openai-compatible",
    model: "text",
    identity: "a".repeat(64),
    maxInputTokens: 1024,
    memoryGetMaxChars: 2000,
    query: { maxResults: 4, minScore: 0.2 },
    cache: { enabled: true },
    vectorEnabled: true,
    tokenizer: "trigram" as const,
  },
};

describe("native memory worker initialization", () => {
  it("uses native keyword-only mode without registering the embedding relay", async () => {
    const f = fixture();
    const register = vi.spyOn(f.host, "registerEmbeddingProvider");
    get.mockResolvedValueOnce({});
    await openNativeManager({
      ...options,
      config: { ...options.config, provider: "none", model: "" },
      host: f.host,
      embed: f.embed,
    });
    expect(get).toHaveBeenLastCalledWith(
      expect.objectContaining({
        cfg: expect.objectContaining({
          memory: expect.objectContaining({
            search: expect.objectContaining({ provider: "none", model: "" }),
          }),
        }),
      }),
    );
    expect(register).not.toHaveBeenCalled();
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("applies configured read limits through the native file reader", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "memory-read-limit-"));
    try {
      await fs.writeFile(path.join(workspace, "MEMORY.md"), "x".repeat(3000));
      get.mockResolvedValueOnce({});
      const f = fixture();
      const manager = await openNativeManager({
        ...options,
        workspace,
        host: f.host,
        embed: f.embed,
      });
      const result = await manager.readFile({ relPath: "MEMORY.md" });
      expect(result.status).toBe("ok");
      expect(result.text.length).toBeGreaterThan(0);
      expect(result.truncated).toBe(true);
      expect(result.text.split("\n\n")[0]).toBe("x".repeat(options.config.memoryGetMaxChars));
      await expect(manager.readFile({ relPath: "../outside.md" })).rejects.toThrow();
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("uses the current native manager configuration and reports missing managers", async () => {
    const f = fixture();
    await expect(openNativeManager({ ...options, host: f.host, embed: f.embed })).rejects.toThrow(
      "Native memory manager unavailable",
    );
    expect(get).toHaveBeenLastCalledWith({
      agentId: "main",
      cfg: {
        agents: {
          defaults: { workspace: "/workspace", contextLimits: { memoryGetMaxChars: 2000 } },
          entries: { main: { workspace: "/workspace" } },
        },
        memory: {
          search: {
            enabled: true,
            provider: "workspace-memory-relay",
            model: "text",
            fallback: "none",
            sources: ["memory"],
            extraPaths: [],
            rememberAcrossConversations: false,
            experimental: { sessionMemory: false },
            query: { maxResults: 4, minScore: 0.2 },
            cache: { enabled: true },
            store: { fts: { tokenizer: "trigram" }, vector: { enabled: true } },
          },
        },
      },
    });
    expect(f.embed).not.toHaveBeenCalled();
  });

  it("registers one relay preserving index identity, input options and vector shape", async () => {
    const f = fixture();
    await expect(openNativeManager({ ...options, host: f.host, embed: f.embed })).rejects.toThrow();
    const adapter = f.getAdapter();
    expect(adapter.id).toBe("workspace-memory-relay");
    expect(adapter.transport).toBe("remote");
    expect(adapter.resolveIndexIdentity?.({ config: {}, model: "ignored" })).toEqual({
      model: "text",
      cacheKeyData: { relayIdentity: options.config.identity },
    });
    const result = await adapter.create({ config: {}, model: "ignored" });
    expect(result.runtime).toEqual({
      id: "workspace-memory-relay",
      cacheKeyData: { relayIdentity: options.config.identity },
    });
    expect(result.provider?.maxInputTokens).toBe(1024);
    const signal = new AbortController().signal;
    expect(await result.provider?.embed("query", { inputType: "query", signal })).toEqual([1, 2]);
    expect(f.embed).toHaveBeenCalledWith(["query"], { inputType: "query", signal });
    expect(result.provider?.embedBatch).toBe(f.embed);
  });

  it("allows only the worker-local short-term lock namespace", async () => {
    const f = fixture();
    await expect(openNativeManager({ ...options, host: f.host, embed: f.embed })).rejects.toThrow();
    expect(() =>
      openMemoryCoreStateStore({ namespace: "short-term-locks", maxEntries: 10 }),
    ).toThrow("lock store opened");
    expect(f.openShortTermLocks).toHaveBeenCalledWith({ maxEntries: 10 });
    expect(() =>
      openMemoryCoreStateStore({ namespace: "short-term-recall", maxEntries: 10 }),
    ).toThrow("Only short-term locks");
    expect(f.openShortTermLocks).toHaveBeenCalledTimes(1);
  });
});
