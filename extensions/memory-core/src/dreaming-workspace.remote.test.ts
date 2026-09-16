import fs from "node:fs/promises";
import path from "node:path";
import {
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { updateDeepDreamsFile, updateDreamsFile } from "./dreaming-dreams-file.js";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import { runDreamingSweepPhases } from "./dreaming-phases.js";
import { hashMemoryContent, writeMemoryContent } from "./short-term-promotion-memory-write.js";
import { rehydratePromotionCandidate } from "./short-term-promotion-rehydrate.js";
import {
  applyShortTermPromotions,
  rankShortTermPromotionCandidates,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) {
    release();
  }
});
async function fixture() {
  const workspaceDir = await createTempWorkspace("gateway-dreaming-");
  const remote = await createTempWorkspace("harness-dreaming-");
  const map = (filePath: string) =>
    path.join(remote, path.relative(workspaceDir, path.resolve(workspaceDir, filePath)));
  const stat = async ({ filePath }: { filePath: string }) => {
    const value = await fs.lstat(map(filePath)).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    });
    return value
      ? {
          type: value.isFile()
            ? ("file" as const)
            : value.isDirectory()
              ? ("directory" as const)
              : ("other" as const),
          size: value.size,
          mtimeMs: value.mtimeMs,
        }
      : null;
  };
  const memoryBridge: NonNullable<AgentWorkspaceAccess["memoryBridge"]> = {
    stat: vi.fn(stat),
    readFile: vi.fn(async ({ filePath }) => fs.readFile(map(filePath))),
    writeFile: vi.fn(async ({ filePath, data }) => {
      await fs.mkdir(path.dirname(map(filePath)), { recursive: true });
      await fs.writeFile(map(filePath), data);
    }),
    mkdirp: vi.fn(async ({ filePath }) => {
      await fs.mkdir(map(filePath), { recursive: true });
    }),
    listDirectory: vi.fn(async ({ filePath }) =>
      (await fs.readdir(map(filePath), { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
      })),
    ),
  };
  const access = {
    memoryBridge,
    bridge: {
      resolvePath: vi.fn(),
      stat: vi.fn(stat),
      readFile: vi.fn(),
      writeFile: vi.fn(async () => {
        throw new Error("Owner write permission must not be used");
      }),
      mkdirp: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
    },
  } satisfies AgentWorkspaceAccess;
  const release = registerAgentWorkspaceAccess(workspaceDir, access);
  releases.push(release);
  return { workspaceDir, remote, memoryBridge, access, release };
}

