import fs from "node:fs/promises";
import path from "node:path";
import {
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { filterLiveShortTermRecallEntries } from "./short-term-promotion-record.js";
import type { ShortTermRecallEntry } from "./short-term-promotion-types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const releases: Array<() => void> = [];
afterEach(() => {
  for (const release of releases.splice(0)) {
    release();
  }
});
const entry: ShortTermRecallEntry = {
  key: "daily",
  path: "memory/2026-09-15.md",
  startLine: 1,
  endLine: 1,
  source: "memory",
  snippet: "retain this recall",
  recallCount: 3,
  dailyCount: 1,
  groundedCount: 0,
  totalScore: 3,
  maxScore: 1,
  firstRecalledAt: "2026-09-15T00:00:00Z",
  lastRecalledAt: "2026-09-15T00:00:00Z",
  queryHashes: [],
  recallDays: ["2026-09-15"],
  conceptTags: [],
};
function bind(workspaceDir: string) {
  const bridge = {
    resolvePath: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdirp: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    stat: vi.fn<AgentWorkspaceAccess["bridge"]["stat"]>(),
  } satisfies AgentWorkspaceAccess["bridge"];
  const release = registerAgentWorkspaceAccess(workspaceDir, { bridge, memoryBridge: bridge });
  releases.push(release);
  return { bridge, release };
}

it("keeps recall entries whose source exists only on the remote workspace", async () => {
  const workspaceDir = tempDirs.make("remote-recall-live-");
  const { bridge } = bind(workspaceDir);
  vi.mocked(bridge.stat).mockResolvedValue({ type: "file", size: 10, mtimeMs: 1 });
  await expect(
    filterLiveShortTermRecallEntries({ workspaceDir, entries: [entry] }),
  ).resolves.toEqual([entry]);
});

it("does not erase recalls when remote stat is unavailable or revoked", async () => {
  const workspaceDir = tempDirs.make("remote-recall-unavailable-");
  const { bridge, release } = bind(workspaceDir);
  vi.mocked(bridge.stat).mockRejectedValueOnce(new Error("remote unavailable"));
  await expect(
    filterLiveShortTermRecallEntries({ workspaceDir, entries: [entry] }),
  ).rejects.toThrow("remote unavailable");
  vi.mocked(bridge.stat).mockImplementationOnce(async () => {
    release();
    return { type: "file", size: 10, mtimeMs: 1 };
  });
  await expect(
    filterLiveShortTermRecallEntries({ workspaceDir, entries: [entry] }),
  ).rejects.toThrow("access");
});

it("drops a missing remote source despite a stale Gateway copy", async () => {
  const workspaceDir = tempDirs.make("remote-recall-decoy-");
  await fs.mkdir(path.join(workspaceDir, "memory"));
  await fs.writeFile(path.join(workspaceDir, entry.path), "stale Gateway copy");
  const { bridge } = bind(workspaceDir);
  vi.mocked(bridge.stat).mockResolvedValue(null);
  await expect(
    filterLiveShortTermRecallEntries({ workspaceDir, entries: [entry] }),
  ).resolves.toEqual([]);
});
