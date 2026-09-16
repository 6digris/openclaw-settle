import { randomUUID } from "node:crypto";
import {
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager,
} from "./search-manager.js";

const localGet = vi.hoisted(() => vi.fn());
const localClose = vi.hoisted(() => vi.fn());
const localLoaded = vi.hoisted(() => vi.fn());
vi.mock("../../manager-runtime.js", () => {
  localLoaded();
  return {
    MemoryIndexManager: { get: localGet },
    closeMemoryIndexManagersForAgent: localClose,
    closeAllMemoryIndexManagers: vi.fn(),
  };
});
vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", { spy: true });

function createManager() {
  const readFile = vi.fn<MemorySearchManager["readFile"]>(async ({ relPath }) => ({
    status: "ok",
    path: relPath,
    text: "remote memory",
  }));
  return {
    search: vi.fn<MemorySearchManager["search"]>(async () => []),
    readFile,
    status: vi.fn<MemorySearchManager["status"]>(function (this: MemorySearchManager) {
      // Native managers use instance state; the wrapper must preserve the receiver.
      expect(this).toHaveProperty("readFile", readFile);
      return { backend: "builtin", provider: "openai", model: "text-embedding-3-small" };
    }),
    probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
    probeVectorAvailability: vi.fn(async () => true),
    getCachedEmbeddingAvailability: vi.fn(() => ({ ok: true })),
    listCuratedProjectCandidates: vi.fn<
      NonNullable<MemorySearchManager["listCuratedProjectCandidates"]>
    >(async () => []),
    listTriggerCandidates: vi.fn<NonNullable<MemorySearchManager["listTriggerCandidates"]>>(
      async () => [],
    ),
    sync: vi.fn<NonNullable<MemorySearchManager["sync"]>>(async () => {}),
    close: vi.fn(async () => {}),
  } satisfies MemorySearchManager;
}

const releases: Array<() => void> = [];
function bindWorkspace(getManager?: AgentWorkspaceAccess["getMemorySearchManager"]) {
  const workspace = `/tmp/remote-memory-manager-${randomUUID()}`;
  const cfg: OpenClawConfig = { agents: { defaults: { workspace } } };
  const access = {
    bridge: {
      resolvePath: () => {
        throw new Error("Manager acquisition must not access local files");
      },
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdirp: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
      stat: vi.fn<AgentWorkspaceAccess["bridge"]["stat"]>(),
    },
    ...(getManager ? { getMemorySearchManager: getManager } : {}),
  } satisfies AgentWorkspaceAccess;
  const release = registerAgentWorkspaceAccess(workspace, access);
  releases.push(release);
  return { cfg, access, workspace, release };
}

async function acquire(cfg: OpenClawConfig) {
  const result = await getMemorySearchManager({ cfg, agentId: "main" });
  expect(result.error).toBeUndefined();
  expect(result.manager).not.toBeNull();
  return result.manager!;
}

afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  await closeAllMemorySearchManagers();
  vi.clearAllMocks();
});

