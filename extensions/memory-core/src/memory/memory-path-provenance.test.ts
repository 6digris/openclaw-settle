// Memory Core tests cover workspace path provenance classification.
import fs from "node:fs/promises";
import path from "node:path";
import {
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryCoreTestHarness } from "../test-helpers.js";
import { resolveMemoryPathClassification } from "./memory-path-provenance.js";

vi.mock("openclaw/plugin-sdk/memory-core-host-runtime-core", { spy: true });

createMemoryCoreTestHarness();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workspaceReleases: Array<() => void> = [];

function remoteWorkspace(workspaceDir: string) {
  const bridge = {
    resolvePath: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdirp: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    stat: vi.fn<AgentWorkspaceAccess["bridge"]["stat"]>(async () => ({
      type: "file",
      size: 10,
      mtimeMs: 1,
    })),
  } satisfies AgentWorkspaceAccess["bridge"];
  const release = registerAgentWorkspaceAccess(workspaceDir, { bridge });
  workspaceReleases.push(release);
  return { bridge, release };
}

afterEach(() => {
  for (const release of workspaceReleases.splice(0)) {
    release();
  }
  vi.restoreAllMocks();
});

describe("memory path provenance", () => {
  it("trusts canonical workspace memory while excluding system and lookalike paths", async () => {
    const root = tempDirs.make("memory-path-provenance-");
    const workspaceDir = path.join(root, "workspace");
    const outsideDir = path.join(root, "outside");
    await fs.mkdir(path.join(workspaceDir, "memory", "projects"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "memory", "dreaming", "deep"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "Memory"), { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });

    const classify = async (relativePath: string, source: "memory" | "sessions" = "memory") => {
      const absolutePath = path.join(workspaceDir, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, "fixture");
      return await resolveMemoryPathClassification({ absolutePath, source, workspaceDir });
    };

    await expect(classify("MEMORY.md")).resolves.toEqual({
      curatedRoot: true,
      originClass: "agent",
    });
    await expect(classify("USER.md")).resolves.toEqual({
      curatedRoot: true,
      originClass: "agent",
    });
    await expect(classify("memory/2026-07-27.md")).resolves.toMatchObject({
      originClass: "agent",
    });
    await expect(classify("memory/projects/notes.md")).resolves.toMatchObject({
      originClass: "agent",
    });
    await expect(classify("DREAMS.md")).resolves.toMatchObject({ originClass: "system" });
    await expect(classify("memory/dreaming/deep/report.md")).resolves.toMatchObject({
      originClass: "system",
    });
    await expect(classify("notes/extra.md")).resolves.toMatchObject({
      originClass: "untrusted",
    });
    const caseVariantDir = await fs.realpath(path.join(workspaceDir, "Memory"));
    if (path.basename(caseVariantDir) === "Memory") {
      await expect(classify("Memory/payload.md")).resolves.toMatchObject({
        originClass: "untrusted",
      });
    }
    await expect(classify("memory/2026-07-27.md", "sessions")).resolves.toMatchObject({
      originClass: "untrusted",
    });

    const outsideFile = path.join(outsideDir, "payload.md");
    await fs.writeFile(outsideFile, "outside");
    if (process.platform !== "win32") {
      await fs.symlink(outsideFile, path.join(workspaceDir, "memory", "linked.md"));
      await expect(
        resolveMemoryPathClassification({
          absolutePath: path.join(workspaceDir, "memory", "linked.md"),
          source: "memory",
          workspaceDir,
        }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
    }
  });

  it("honors sticky untrusted provenance for runtime-written memory files", async () => {
    const workspaceDir = tempDirs.make("memory-path-runtime-taint-");
    const absolutePath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(absolutePath, "network-authored memory", "utf8");
    vi.mocked(readMemoryArtifactProvenance).mockResolvedValueOnce({
      fileHash: "0".repeat(64),
      originClass: "untrusted",
      observedAt: 1,
    });

    await expect(
      resolveMemoryPathClassification({ absolutePath, source: "memory", workspaceDir }),
    ).resolves.toEqual({ curatedRoot: true, originClass: "untrusted" });
  });

  it("classifies remote memory against Gateway provenance without a local file", async () => {
    const workspaceDir = path.join(tempDirs.make("remote-provenance-"), "absent-gateway-workspace");
    const { bridge } = remoteWorkspace(workspaceDir);
    vi.mocked(readMemoryArtifactProvenance).mockResolvedValueOnce({
      fileHash: "0".repeat(64),
      originClass: "untrusted",
      observedAt: 1,
    });
    const absolutePath = path.join(workspaceDir, "memory", "daily.md");
    await expect(
      resolveMemoryPathClassification({ absolutePath, source: "memory", workspaceDir }),
    ).resolves.toEqual({ curatedRoot: false, originClass: "untrusted" });
    expect(readMemoryArtifactProvenance).toHaveBeenCalledWith({
      workspaceDir,
      relativePath: "memory/daily.md",
    });
    expect(bridge.stat).toHaveBeenCalledWith({ filePath: "memory/daily.md" });
    await expect(
      resolveMemoryPathClassification({
        absolutePath: path.join(workspaceDir, "MEMORY.md"),
        source: "memory",
        workspaceDir,
      }),
    ).resolves.toEqual({ curatedRoot: true, originClass: "agent" });
  });

  it.each(["missing", "directory", "symlink"])(
    "rejects remote %s even with a Gateway decoy",
    async (kind) => {
      const workspaceDir = tempDirs.make("remote-provenance-decoy-");
      const absolutePath = path.join(workspaceDir, "MEMORY.md");
      await fs.writeFile(absolutePath, "trusted local decoy");
      const { bridge } = remoteWorkspace(workspaceDir);
      if (kind === "symlink") {
        vi.mocked(bridge.stat).mockRejectedValueOnce(new Error("outside workspace"));
      } else {
        vi.mocked(bridge.stat).mockResolvedValueOnce(
          kind === "missing" ? null : { type: "directory", size: 0, mtimeMs: 1 },
        );
      }
      await expect(
        resolveMemoryPathClassification({ absolutePath, source: "memory", workspaceDir }),
      ).resolves.toEqual({ curatedRoot: false, originClass: "untrusted" });
    },
  );

  it.each(["stat", "provenance"])("withholds classification revoked during %s", async (stage) => {
    const workspaceDir = tempDirs.make("remote-provenance-revoke-");
    const absolutePath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(absolutePath, "trusted local decoy");
    const { bridge, release } = remoteWorkspace(workspaceDir);
    if (stage === "stat") {
      vi.mocked(bridge.stat).mockImplementationOnce(async () => {
        release();
        return { type: "file", size: 10, mtimeMs: 1 };
      });
    } else {
      vi.mocked(readMemoryArtifactProvenance).mockImplementationOnce(async () => {
        release();
        return { fileHash: "0".repeat(64), originClass: "agent", observedAt: 1 };
      });
    }
    await expect(
      resolveMemoryPathClassification({ absolutePath, source: "memory", workspaceDir }),
    ).resolves.toEqual({ curatedRoot: false, originClass: "untrusted" });
  });
});