it("writes DREAMS and phase reports only to the authoritative remote workspace", async () => {
  const { workspaceDir, remote, access } = await fixture();
  await fs.writeFile(path.join(workspaceDir, "DREAMS.md"), "Gateway decoy\n");
  await fs.writeFile(path.join(remote, "DREAMS.md"), "Harness diary\n");
  await updateDeepDreamsFile({ workspaceDir, bodyLines: ["- A durable improvement"] });
  await writeDailyDreamingPhaseBlock({
    workspaceDir,
    phase: "light",
    bodyLines: ["- daily idea"],
    nowMs: Date.parse("2026-09-15T12:00:00Z"),
    timezone: "UTC",
    storage: { mode: "separate", separateReports: true },
  });
  expect(await fs.readFile(path.join(remote, "DREAMS.md"), "utf8")).toContain("Harness diary");
  expect(await fs.readFile(path.join(remote, "DREAMS.md"), "utf8")).toContain(
    "A durable improvement",
  );
  expect(await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf8")).toBe("Gateway decoy\n");
  expect(
    await fs.readFile(path.join(remote, "memory/dreaming/light/2026-09-15.md"), "utf8"),
  ).toContain("daily idea");
  expect(access.bridge.writeFile).not.toHaveBeenCalled();
});

it("checks the remote MEMORY hash before writing and rejects revoked access", async () => {
  const { workspaceDir, remote, memoryBridge, release } = await fixture();
  const memoryPath = path.join(workspaceDir, "MEMORY.md");
  await fs.writeFile(memoryPath, "Gateway decoy");
  await fs.writeFile(path.join(remote, "MEMORY.md"), "newer remote text");
  const request = {
    memoryPath,
    memoryWritePath: memoryPath,
    expectedHash: hashMemoryContent("older text"),
    content: "replacement",
  };
  await expect(writeMemoryContent(request)).rejects.toThrow("changed");
  expect(memoryBridge.writeFile).not.toHaveBeenCalled();
  vi.mocked(memoryBridge.readFile).mockImplementationOnce(async () => {
    release();
    return Buffer.from("newer remote text");
  });
  await expect(
    writeMemoryContent({ ...request, expectedHash: hashMemoryContent("newer remote text") }),
  ).rejects.toThrow("access");
  expect(memoryBridge.writeFile).not.toHaveBeenCalled();
});

it("does not publish an awaited diary update into a replacement binding", async () => {
  const { workspaceDir, remote, access, release, memoryBridge } = await fixture();
  await fs.writeFile(path.join(remote, "DREAMS.md"), "existing diary");
  await expect(
    updateDreamsFile({
      workspaceDir,
      updater: async () => {
        release();
        releases.push(
          registerAgentWorkspaceAccess(workspaceDir, {
            ...access,
            memoryBridge: { ...memoryBridge },
          }),
        );
        return { content: "stale update", result: true };
      },
    }),
  ).rejects.toThrow("access");
  expect(memoryBridge.writeFile).not.toHaveBeenCalled();
});

it("ingests, rehydrates and promotes remote daily notes through the native pipeline", async () => {
  const { workspaceDir, remote, memoryBridge } = await fixture();
  await fs.mkdir(path.join(remote, "memory"));
  await fs.writeFile(
    path.join(remote, "memory/2026-09-15.md"),
    "# Daily\n\n- Keep release records for thirty days.\n",
  );
  const nowMs = Date.parse("2026-09-15T12:00:00Z");
  await runDreamingSweepPhases({
    workspaceDir,
    agentId: "main",
    nowMs,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    pluginConfig: { dreaming: { timezone: "UTC", phases: { rem: { enabled: false } } } },
  });
  const candidates = await rankShortTermPromotionCandidates({
    workspaceDir,
    nowMs,
    minScore: 0,
    minRecallCount: 0,
    minUniqueQueries: 0,
  });
  expect(candidates.length).toBeGreaterThan(0);
  const rehydrated = await rehydratePromotionCandidate(workspaceDir, candidates[0]!);
  expect(rehydrated?.snippet).toContain("thirty days");
  const result = await applyShortTermPromotions({
    workspaceDir,
    candidates,
    nowMs,
    minScore: 0,
    minRecallCount: 0,
    minUniqueQueries: 0,
  });
  expect(result.applied).toBeGreaterThan(0);
  expect(await fs.readFile(path.join(remote, "MEMORY.md"), "utf8")).toContain("thirty days");
  await expect(fs.access(path.join(workspaceDir, "MEMORY.md"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(memoryBridge.listDirectory).toHaveBeenCalled();
  expect(memoryBridge.listDirectory).toHaveBeenCalledWith({ filePath: "memory", maxEntries: 4096 });
  expect(memoryBridge.readFile).toHaveBeenCalledWith({
    filePath: "memory/2026-09-15.md",
    maxBytes: 8 * 1024 * 1024,
  });
});

it("retains the Gateway session corpus without reading it through the remote bridge", async () => {
  const { workspaceDir, remote, memoryBridge } = await fixture();
  const corpusPath = "memory/.dreams/session-corpus/2026-09-15.txt";
  await fs.mkdir(path.join(workspaceDir, path.dirname(corpusPath)), { recursive: true });
  await fs.writeFile(
    path.join(workspaceDir, corpusPath),
    "Keep release records for thirty days.\n",
  );
  const { statMemoryWorkspaceFile, readMemoryWorkspaceFile } =
    await import("./memory-workspace-files.js");
  expect(
    (await statMemoryWorkspaceFile(workspaceDir, path.join(workspaceDir, corpusPath)))?.type,
  ).toBe("file");
  expect(
    (await readMemoryWorkspaceFile(workspaceDir, path.join(workspaceDir, corpusPath))).toString(),
  ).toContain("thirty days");
  expect(memoryBridge.stat).not.toHaveBeenCalled();
  expect(memoryBridge.readFile).not.toHaveBeenCalled();
  await expect(fs.access(path.join(remote, corpusPath))).rejects.toMatchObject({ code: "ENOENT" });
});
