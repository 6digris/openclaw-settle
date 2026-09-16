import fs from "node:fs/promises";
import path from "node:path";
import { registerAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-harness-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { forgetMemoryEntries } from "./memory-forget.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it.each([true, false])(
  "refuses unsupported remote index deletion before any state mutation (preview %s)",
  async (dryRun) => {
    const workspace = tempDirs.make("remote-forget-");
    const memoryPath = path.join(workspace, "MEMORY.md");
    await fs.writeFile(memoryPath, "Gateway decoy");
    const writeFile = vi.fn();
    const release = registerAgentWorkspaceAccess(workspace, {
      bridge: {
        resolvePath: vi.fn(),
        readFile: vi.fn(),
        writeFile,
        stat: vi.fn(),
        mkdirp: vi.fn(),
        rename: vi.fn(),
        remove: vi.fn(),
      },
    });
    try {
      await expect(
        forgetMemoryEntries({
          cfg: { agents: { defaults: { workspace } } },
          agentId: "main",
          sessionIds: ["selected"],
          dryRun,
        }),
      ).rejects.toThrow("Remote memory deletion");
      expect(writeFile).not.toHaveBeenCalled();
      expect(await fs.readFile(memoryPath, "utf8")).toBe("Gateway decoy");
    } finally {
      release();
    }
  },
);
