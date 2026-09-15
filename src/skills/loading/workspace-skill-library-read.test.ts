import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillLibrarySelection } from "../../../packages/gateway-protocol/src/schema/skill-library.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { CONFIG_DIR, pinConfigDir } from "../../utils.js";
import * as commandDiscovery from "../discovery/chat-commands.js";
import * as librarySelection from "../library/selection.js";
import { saveSkillLibrary } from "../library/service.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import {
  prepareWorkspaceSkills,
  resolveWorkspaceSkillPromptEntries,
} from "./workspace-skill-loader.js";

// Plugin command discovery has independent registry storage; this proof owns Library reads.
vi.mock("../../plugins/bundle-commands.js", () => ({
  loadEnabledClaudeBundleCommands: () => [],
}));

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
const content = "---\nname: guide\ndescription: Captured procedure\n---\n# Synthetic guide\n";

function spyOnParentSql() {
  const native = requireNodeSqlite();
  return [
    vi.spyOn(native.DatabaseSync.prototype, "prepare"),
    vi.spyOn(native.DatabaseSync.prototype, "exec"),
    vi.spyOn(native.DatabaseSync.prototype, "close"),
    ...(["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(native.StatementSync.prototype, method),
    ),
  ];
}

async function fixture(skillContent = content) {
  const root = dirs.make("workspace-library-read-");
  const workspaceDir = dirs.make("workspace-library-workspace-");
  const config: OpenClawConfig = { plugins: { enabled: false } };
  const options = { env: { OPENCLAW_STATE_DIR: root } };
  const profile = ensureProfileForEmail("reader@example.test", options);
  const authority = {
    profileId: profile.id,
    scopes: ["operator.read", "operator.write"],
    getConfig: () => config,
    assertCurrent() {},
  };
  const saved = await saveSkillLibrary(
    authority,
    { slug: "guide", content: skillContent, expectedRevision: null },
    options,
  );
  const pin: SkillLibrarySelection = {
    skillId: saved.entry.skillId,
    revision: saved.entry.revision,
    name: saved.entry.name,
    ownerProfileId: saved.entry.ownerProfileId,
  };
  const updated = await saveSkillLibrary(
    authority,
    {
      skillId: pin.skillId,
      slug: "guide",
      content: skillContent.replace("Captured procedure", "Replacement procedure"),
      expectedRevision: pin.revision,
    },
    options,
  );
  await closeOpenClawStateDatabaseAsync();
  const loadOptions = {
    config,
    managedSkillsDir: path.join(root, "skills"),
    bundledSkillsDir: path.join(root, "bundled"),
    librarySelections: [pin],
  };
  return {
    root,
    workspaceDir,
    pin,
    updated,
    config,
    loadOptions,
    async run<T>(use: () => Promise<T>): Promise<T> {
      const originalConfigDir = CONFIG_DIR;
      try {
        return await withEnvAsync(
          {
            OPENCLAW_STATE_DIR: root,
            OPENCLAW_BUNDLED_SKILLS_DIR: loadOptions.bundledSkillsDir,
          },
          async () => {
            pinConfigDir();
            return await use();
          },
        );
      } finally {
        pinConfigDir({ OPENCLAW_STATE_DIR: originalConfigDir });
      }
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Surface = "workspace" | "prompt" | "commands";

async function prepare(
  surface: Surface,
  test: Fixture,
  skillFilter?: string[],
  assertCurrent?: () => void,
) {
  if (surface === "commands") {
    return (
      await commandDiscovery.prepareSkillCommandsForWorkspace(
        {
          workspaceDir: test.workspaceDir,
          cfg: test.config,
          sessionEntry: {
            // This supplied session policy avoids unrelated host-approval SQLite reads.
            permissionMode: "full",
            skillLibrarySelections: test.loadOptions.librarySelections,
          },
          skillFilter,
        },
        assertCurrent,
      )
    ).map((command) => ({
      name: command.skillName,
      description: command.description,
      filePath: command.skillFile,
    }));
  }
  const options = { ...test.loadOptions, skillFilter, eligibility: {} };
  const entries =
    surface === "prompt"
      ? (
          await resolveWorkspaceSkillPromptEntries(test.workspaceDir, {
            ...options,
            assertCurrent,
          })
        ).eligible
      : await prepareWorkspaceSkills(test.workspaceDir, options, assertCurrent);
  return entries.map(({ skill }) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
  }));
}

describe.each(["workspace", "prompt", "commands"] as const)(
  "%s pinned Library preparation",
  (surface) => {
    it("reads the saved revision cold and warm without parent SQL, then filters the combined inventory", async () => {
      const test = await fixture();
      await writeSkill({
        dir: path.join(test.workspaceDir, "skills", "local"),
        name: "local",
        description: "Local procedure",
      });
      const counters = spyOnParentSql();
      await test.run(async () => {
        for (let pass = 0; pass < 2; pass++) {
          const entries = await prepare(surface, test);
          expect(entries.map(({ name }) => name)).toEqual(["local", test.pin.name]);
          const selected = entries[1]!;
          expect(selected.description).toBe("Captured procedure");
          expect(fs.readFileSync(selected.filePath!, "utf8")).toBe(content);
          expect(selected.filePath).toContain(`${path.sep}${test.pin.revision}${path.sep}`);
        }
        expect((await prepare(surface, test, [test.pin.name])).map(({ name }) => name)).toEqual([
          test.pin.name,
        ]);
        expect((await prepare(surface, test, ["local"])).map(({ name }) => name)).toEqual([
          "local",
        ]);
        expect(await prepare(surface, test, [])).toEqual([]);
        test.loadOptions.librarySelections = [];
        expect((await prepare(surface, test)).map(({ name }) => name)).toEqual(["local"]);
        await closeOpenClawStateDatabaseAsync();
      });
      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it("rechecks Library binary eligibility after PATH changes during its asynchronous probe", async () => {
      const test = await fixture(
        content.replace(
          "description: Captured procedure",
          'description: Captured procedure\nmetadata: {"openclaw":{"requires":{"bins":["pinned-tool"]}}}',
        ),
      );
      const binDir = dirs.make("workspace-library-bins-");
      const replacement = dirs.make("workspace-library-empty-bins-");
      fs.writeFileSync(path.join(binDir, "pinned-tool"), "fixture", { mode: 0o755 });
      const access = fsPromises.access;
      const asyncAccess = vi.spyOn(fsPromises, "access").mockImplementation(async (...args) => {
        if (args[0] === path.join(binDir, "pinned-tool")) {
          process.env.PATH = replacement;
        }
        return await access(...args);
      });
      const syncAccess = vi.spyOn(fs, "accessSync");
      await test.run(async () => {
        await withEnvAsync({ PATH: binDir, PATHEXT: "" }, async () => {
          expect(await prepare(surface, test)).toEqual([]);
        });
      });
      expect(
        asyncAccess.mock.calls
          .map(([file]) => String(file))
          .filter((file) => [binDir, replacement].includes(path.dirname(file))),
      ).toEqual([path.join(binDir, "pinned-tool"), path.join(replacement, "pinned-tool")]);
      expect(
        syncAccess.mock.calls.filter(([file]) =>
          [binDir, replacement].includes(path.dirname(String(file))),
        ),
      ).toEqual([]);
    });

    it("rejects an invalidated caller after Library preparation yields", async () => {
      const test = await fixture();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const original = librarySelection.prepareSkillLibrarySelection;
      vi.spyOn(librarySelection, "prepareSkillLibrarySelection").mockImplementationOnce(
        async (...args) => {
          const entries = await original(...args);
          entered.resolve();
          await release.promise;
          return entries;
        },
      );
      await test.run(async () => {
        let current = true;
        const pending = prepare(surface, test, undefined, () => {
          if (!current) {
            throw new Error("Synthetic caller was invalidated");
          }
        });
        const rejected = expect(pending).rejects.toThrow("Synthetic caller was invalidated");
        try {
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Library preparation did not yield");
            }),
          ]);
          current = false;
        } finally {
          release.resolve();
        }
        await rejected;
      });
    });
  },
);

