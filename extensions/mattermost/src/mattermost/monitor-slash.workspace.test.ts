import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  declareAgentWorkspaceAccess,
  registerAgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { resolveMattermostAccount } from "./accounts.js";
import { createMattermostClient } from "./client.js";
import { registerMattermostMonitorSlashCommands } from "./monitor-slash.js";
import type { OpenClawConfig } from "./runtime-api.js";

const { registerSlashCommands, activateSlashCommands } = vi.hoisted(() => ({
  registerSlashCommands: vi.fn(async () => [{ token: "test-token", trigger: "oc_remote" }]),
  activateSlashCommands: vi.fn(),
}));
vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  fetchMattermostUserTeams: async () => [{ id: "team-1" }],
}));
vi.mock("./slash-commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./slash-commands.js")>()),
  registerSlashCommands,
}));
vi.mock("./slash-state.js", () => ({ activateSlashCommands }));
afterEach(() => vi.clearAllMocks());

it.each(["starting", "disconnected", "missing-capability"])(
  "retries a %s workspace without publishing an incomplete Skill catalog",
  async (state) => {
    // No directory is created on the Gateway. Discovery must use the registered host.
    const workspace = path.resolve("missing-mattermost-workspace", randomUUID());
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { entries: { main: { workspace } } },
      channels: {
        mattermost: {
          baseUrl: "https://chat.example.com",
          botToken: "test-token",
          commands: {
            native: true,
            nativeSkills: true,
            callbackUrl: "https://gateway.example.com/slash",
          },
        },
      },
    };
    const params = {
      client: createMattermostClient({
        baseUrl: "https://chat.example.com",
        botToken: "test-token",
        fetchImpl: async () => {
          throw new Error("unexpected network request");
        },
      }),
      cfg,
      account: resolveMattermostAccount({ cfg }),
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      baseUrl: "https://chat.example.com",
      botUserId: "bot-user",
    };
    declareAgentWorkspaceAccess(workspace);
    const disconnect =
      state !== "starting"
        ? registerAgentWorkspaceAccess(workspace, {
            bridge: { readFile: vi.fn(), writeFile: vi.fn(), stat: vi.fn() },
            loadSkills:
              state === "missing-capability"
                ? undefined
                : async () => {
                    throw new Error("test transport disconnected");
                  },
          })
        : undefined;
    try {
      await expect(registerMattermostMonitorSlashCommands(params)).rejects.toThrow(
        state === "starting"
          ? "stopped or not ready"
          : state === "missing-capability"
            ? "Remote workspace skill discovery is unavailable"
            : "Remote workspace skill discovery failed",
      );
    } finally {
      disconnect?.();
    }
    expect(registerSlashCommands).not.toHaveBeenCalled();
    expect(activateSlashCommands).not.toHaveBeenCalled();

    const release = registerAgentWorkspaceAccess(workspace, {
      bridge: {
        readFile: async () => {
          throw new Error("document bridge is not a Skills reader");
        },
        writeFile: async () => {
          throw new Error("unexpected write");
        },
        stat: async () => null,
      },
      loadSkills: async () => ({
        entries: [
          {
            skill: {
              name: "remote",
              description: "A Skill on the workspace host",
              filePath: "/workspace/skills/remote/SKILL.md",
              baseDir: "/workspace/skills/remote",
              source: "openclaw-workspace",
              sourceInfo: {
                path: "/workspace/skills/remote/SKILL.md",
                source: "openclaw-workspace",
                scope: "project",
                origin: "top-level",
              },
              disableModelInvocation: false,
            },
            frontmatter: {},
          },
        ],
        executionEntries: [],
        runtime: { platform: process.platform, bins: [] },
      }),
    });
    try {
      await registerMattermostMonitorSlashCommands(params);
      expect(registerSlashCommands).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          commands: expect.arrayContaining([
            expect.objectContaining({ trigger: "oc_remote", originalName: "remote" }),
          ]),
        }),
      );
      expect(activateSlashCommands).toHaveBeenCalledOnce();
    } finally {
      release();
    }
  },
);