describe("remote memory manager ownership", () => {
  it("uses Gateway provenance for workspace search and automatic candidates", async () => {
    const backend = createManager();
    const hits = [
      {
        path: "memory/daily.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "remote workspace text",
        source: "memory" as const,
        provenance: {
          originClass: "owner" as const,
          sessionKind: "interactive" as const,
          observedAt: 100,
        },
      },
    ];
    backend.search.mockResolvedValue(hits);
    backend.listTriggerCandidates.mockResolvedValue(hits);
    backend.listCuratedProjectCandidates.mockResolvedValue(hits);
    const { cfg, access, workspace } = bindWorkspace(async () => backend);
    vi.mocked(access.bridge.stat).mockResolvedValue({ type: "file", size: 10, mtimeMs: 1 });
    vi.mocked(readMemoryArtifactProvenance).mockResolvedValue({
      fileHash: "0".repeat(64),
      originClass: "untrusted",
      observedAt: 1,
    });
    const manager = await acquire(cfg);
    for (const results of [
      await manager.search("query"),
      await manager.listTriggerCandidates?.(),
      await manager.listCuratedProjectCandidates?.({ activeProjectKeys: ["project"] }),
    ]) {
      expect(results?.[0]?.provenance).toEqual({
        originClass: "untrusted",
        sessionKind: "unknown",
        observedAt: 100,
      });
    }
    expect(readMemoryArtifactProvenance).toHaveBeenCalledWith({
      workspaceDir: workspace,
      relativePath: "memory/daily.md",
    });
    vi.mocked(readMemoryArtifactProvenance).mockResolvedValue(undefined);
    expect((await manager.search("query"))[0]?.provenance?.originClass).toBe("agent");
  });

  it("rejects binding revocation while classifying a remote search result", async () => {
    const backend = createManager();
    backend.search.mockResolvedValue([
      {
        path: "MEMORY.md",
        source: "memory",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "remote text",
      },
    ]);
    const { cfg, access, release } = bindWorkspace(async () => backend);
    vi.mocked(access.bridge.stat).mockImplementationOnce(async () => {
      release();
      return { type: "file", size: 10, mtimeMs: 1 };
    });
    const manager = await acquire(cfg);
    await expect(manager.search("query")).rejects.toThrow("access");
  });

  it("routes native manager operations and options without a Gateway index", async () => {
    const backend = createManager();
    const getManager = vi.fn(async () => backend);
    const { cfg } = bindWorkspace(getManager);
    const result = await getMemorySearchManager({
      cfg,
      agentId: "main",
      purpose: "status",
      inspectSources: true,
    });
    expect(result.error).toBeUndefined();
    const manager = result.manager!;
    const options = { sessionKey: "agent:main:main", sources: ["sessions" as const] };
    await manager.search("remember", options);
    expect(backend.search).toHaveBeenCalledWith("remember", options);
    expect(await manager.readFile({ relPath: "MEMORY.md" })).toMatchObject({
      text: "remote memory",
    });
    expect(manager.status()).toMatchObject({ provider: "openai" });
    expect(manager.getCachedEmbeddingAvailability?.()).toEqual({ ok: true });
    await manager.listCuratedProjectCandidates?.({ activeProjectKeys: ["project"] });
    expect(backend.listCuratedProjectCandidates).toHaveBeenCalledWith({
      activeProjectKeys: ["project"],
    });
    expect(getManager).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      purpose: "status",
      inspectSources: true,
    });
    expect(localGet).not.toHaveBeenCalled();
    expect(localLoaded).not.toHaveBeenCalled();
  });

  it("fails unavailable remote acquisition without a local fallback", async () => {
    const { cfg } = bindWorkspace();
    await expect(getMemorySearchManager({ cfg, agentId: "main" })).resolves.toMatchObject({
      manager: null,
      error: expect.stringContaining("unavailable"),
    });
    expect(localGet).not.toHaveBeenCalled();
  });

  it.each(["revoke", "replace"])(
    "rejects %s during manager acquisition and closes the old adapter",
    async (action) => {
      const backend = createManager();
      const pending = Promise.withResolvers<MemorySearchManager>();
      const getManager = vi.fn(() => pending.promise);
      const { cfg, workspace, release, access } = bindWorkspace(getManager);
      const acquiring = getMemorySearchManager({ cfg, agentId: "main" });
      await vi.waitFor(() => expect(getManager).toHaveBeenCalledOnce());
      release();
      if (action === "replace") {
        releases.push(registerAgentWorkspaceAccess(workspace, { ...access }));
      }
      pending.resolve(backend);
      expect(await acquiring).toMatchObject({ manager: null, error: expect.any(String) });
      await closeAllMemorySearchManagers();
      expect(backend.close).toHaveBeenCalledOnce();
      expect(localGet).not.toHaveBeenCalled();
    },
  );

  it("revokes retained methods and in-flight results while still allowing cleanup", async () => {
    const backend = createManager();
    const { cfg, release } = bindWorkspace(async () => backend);
    const manager = await acquire(cfg);
    const pending = Promise.withResolvers<Awaited<ReturnType<MemorySearchManager["readFile"]>>>();
    backend.readFile.mockReturnValueOnce(pending.promise);
    const reading = manager.readFile({ relPath: "MEMORY.md" });
    const retainedSearch = manager.search.bind(manager);
    release();
    pending.resolve({ status: "ok", path: "MEMORY.md", text: "stale" });
    await expect(reading).rejects.toThrow();
    expect(() => retainedSearch("remember")).toThrow();
    expect(() => manager.status()).toThrow();
    expect(() => manager.getCachedEmbeddingAvailability?.()).toThrow();
    expect(backend.search).not.toHaveBeenCalled();
    await manager.close?.();
    await closeAllMemorySearchManagers();
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it("reuses one wrapper, closes by agent, and can reopen after cleanup", async () => {
    const backend = createManager();
    const { cfg, access } = bindWorkspace(async () => backend);
    const first = await acquire(cfg);
    expect(await acquire(cfg)).toBe(first);
    await closeMemorySearchManager({ cfg, agentId: " MAIN " });
    expect(backend.close).toHaveBeenCalledOnce();
    expect(() => first.status()).toThrow();
    const next = createManager();
    access.getMemorySearchManager = async () => next;
    const reopened = await acquire(cfg);
    expect(reopened).not.toBe(first);
    expect(reopened.status()).toMatchObject({ provider: "openai" });
  });

  it("keeps remote and builtin manager caches separate", async () => {
    const backend = createManager();
    const local = createManager();
    localGet.mockResolvedValueOnce(local);
    expect((await getMemorySearchManager({ cfg: {}, agentId: "main" })).manager).toBe(local);
    const { cfg } = bindWorkspace(async () => backend);
    const remote = await acquire(cfg);
    expect(remote).not.toBe(local);
    await closeMemorySearchManager({ cfg, agentId: "main" });
    expect(backend.close).toHaveBeenCalledOnce();
    expect(localClose).toHaveBeenCalledWith({ agentId: "main" });
  });

  it("waits for acquisition during global cleanup and revokes the resulting adapter", async () => {
    const backend = createManager();
    const pending = Promise.withResolvers<MemorySearchManager>();
    const getManager = vi.fn(() => pending.promise);
    const { cfg } = bindWorkspace(getManager);
    const acquiring = getMemorySearchManager({ cfg, agentId: "main" });
    await vi.waitFor(() => expect(getManager).toHaveBeenCalledOnce());
    const closing = closeAllMemorySearchManagers();
    pending.resolve(backend);
    const result = await acquiring;
    await closing;
    expect(backend.close).toHaveBeenCalledOnce();
    if (result.manager) {
      expect(() => result.manager!.status()).toThrow();
    }
  });

  it("retries failed cleanup before allocating a replacement", async () => {
    const backend = createManager();
    const { cfg, access } = bindWorkspace(async () => backend);
    const first = await acquire(cfg);
    backend.close.mockRejectedValueOnce(new Error("remote close failed"));
    const replacement = createManager();
    const getReplacement = vi.fn(async () => replacement);
    access.getMemorySearchManager = getReplacement;
    const changedCfg = structuredClone(cfg);
    expect(await getMemorySearchManager({ cfg: changedCfg, agentId: "main" })).toMatchObject({
      manager: null,
      error: "remote close failed",
    });
    expect(getReplacement).not.toHaveBeenCalled();
    expect(() => first.status()).toThrow();
    expect((await acquire(changedCfg)).status()).toMatchObject({ provider: "openai" });
    expect(backend.close).toHaveBeenCalledTimes(2);
    expect(getReplacement).toHaveBeenCalledOnce();
  });

  it.each(["search", "sync"] as const)("revokes late %s callbacks", async (operation) => {
    const backend = createManager();
    const pending = Promise.withResolvers<void>();
    let notify = () => {};
    backend.search.mockImplementation(async (_query, options) => {
      notify = () => options?.onDebug?.({ backend: "builtin" });
      await pending.promise;
      return [];
    });
    backend.sync.mockImplementation(async (options) => {
      notify = () => options?.progress?.({ completed: 1, total: 1 });
      await pending.promise;
    });
    const { cfg, release } = bindWorkspace(async () => backend);
    const manager = await acquire(cfg);
    const callback = vi.fn();
    const running =
      operation === "search"
        ? manager.search("remember", { onDebug: callback })
        : manager.sync!({ progress: callback });
    release();
    expect(notify).toThrow();
    expect(callback).not.toHaveBeenCalled();
    pending.resolve();
    await expect(running).rejects.toThrow();
  });
});