it("keeps single-agent commands sorted and deduplicated while preparing a cold and warm saved pin", async () => {
  const test = await fixture();
  test.config.agents = {
    entries: {
      alpha: { workspace: test.workspaceDir, agentDir: path.join(test.root, "alpha") },
    },
  };
  for (const [index, name] of ["alpha", "ALPHA", "zulu"].entries()) {
    await writeSkill({
      dir: path.join(test.workspaceDir, "skills", `local-${index}`),
      name,
      description: `${name} local procedure`,
    });
  }
  const counters = spyOnParentSql();
  await test.run(async () => {
    for (let pass = 0; pass < 2; pass++) {
      const commands = await commandDiscovery.prepareSkillCommandsForAgents({
        cfg: test.config,
        agentIds: ["alpha"],
        sessionEntry: {
          permissionMode: "full",
          skillLibrarySelections: [test.pin],
        },
      });
      expect(commands.map((command) => command.skillName.toLowerCase())).toEqual([
        "alpha",
        test.pin.name,
        "zulu",
      ]);
      expect(commands.map((command) => command.name)).toEqual(["alpha", test.pin.name, "zulu"]);
      const selected = commands[1]!;
      expect(selected.description).toBe("Captured procedure");
      expect(selected.skillFile).toContain(`${path.sep}${test.pin.revision}${path.sep}`);
      expect(fs.readFileSync(selected.skillFile!, "utf8")).toBe(content);
    }
    await closeOpenClawStateDatabaseAsync();
  });
  expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0]);
});

