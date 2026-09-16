import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SandboxFsBridge } from "../../agents/sandbox/fs-bridge.types.js";
import {
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "../../agents/workspace-access.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  listSkillCommandsForAgents,
  prepareSkillCommandsForWorkspace,
} from "../discovery/chat-commands.js";
import { buildWorkspaceSkillCommandSpecs } from "../discovery/command-specs.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import {
  loadMergedWorkspaceSkills,
  loadWorkspaceSkills,
} from "../loading/workspace-skill-loader.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { writePluginWithSkill } from "../test-support/skill-plugin-fixtures.test-support.js";
import { resolveEmbeddedRunSkillEntries } from "./embedded-run-entries.js";
import { bumpSkillsSnapshotVersion } from "./refresh-state.js";
import { resolveReusableWorkspaceSkillSnapshot } from "./session-snapshot.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const releases: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const release of releases.splice(0)) {
    release();
  }
});
const unusedBridge: SandboxFsBridge = {
  resolvePath: () => {
    throw new Error("skill discovery must not use owner file access");
  },
  readFile: async () => {
    throw new Error("skill discovery must not use owner file access");
  },
  writeFile: async () => {
    throw new Error("unused");
  },
  mkdirp: async () => {
    throw new Error("unused");
  },
  remove: async () => {
    throw new Error("unused");
  },
  rename: async () => {
    throw new Error("unused");
  },
  stat: async () => {
    throw new Error("unused");
  },
};

async function fixture() {
  const gateway = await fs.realpath(tempDirs.make("openclaw-skill-gateway-"));
  const harness = await fs.realpath(tempDirs.make("openclaw-skill-harness-"));
  await writeSkill({
    dir: path.join(gateway, "skills", "decoy"),
    name: "decoy",
    description: "Gateway mirror must never win",
  });
  const provider: NonNullable<AgentWorkspaceAccess["loadSkills"]> = async ({ limits }) => {
    // The production transport uses a fresh process. In this same-process fixture, invalidate its native loader.
    bumpSkillsSnapshotVersion({ workspaceDir: harness });
    const entries = loadWorkspaceSkills(harness, {
      workspaceOnly: true,
      config: { skills: { limits } },
    });
    const runtime = { platform: "linux", bins: ["harness-only-binary"] };
    return {
      entries,
      runtime,
      revision: createHash("sha256").update(JSON.stringify({ entries, runtime })).digest("hex"),
    };
  };
  const loadSkills = vi.fn(provider);
  const access = { bridge: unusedBridge, loadSkills };
  const release = registerAgentWorkspaceAccess(gateway, access);
  releases.push(release);
  const add = async (name: string, metadata?: string) =>
    writeSkill({
      dir: path.join(harness, "skills", name),
      name,
      description: `Harness ${name}`,
      metadata,
      body: "Read ./reference.md and execute ./script.sh on the Harness.",
    });
  const prepare = () =>
    resolveReusableWorkspaceSkillSnapshot({ workspaceDir: gateway, config: {}, watch: false });
  return { gateway, harness, loadSkills, provider, access, release, add, prepare };
}

it("discovers native Harness fixtures, retains Gateway filters and uses only Harness runtime capabilities", async () => {
  const f = await fixture();
  await f.add("allowed", '{"openclaw":{"requires":{"bins":["harness-only-binary"]}}}');
  await f.add("disabled");
  await f.add("gateway-bin", '{"openclaw":{"requires":{"bins":["node"]}}}');
  await f.add("wrong-os", '{"openclaw":{"os":["darwin"]}}');
  const { snapshot } = await resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: f.gateway,
    config: { skills: { entries: { disabled: { enabled: false } } } },
    skillFilter: ["allowed", "disabled", "gateway-bin", "wrong-os"],
    watch: false,
  });
  expect(snapshot.skills.map((skill) => skill.name)).toEqual(["allowed"]);
  expect(snapshot.prompt).toContain(path.join(f.harness, "skills", "allowed", "SKILL.md"));
  expect(snapshot.prompt).not.toContain("decoy");
  const location = snapshot.resolvedSkills?.[0]?.filePath;
  expect(
    await fs.readFile(expectDefined(location, "advertised Harness skill path"), "utf8"),
  ).toContain("./script.sh");
  expect(f.loadSkills).toHaveBeenCalledOnce();
});

