import fs from "node:fs/promises";
import path from "node:path";
import { registerAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { readAgentMemoryFile } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./memory/index.js";
import { createManagerIndexFixture } from "./memory/manager-index.test-support.js";
import { createMemoryGetTool, createMemorySearchTool } from "./tools.js";

describe("memory tools with separate workspace storage", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  let release: (() => void) | undefined;
  afterEach(() => {
    release?.();
    release = undefined;
  });

  async function setup(maxChars?: number) {
    const harnessConfig = fixture.createConfig({ provider: "none", vectorEnabled: false });
    harnessConfig.agents!.defaults!.contextLimits = { memoryGetMaxChars: maxChars };
    const backend = await fixture.getFreshManager(harnessConfig);
    const gatewayWorkspace = path.join(fixture.paths.root, "gateway");
    await fs.mkdir(gatewayWorkspace, { recursive: true });
    await fs.writeFile(path.join(gatewayWorkspace, "MEMORY.md"), "stale Gateway memory");
    await fs.writeFile(
      path.join(fixture.paths.workspace, "MEMORY.md"),
      "first line\nauthoritative remote memory line\nthird line",
    );
    const cfg: OpenClawConfig = {
      ...harnessConfig,
      agents: {
        ...harnessConfig.agents,
        defaults: { ...harnessConfig.agents?.defaults, workspace: gatewayWorkspace },
      },
    };
    const acquire = vi.fn(async () => backend);
    release = registerAgentWorkspaceAccess(gatewayWorkspace, {
      bridge: {
        resolvePath: () => {
          throw new Error("Memory manager owns file reads");
        },
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdirp: vi.fn(),
        remove: vi.fn(),
        rename: vi.fn(),
        stat: vi.fn(),
      },
      getMemorySearchManager: acquire,
    });
    const tool = createMemoryGetTool({ config: cfg, agentId: "main" });
    if (!tool) {
      throw new Error("Expected native memory_get");
    }
    return { tool, backend, acquire, harnessConfig, cfg };
  }

  it("searches the authoritative native index rather than Gateway files", async () => {
    const { backend, acquire, cfg } = await setup();
    await backend.sync({ force: true });
    const tool = createMemorySearchTool({ config: cfg, agentId: "main" });
    if (!tool) {
      throw new Error("Expected native memory_search");
    }
    expect(
      (await tool.execute("remote-search", { query: "authoritative", corpus: "memory" })).details,
    ).toMatchObject({
      results: [
        expect.objectContaining({
          path: "MEMORY.md",
          snippet: expect.stringContaining("authoritative remote memory"),
        }),
      ],
    });
    expect(acquire).toHaveBeenCalledOnce();
  });

  it("reads authoritative content with the native range and configured character limits", async () => {
    const { tool, acquire, harnessConfig } = await setup(12);
    const range = { path: "MEMORY.md", from: 2, lines: 1 };
    const expected = await readAgentMemoryFile({
      cfg: harnessConfig,
      agentId: "main",
      relPath: range.path,
      from: range.from,
      lines: range.lines,
    });
    const result = await tool.execute("remote-read", range);
    expect(result.details).toEqual(expected);
    expect(result.details).toMatchObject({ status: "ok", truncated: true });
    expect(acquire).toHaveBeenCalledOnce();
  });

  it.each(["../outside.md", "memory/escape.md"])(
    "preserves native path checks for %s",
    async (filePath) => {
      const { tool, acquire } = await setup();
      const outside = path.join(fixture.paths.root, "outside.md");
      await fs.writeFile(outside, "outside file must not be returned");
      if (filePath.startsWith("memory/")) {
        await fs.symlink(outside, path.join(fixture.paths.workspace, filePath));
      }
      const result = await tool.execute("invalid-read", { path: filePath });
      expect(result.details).toMatchObject({ disabled: true, text: "", error: expect.any(String) });
      expect(acquire).toHaveBeenCalledOnce();
    },
  );

  it("does not fall back to the stale local file when the remote manager is unavailable", async () => {
    const { tool, acquire } = await setup();
    acquire.mockRejectedValueOnce(new Error("remote manager unavailable"));
    expect((await tool.execute("unavailable", { path: "MEMORY.md" })).details).toMatchObject({
      disabled: true,
      text: "",
      error: "remote manager unavailable",
    });
  });

  it.each(["abort", "revoke"])("withholds a read result after %s", async (action) => {
    const { tool, backend } = await setup();
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof backend.readFile>>>();
    const read = vi.spyOn(backend, "readFile").mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const running = tool.execute("cancelled", { path: "MEMORY.md" }, controller.signal);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    if (action === "abort") {
      controller.abort(new Error("cancelled memory read"));
    } else {
      release?.();
    }
    pending.resolve({
      status: "ok",
      path: "MEMORY.md",
      text: "must not escape after cancellation",
    });
    expect((await running).details).toMatchObject({
      disabled: true,
      text: "",
      error: expect.any(String),
    });
    read.mockRestore();
  });
});