describe.each(["workspace", "prompt"] as const)("%s Library retry", (surface) => {
  it("keeps the invocation's Library root and pin values when a workspace refresh retries after an await", async () => {
    const test = await fixture();
    const capturedPin = { ...test.pin };
    const otherRoot = dirs.make("workspace-library-other-");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const original = librarySelection.prepareSkillLibrarySelection;
    vi.spyOn(librarySelection, "prepareSkillLibrarySelection").mockImplementationOnce(
      async (...args) => {
        entered.resolve();
        await release.promise;
        return await original(...args);
      },
    );
    await test.run(async () => {
      const pending =
        surface === "workspace"
          ? prepareWorkspaceSkills(test.workspaceDir, test.loadOptions).then((entries) =>
              entries.map(({ skill }) => ({
                name: skill.name,
                description: skill.description,
                filePath: skill.filePath,
              })),
            )
          : prepare(surface, test);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("Library preparation did not yield");
          }),
        ]);
        process.env.OPENCLAW_STATE_DIR = otherRoot;
        test.pin.revision = test.updated.entry.revision;
        test.pin.name = "changed-during-preparation";
        test.loadOptions.librarySelections.push({
          skillId: test.updated.entry.skillId,
          revision: test.updated.entry.revision,
          name: "added-during-preparation",
          ownerProfileId: test.updated.entry.ownerProfileId,
        });
        await writeSkill({
          dir: path.join(test.workspaceDir, "skills", "arrived"),
          name: "arrived",
          description: "Arrived during preparation",
        });
        bumpSkillsSnapshotVersion({ workspaceDir: test.workspaceDir, reason: "manual" });
      } finally {
        release.resolve();
      }
      const entries = await pending;
      expect(entries.map(({ name }) => name)).toEqual(["arrived", capturedPin.name]);
      expect(entries[1]?.description).toBe("Captured procedure");
      expect(entries[1]?.filePath).toBe(
        path.join(
          test.root,
          "skill-library",
          capturedPin.skillId,
          "revisions",
          capturedPin.revision,
          "SKILL.md",
        ),
      );
      expect(fs.readFileSync(entries[1]!.filePath!, "utf8")).toBe(content);
      expect(fs.existsSync(path.join(otherRoot, "state", "openclaw.sqlite"))).toBe(false);
    });
  });
});

it("preserves repeated pin identity and input order in unfiltered workspace inventory", async () => {
  const test = await fixture();
  const alias = { ...test.pin, name: "captured-alias" };
  await test.run(async () => {
    const entries = await prepareWorkspaceSkills(test.workspaceDir, {
      ...test.loadOptions,
      librarySelections: [test.pin, alias, test.pin],
    });
    expect(entries.map(({ skill }) => skill.name)).toEqual([
      test.pin.name,
      alias.name,
      test.pin.name,
    ]);
    expect(entries.map((entry) => entry.syncDirName)).toEqual(
      Array(3).fill(`library-${test.pin.skillId}-${test.pin.revision}`),
    );
  });
});

it.each([{ entries: [] }, { entries: [createFixtureSkillEntry("prepared")] }])(
  "uses supplied prompt entries without reading Library pins",
  async ({ entries }: { entries: SkillEntry[] }) => {
    const workspaceDir = dirs.make("workspace-library-prepared-");
    const read = vi.spyOn(librarySelection, "prepareSkillLibrarySelection");
    const result = await resolveWorkspaceSkillPromptEntries(workspaceDir, {
      entries,
      librarySelections: [
        { skillId: "unused", revision: "unused", name: "unused", ownerProfileId: null },
      ],
    });
    expect(result.eligible).toEqual(entries);
    expect(read).not.toHaveBeenCalled();
  },
);