it("rehydrates persisted snapshots and removes deleted skills without reading a Gateway decoy", async () => {
  const f = await fixture();
  await f.add("original");
  const first = await f.prepare();
  const { resolvedSkills: _discard, ...persisted } = first.snapshot;
  const restored = await resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: f.gateway,
    config: {},
    existingSnapshot: persisted,
    watch: false,
  });
  expect(restored.snapshot.resolvedSkills?.map((skill) => skill.name)).toEqual(["original"]);
  const fromDifferentClock = await resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: f.gateway,
    config: {},
    existingSnapshot: { ...persisted, version: Number.MAX_SAFE_INTEGER },
    watch: false,
  });
  expect(fromDifferentClock.shouldRefresh).toBe(true);
  expect(fromDifferentClock.snapshot.version).toBe(restored.snapshot.version);
  await fs.rm(path.join(f.harness, "skills", "original"), { recursive: true });
  await f.add("replacement");
  const changed = await resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: f.gateway,
    config: {},
    existingSnapshot: persisted,
    watch: false,
  });
  expect(changed.shouldRefresh).toBe(true);
  expect(changed.snapshot.skills.map((skill) => skill.name)).toEqual(["replacement"]);
  expect(() =>
    resolveEmbeddedRunSkillEntries({ workspaceDir: f.gateway, skillsSnapshot: first.snapshot }),
  ).toThrow(/stale/);
  expect(
    resolveEmbeddedRunSkillEntries({ workspaceDir: f.gateway }).skillEntries.map(
      (entry) => entry.skill.name,
    ),
  ).toEqual(["replacement"]);
});

it("rejects an in-flight catalog after re-registration of the same provider and fences hydrated snapshots after revoke", async () => {
  const f = await fixture();
  await f.add("current");
  const first = await f.prepare();
  const gate = createDeferredCore();
  const entered = createDeferredCore();
  f.loadSkills.mockImplementationOnce(async (params) => {
    entered.resolve();
    await gate.promise;
    return f.provider(params);
  });
  const pending = f.prepare();
  await entered.promise;
  f.release();
  releases.push(registerAgentWorkspaceAccess(f.gateway, f.access));
  gate.resolve();
  await expect(pending).rejects.toThrow(/changed/);
  expect(() => loadWorkspaceSkills(f.gateway)).toThrow(/unavailable/);
  const newest = await f.prepare();
  expect(newest.snapshot.skills).toEqual(first.snapshot.skills);
  releases.at(-1)?.();
  expect(() =>
    resolveEmbeddedRunSkillEntries({ workspaceDir: f.gateway, skillsSnapshot: newest.snapshot }),
  ).toThrow(/stopped/);
});

