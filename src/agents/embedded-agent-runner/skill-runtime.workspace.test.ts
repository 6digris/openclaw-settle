import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  loadWorkspaceSkills,
  prepareWorkspaceSkills,
} from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import type { SkillEntry } from "../../skills/types.js";
import { resolveWorkshopSkillsDir } from "../../skills/workshop/skills-root.js";
import { readCodeModeSkill } from "../code-mode-skills.js";
import { registerAgentWorkspaceAccess } from "../workspace-access.js";
import { prepareEmbeddedSkills } from "./skill-runtime.js";

const libraryFixture = vi.hoisted(() => ({ entries: [] as SkillEntry[] }));
vi.mock("../../skills/library/selection.js", () => ({
  loadSkillLibrarySelection: (selections: readonly unknown[]) =>
    selections.length > 0 ? libraryFixture.entries : [],
}));

const temps = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  libraryFixture.entries = [];
  vi.unstubAllEnvs();
});

it("Code Mode reads live host instructions without granting document-bridge access", async () => {
  const root = temps.make("code-mode-workspace-");
  const bundled = path.join(root, "bundled");
  await fs.mkdir(bundled);
  vi.stubEnv("OPENCLAW_BUNDLED_SKILLS_DIR", bundled);
  vi.stubEnv("HOME", root);
  vi.stubEnv("OPENCLAW_HOME", root);
  const gateway = path.join(root, "gateway");
  const host = path.join(root, "host");
  const library = path.join(root, "library");
  const relative = "skills/guide/SKILL.md";
  const header = "---\nname: guide\ndescription: Test guide\n---\n";
  for (const [dir, body] of [
    [gateway, "stale Gateway body"],
    [host, "current host body"],
  ] as const) {
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true });
    await fs.writeFile(path.join(dir, relative), header + body);
  }
  await fs.mkdir(path.join(library, "skills/pinned"), { recursive: true });
  const libraryBody = "---\nname: pinned\ndescription: Pinned guide\n---\nGateway Library body";
  await fs.writeFile(path.join(library, "skills/pinned/SKILL.md"), libraryBody);
  // Resolve the fixture pin without a Library database; instruction reads still use real files.
  libraryFixture.entries = loadWorkspaceSkills(library, { workspaceOnly: true });
  const config = {
    plugins: { enabled: false },
    agents: { entries: { main: { agentDir: path.join(root, "agent") } } },
  };
  const workshopDir = path.join(resolveWorkshopSkillsDir(config, "main"), "workshop");
  await writeSkill({
    dir: workshopDir,
    name: "workshop",
    description: "Workshop guide",
    body: "Workshop body",
  });
  const readFile = vi.fn(async () => {
    throw new Error("Agent-document access does not grant Skill reads");
  });
  const skillResources = {
    resolveExplicitSkill: vi.fn(),
    readSkillFiles: vi.fn(),
    readInstructions: (filePath: string, options: { signal?: AbortSignal }) => {
      if (!filePath.startsWith(gateway + path.sep)) {
        throw new Error("The host cannot read Gateway Library files");
      }
      return fs.readFile(path.join(host, path.relative(gateway, filePath)), {
        encoding: "utf8",
        signal: options.signal,
      });
    },
  };
  const release = registerAgentWorkspaceAccess(gateway, {
    bridge: { readFile, writeFile: vi.fn(), stat: vi.fn() },
    skillResources,
    loadSkills: async () => ({
      entries: [],
      executionEntries: [],
      runtime: { platform: process.platform, bins: [] },
    }),
  });
  try {
    const snapshot = await buildSkillSnapshot(gateway, {
      config,
      agentId: "main",
      entries: [
        ...loadWorkspaceSkills(gateway, { workspaceOnly: true }),
        ...loadWorkspaceSkills(library, { workspaceOnly: true }),
        ...(await prepareWorkspaceSkills(gateway, { config, agentId: "main" })),
      ],
    });
    // A hydrated Library selection carries its Gateway artifact path, without inline bytes.
    snapshot.librarySelections = [
      { skillId: "pin", revision: "a".repeat(64), name: "pinned", ownerProfileId: null },
    ];
    expect(snapshot.prompt).toContain("<location>~/");
    const prepared = await prepareEmbeddedSkills({
      attempt: { config: {}, skillsSnapshot: snapshot },
      effectiveWorkspace: gateway,
      sandbox: undefined,
      sessionAgentId: "main",
      includeCodeModeSkills: true,
      applySkillEnvironment: false,
    });
    expect(prepared.codeModeSkills).toHaveLength(3);
    const skill = prepared.codeModeSkills.find((entry) => entry.name === "guide")!;
    expect(await readCodeModeSkill(skill)).toBe(header + "current host body");
    await fs.writeFile(path.join(host, relative), header + "edited host body");
    expect(await readCodeModeSkill(skill)).toBe(header + "edited host body");
    const pinned = prepared.codeModeSkills.find((entry) => entry.name === "pinned")!;
    expect(await readCodeModeSkill(pinned)).toBe(libraryBody);
    const workshop = prepared.codeModeSkills.find((entry) => entry.name === "workshop")!;
    expect(await readCodeModeSkill(workshop)).toContain("Workshop body");
    await fs.appendFile(path.join(workshopDir, "SKILL.md"), "\nWorkshop edit");
    expect(await readCodeModeSkill(workshop)).toContain("Workshop edit");
    expect(readFile).not.toHaveBeenCalled();
    release();
    await expect(readCodeModeSkill(skill)).rejects.toThrow("Workspace access is stopped");
  } finally {
    release();
  }
});
