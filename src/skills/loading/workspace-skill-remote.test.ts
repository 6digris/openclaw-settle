import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readWorkspaceSkillStatusFacts } from "../discovery/status-files.js";
import { prepareWorkspaceSkillStatus } from "../discovery/status.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { OpenClawSkillMetadata, SkillEntry } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { resolveSkillDiscoveryLimits } from "./skill-root-discovery.js";
import {
  loadWorkspaceSkills,
  prepareWorkspaceSkills,
  readWorkspaceSkillSources,
  resolveWorkspaceSkillPromptEntries,
} from "./workspace-skill-loader.js";
import {
  resolveWorkspaceSkillSourcePlan,
  type WorkspaceSkillSourceRequest,
  type WorkspaceSkillSources,
} from "./workspace-skill-sources.js";

const library = vi.hoisted(() => ({ entries: [] as SkillEntry[] }));
vi.mock("../library/selection.js", () => ({
  loadSkillLibrarySelection: () => library.entries,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
it.runIf(process.platform !== "win32")(
  "preserves configured external symlink targets on the workspace host",
  async () => {
    const root = tempDirs.make("remote-skill-symlink-");
    const workspaceDir = path.join(root, "workspace");
    const target = path.join(root, "allowed", "linked");
    await writeSkill({ dir: target, name: "linked", description: "Admitted external skill" });
    await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
    await fs.symlink(target, path.join(workspaceDir, "skills", "linked"), "dir");
    const config = { skills: { load: { allowSymlinkTargets: [path.dirname(target)] } } };
    expect(
      loadWorkspaceSkills(workspaceDir, { config, workspaceOnly: true }).map(
        (entry) => entry.skill.name,
      ),
    ).toEqual(["linked"]);
    const discovered = readWorkspaceSkillSources({
      sourcePlan: resolveWorkspaceSkillSourcePlan(workspaceDir, { config, workspaceOnly: true }),
      limits: resolveSkillDiscoveryLimits(config),
      additionalBins: [],
    });
    expect(discovered.entries.map((entry) => entry.skill.name)).toEqual(["linked"]);
  },
);
afterEach(() => {
  library.entries = [];
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = tempDirs.make("remote-skills-");
  const gateway = path.join(root, "gateway");
  const remote = path.join(root, "remote");
  const execution = path.join(root, "execution");
  const libraryDir = path.join(root, "library");
  const hostPlatform = process.platform === "linux" ? "darwin" : "linux";
  const write = async (workspace: string, name: string, metadata?: OpenClawSkillMetadata) =>
    writeSkill({
      dir: path.join(workspace, "skills", name),
      name,
      description: `${path.basename(workspace)} ${name}`,
      metadata: JSON.stringify({ openclaw: metadata ?? {} }),
      frontmatterExtra: "command-dispatch: tool\ncommand-tool: exec",
    });
  await write(gateway, "stale");
  await write(remote, "available", { os: [hostPlatform], requires: { bins: ["remote-tool"] } });
  await write(remote, "gateway-os", { os: [process.platform] });
  await write(remote, "gateway-bin", { requires: { bins: ["gateway-tool"] } });
  await write(execution, "available");
  await write(execution, "project");
  await write(libraryDir, "pinned", { requires: { bins: ["library-tool"] } });
  library.entries = loadWorkspaceSkills(libraryDir, { workspaceOnly: true });
  const binDir = path.join(gateway, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "gateway-tool"), "#!/bin/sh\n", { mode: 0o755 });
  vi.stubEnv("PATH", binDir);
  const sources: WorkspaceSkillSources = {
    entries: loadWorkspaceSkills(remote, { workspaceOnly: true }),
    executionEntries: loadWorkspaceSkills(execution, { workspaceOnly: true }),
    runtime: { platform: hostPlatform, bins: ["remote-tool", "library-tool"] },
  };
  const bridge = {
    readFile: vi.fn(async () => Buffer.from("unused")),
    writeFile: vi.fn(async () => {}),
    stat: vi.fn(async () => null),
  };
  const options = {
    config: { plugins: { enabled: false } },
    executionWorkspaceDir: execution,
    bundledSkillsDir: path.join(root, "bundled"),
    managedSkillsDir: path.join(root, "managed"),
    librarySelections: [
      { skillId: "pin", revision: "a".repeat(64), name: "pinned", ownerProfileId: null },
    ],
  };
  return { gateway, remote, sources, bridge, options };
}

describe.each(["prompt", "runtime"] as const)("remote %s skill discovery", (caller) => {
  it("retains Gateway Workshop skills at their native precedence", async () => {
    const { gateway, remote, sources, bridge, options } = await fixture();
    const config = {
      ...options.config,
      agents: { entries: { main: { agentDir: path.join(gateway, "agent") } } },
    };
    const workshopDir = resolveWorkshopSkillsDir(config, "main");
    const bundledSkillsDir = path.join(remote, "bundled");
    const managedSkillsDir = path.join(remote, "managed");
    for (const [dir, name, description] of [
      [workshopDir, "workshop-wins", "Gateway Workshop instructions"],
      [workshopDir, "managed-wins", "Shadowed Workshop instructions"],
      [bundledSkillsDir, "workshop-wins", "Host bundled instructions"],
      [managedSkillsDir, "managed-wins", "Host managed instructions"],
    ] as const) {
      await writeSkill({ dir: path.join(dir, name), name, description });
    }
    sources.entries = loadWorkspaceSkills(remote, {
      config: options.config,
      bundledSkillsDir,
      managedSkillsDir,
    });
    const release = registerAgentWorkspaceAccess(gateway, {
      bridge,
      loadSkills: async () => sources,
    });
    try {
      const params = { ...options, config, agentId: "main" };
      const entries =
        caller === "prompt"
          ? (await resolveWorkspaceSkillPromptEntries(gateway, params)).eligible
          : await prepareWorkspaceSkills(gateway, params);
      expect(entries.find((entry) => entry.skill.name === "workshop-wins")?.skill).toMatchObject({
        description: "Gateway Workshop instructions",
        filePath: path.join(workshopDir, "workshop-wins", "SKILL.md"),
      });
      expect(entries.find((entry) => entry.skill.name === "managed-wins")?.skill.description).toBe(
        "Host managed instructions",
      );
      if (caller === "runtime") {
        await fs.writeFile(
          path.join(workshopDir, "workshop-wins", "skill-card.md"),
          "Workshop card",
        );
        sources.status = readWorkspaceSkillStatusFacts({
          entries: sources.entries,
          workspaceDir: remote,
          managedSkillsDir,
        });
        const status = await prepareWorkspaceSkillStatus(gateway, {
          ...params,
          skillCardKey: "workshop-wins",
        });
        expect(status.files.find((file) => file.name === "workshop-wins")?.skillCard?.content).toBe(
          "Workshop card",
        );
      }
    } finally {
      release();
    }
  });

  it("uses workspace host facts while retaining execution precedence and Library selections", async () => {
    const { gateway, remote, sources, bridge, options } = await fixture();
    const loadSkills = vi.fn(async (_request: WorkspaceSkillSourceRequest) => sources);
    const release = registerAgentWorkspaceAccess(gateway, { bridge, loadSkills });
    try {
      const entries =
        caller === "prompt"
          ? (await resolveWorkspaceSkillPromptEntries(gateway, options)).eligible
          : await prepareWorkspaceSkills(gateway, options);
      expect(entries.map((entry) => entry.skill.name)).toEqual(["available", "project", "pinned"]);
      expect(entries[0]?.skill.baseDir).toBe(path.join(remote, "skills", "available"));
      expect(entries[0]?.frontmatter["command-tool"]).toBe("exec");
      expect(entries[0]?.disableCommandDispatch).not.toBe(true);
      expect(loadSkills.mock.calls[0]?.[0]).toMatchObject({
        executionWorkspaceDir: options.executionWorkspaceDir,
        additionalBins: ["library-tool"],
      });
    } finally {
      release();
    }
  });

  it("rejects discovery completed after its workspace binding stops", async () => {
    const { gateway, sources, bridge, options } = await fixture();
    const deferred = createDeferredCore<WorkspaceSkillSources>();
    const release = registerAgentWorkspaceAccess(gateway, {
      bridge,
      loadSkills: () => deferred.promise,
    });
    const pending =
      caller === "prompt"
        ? resolveWorkspaceSkillPromptEntries(gateway, options)
        : prepareWorkspaceSkills(gateway, options);
    const rejected = expect(pending).rejects.toThrow("stopped or not ready");
    release();
    deferred.resolve(sources);
    await rejected;
  });
});

it.each(["pinned", "stale"])(
  "reads only authorized Gateway Library files for the %s card",
  async (skillCardKey) => {
    const { gateway, remote, sources, bridge, options } = await fixture();
    await fs.writeFile(
      path.join(library.entries[0]!.skill.baseDir, "skill-card.md"),
      "# Library card\n",
    );
    await fs.writeFile(
      path.join(gateway, "skills", "stale", "skill-card.md"),
      "# Gateway private card\n",
    );
    const forged = loadWorkspaceSkills(gateway, { workspaceOnly: true })[0]!;
    forged.skill.source = "openclaw-library";
    forged.skill.fileHost = "gateway";
    sources.entries.push(forged);
    sources.status = {
      workspaceDir: remote,
      managedSkillsDir: path.join(remote, "managed"),
      files: [],
    };
    const release = registerAgentWorkspaceAccess(gateway, {
      bridge,
      loadSkills: async () => sources,
    });
    try {
      const prepared = await prepareWorkspaceSkillStatus(gateway, { ...options, skillCardKey });
      expect(prepared.files.find((file) => file.name === "stale")).toBeUndefined();
      expect(prepared.files.find((file) => file.name === "pinned")?.skillCard).toMatchObject({
        present: true,
      });
      if (skillCardKey === "pinned") {
        expect(prepared.files.find((file) => file.name === "pinned")?.skillCard?.content).toBe(
          "# Library card\n",
        );
      }
    } finally {
      release();
    }
  },
);
