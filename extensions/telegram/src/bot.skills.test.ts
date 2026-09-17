import { randomUUID } from "node:crypto";
import path from "node:path";
import { registerAgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import type { AgentWorkspaceAccess } from "openclaw/plugin-sdk/agent-workspace-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { prepareTelegramNativeSkillCommands } from "./bot.js";

type Sources = Awaited<ReturnType<NonNullable<AgentWorkspaceAccess["loadSkills"]>>>;
const sources: Sources = {
  entries: [
    {
      skill: {
        name: "remote",
        description: "Remote workspace command",
        filePath: "/workspace/skills/remote/SKILL.md",
        baseDir: "/workspace/skills/remote",
        source: "openclaw-workspace",
        disableModelInvocation: false,
        sourceInfo: {
          path: "/workspace/skills/remote/SKILL.md",
          source: "openclaw-workspace",
          scope: "project",
          origin: "top-level",
        },
      },
      frontmatter: {},
    },
  ],
  executionEntries: [],
  runtime: { platform: process.platform, bins: [] },
};
function fixture(loadSkills: NonNullable<AgentWorkspaceAccess["loadSkills"]>) {
  const workspace = path.resolve("missing-telegram-workspace", randomUUID());
  const cfg: OpenClawConfig = {
    plugins: { enabled: false },
    agents: { entries: { main: {}, remote: { workspace } } },
    channels: {
      telegram: {
        defaultAccount: "bot-b",
        accounts: { "bot-b": { commands: { native: true, nativeSkills: true } } },
      },
    },
    bindings: [{ agentId: "remote", match: { channel: "telegram", accountId: "bot-b" } }],
  };
  const release = registerAgentWorkspaceAccess(workspace, {
    bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
    loadSkills,
  });
  return { cfg, release };
}
it("prepares the effective account's routed agent from its workspace host", async () => {
  const loadSkills = vi.fn(async () => sources);
  const { cfg, release } = fixture(loadSkills);
  try {
    expect(
      (await prepareTelegramNativeSkillCommands({ cfg })).map((command) => command.skillName),
    ).toEqual(["remote"]);
    expect(loadSkills).toHaveBeenCalledOnce();
  } finally {
    release();
  }
});
it.each(["native", "nativeSkills"] as const)(
  "does not read the workspace when %s is disabled",
  async (flag) => {
    const loadSkills = vi.fn(async () => sources);
    const { cfg, release } = fixture(loadSkills);
    cfg.commands = { [flag]: false };
    cfg.channels = { telegram: { defaultAccount: "bot-b", accounts: { "bot-b": {} } } };
    try {
      expect(await prepareTelegramNativeSkillCommands({ cfg })).toEqual([]);
      expect(loadSkills).not.toHaveBeenCalled();
    } finally {
      release();
    }
  },
);
it("stops waiting on remote discovery when account startup is cancelled", async () => {
  const deferred = createDeferred<Sources>();
  const loadSkills = vi.fn(() => deferred.promise);
  const { cfg, release } = fixture(loadSkills);
  const controller = new AbortController();
  let settled = false;
  const outcome = prepareTelegramNativeSkillCommands({ cfg, signal: controller.signal }).then(
    (commands) => {
      settled = true;
      return { commands };
    },
    (error: unknown) => {
      settled = true;
      return { error };
    },
  );
  try {
    await vi.waitFor(() => expect(loadSkills).toHaveBeenCalledOnce());
    controller.abort(new Error("account stopped"));
    await vi.waitFor(() => expect(settled).toBe(true));
    expect(await outcome).toMatchObject({ error: { name: "AbortError" } });
  } finally {
    deferred.resolve(sources);
    await outcome;
    release();
  }
});