it("does not reuse an old catalog after cancellation, transport failure or malformed data", async () => {
  const f = await fixture();
  await f.add("current");
  await f.prepare();
  const controller = new AbortController();
  f.loadSkills.mockImplementationOnce(async (params) => {
    const result = await f.provider(params);
    controller.abort();
    return result;
  });
  await expect(
    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: f.gateway,
      config: {},
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(() => loadWorkspaceSkills(f.gateway)).toThrow(/unavailable/);
  await f.prepare();
  f.loadSkills.mockRejectedValueOnce(new Error("transport unavailable"));
  await expect(f.prepare()).rejects.toThrow("transport unavailable");
  expect(() => loadWorkspaceSkills(f.gateway)).toThrow(/unavailable/);
  f.loadSkills.mockImplementationOnce(async (params) => {
    const result = await f.provider(params);
    expectDefined(result.entries[0], "loaded skill fixture").skill.filePath = "/outside/SKILL.md";
    return result;
  });
  await expect(f.prepare()).rejects.toThrow(/invalid/);
});

it("prepares remote commands before snapshot admission and rejects unsupported status/extra roots", async () => {
  const f = await fixture();
  await f.add("current");
  expect(() => buildWorkspaceSkillCommandSpecs(f.gateway)).toThrow(/unavailable/);
  const cfg = { agents: { list: [{ id: "main", workspace: f.gateway }] } };
  const commands = await prepareSkillCommandsForWorkspace({ workspaceDir: f.gateway, cfg });
  expect(commands.map((command) => command.skillName)).toEqual(["current"]);
  expect(commands[0]?.skillFile).toBe(path.join(f.harness, "skills", "current", "SKILL.md"));
  expect(f.loadSkills).toHaveBeenCalledOnce();
  const preparedCommands = listSkillCommandsForAgents({
    cfg,
    agentIds: ["main"],
  });
  expect(preparedCommands.map((command) => command.skillName)).toEqual(["current"]);
  expect(() =>
    listSkillCommandsForAgents({
      cfg: { ...cfg, plugins: { enabled: false } },
      agentIds: ["main"],
    }),
  ).toThrow(/policy changed/);
  expect(() => buildWorkspaceSkillStatus(f.gateway)).toThrow(/not authoritative/);
  expect(() =>
    loadMergedWorkspaceSkills({
      agentWorkspaceDir: f.gateway,
      executionSkillsDir: path.join(f.gateway, ".agents", "skills"),
    }),
  ).toThrow(/additional execution skill root/);
});

it("refreshes persisted prompts when Gateway policy changes without a catalog revision change", async () => {
  const f = await fixture();
  await f.add("current");
  const first = await f.prepare();
  const changed = await resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: f.gateway,
    config: { skills: { entries: { current: { enabled: false } } } },
    existingSnapshot: first.snapshot,
    hydrateExisting: false,
    watch: false,
  });
  expect(changed.shouldRefresh).toBe(true);
  expect(changed.snapshot.skills).toEqual([]);
  expect(changed.snapshot.prompt).not.toContain("current");
});

it("preserves Harness paths even when Gateway home or symlinks give them a different meaning", async () => {
  const f = await fixture();
  await f.add("current");
  const advertisedRoot = path.join(f.gateway, "harness-shadow");
  await fs.symlink(f.harness, advertisedRoot, "dir");
  vi.stubEnv("HOME", advertisedRoot);
  f.loadSkills.mockImplementation(async (params) => {
    const result = await f.provider(params);
    const entries = result.entries.map((entry) => {
      const baseDir = path.join(advertisedRoot, "skills", entry.skill.name);
      const filePath = path.join(baseDir, "SKILL.md");
      return {
        ...entry,
        skill: {
          ...entry.skill,
          baseDir,
          filePath,
          sourceInfo: { ...entry.skill.sourceInfo, baseDir, path: filePath },
        },
      };
    });
    return { ...result, entries, revision: `${result.revision}:shadow` };
  });
  const expectedPath = path.join(advertisedRoot, "skills", "current", "SKILL.md");
  const commands = await prepareSkillCommandsForWorkspace({ workspaceDir: f.gateway, cfg: {} });
  expect(commands[0]?.skillFile).toBe(expectedPath);
  expect((await f.prepare()).snapshot.prompt).toContain(expectedPath);
});

it("sends only plugin roots enabled by native Gateway policy to the remote provider", async () => {
  const f = await fixture();
  const pluginRoot = tempDirs.make("openclaw-remote-catalog-plugin-");
  await writePluginWithSkill({
    pluginRoot,
    pluginId: "remote-catalog-fixture",
    skillId: "plugin-skill",
    skillDescription: "Fixture plugin skill",
  });
  const prepare = (enabled: boolean) =>
    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: f.gateway,
      config: {
        plugins: {
          allow: ["remote-catalog-fixture"],
          load: { paths: [pluginRoot] },
          entries: { "remote-catalog-fixture": { enabled } },
        },
      },
      watch: false,
    });
  await prepare(true);
  expect(f.loadSkills.mock.lastCall?.[0].pluginSkillRoots).toContainEqual({
    dir: path.join(pluginRoot, "skills"),
    rejectHardlinks: true,
  });
  await prepare(false);
  expect(f.loadSkills.mock.lastCall?.[0].pluginSkillRoots).toEqual([]);
});
