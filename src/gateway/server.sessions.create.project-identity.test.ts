import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../agents/github-tool-identity.js";
import { createSessionsSpawnTool } from "../agents/tools/sessions-spawn-tool.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import {
  controlUiClient,
  initializeRepository,
  settleWorkspaceRuns,
} from "./server.sessions.create.projects.test-support.js";
import { dispatchInboundMessageMock, testState } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const transport = vi.hoisted(() => ({
  upstream: "",
  tokens: [] as string[],
  afterClone: undefined as (() => Promise<void>) | undefined,
  beforeLocalGit: undefined as ((argv: string[]) => Promise<void>) | undefined,
  transientClone: false,
}));
vi.mock("../agents/github-oauth-client.js", async (original) => ({
  ...(await original<typeof import("../agents/github-oauth-client.js")>()),
  verifyGitHubCredential: vi.fn(async () => ({
    status: "available",
    account: { accountId: 42, login: "selected-test" },
    scopes: [],
  })),
}));
vi.mock("./github-oauth-lifecycle.js", () => ({
  requestCurrentGitHubOAuthRefresh: async () => {},
}));
vi.mock("../process/exec.js", async (original) => {
  const actual = await original<typeof import("../process/exec.js")>();
  return {
    ...actual,
    runCommandWithTimeout: async (...args: Parameters<typeof actual.runCommandWithTimeout>) => {
      const [argv, options] = args;
      if (argv.includes("https://github.com/example/selected.git")) {
        const header = typeof options === "object" ? options.env?.GIT_CONFIG_VALUE_0 : undefined;
        transport.tokens.push(
          header
            ? Buffer.from(header.replace("Authorization: Basic ", ""), "base64")
                .toString()
                .replace("x-access-token:", "")
            : "anonymous",
        );

        // Real Git and registry/worktree state; only the network endpoint is replaced.
        const result = await actual.runCommandWithTimeout(
          argv.map((arg) =>
            arg === "https://github.com/example/selected.git" ? transport.upstream : arg,
          ),
          options,
        );
        if (argv.includes("clone")) {
          await transport.afterClone?.();
          if (transport.transientClone) {
            return { ...result, code: 128, stderr: "fatal: connection reset by peer" };
          }
        }
        return result;
      }
      await transport.beforeLocalGit?.(argv);
      return actual.runCommandWithTimeout(...args);
    },
  };
});

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const git = promisify(execFile);
const profileId = "ghp_11111111111111111111111111111111";
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let storePath: string;
let profile: string;
let workspace: string;

beforeEach(async () => {
  state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-project-identity-",
  });
  workspace = await initializeRepository(state.root, "workspace");
  const publisher = await initializeRepository(state.root, "publisher");
  transport.upstream = path.join(state.root, "upstream.git");
  await git("git", ["clone", "--bare", publisher, transport.upstream]);
  testState.agentConfig = { workspace };
  testState.agentsConfig = { entries: { main: { tools: { github: { profileId } } } } };
  testState.gatewayControlUi = { github: { token: "different-service-fixture" } };
  ({ storePath } = await createSessionStoreDir());
  profile = resolveManagedGitHubProfileDir({ agentId: "main", scope: "agent", profileId });
  await writeManagedGitHubProfileFiles(profile, {
    login: "selected-test",
    token: "selected-agent-fixture",
  });
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const config = getRuntimeConfig();
  const systemProfileId = "ghp_22222222222222222222222222222222";
  config.tools = { ...config.tools, github: { profileId: systemProfileId } };
  await writeManagedGitHubProfileFiles(
    resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId: systemProfileId,
    }),
    { login: "system-test", token: "different-system-fixture" },
  );
  dispatchInboundMessageMock.mockResolvedValue({
    queuedFinal: false,
    counts: { block: 0, final: 0, tool: 0 },
  });
});
afterEach(async () => {
  transport.tokens = [];
  transport.afterClone = undefined;
  transport.beforeLocalGit = undefined;
  transport.transientClone = false;
  dispatchInboundMessageMock.mockReset();
  testState.agentConfig = undefined;
  testState.agentsConfig = undefined;
  testState.gatewayControlUi = undefined;
  closeOpenClawStateDatabaseForTest();
  await state?.cleanup();
});

test.each([
  { source: "ui", inherited: false },
  { source: "visible-spawn", inherited: false },
  { source: "ui", inherited: true },
  { source: "visible-spawn", inherited: true },
])(
  "$source clones with the selected identity (inherited=$inherited), not the discovery credential",
  async ({ source, inherited }) => {
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const context = createDirectChatContext({
      getRuntimeConfig,
      trackExecution: async (run) => await run(),
    });
    if (inherited) {
      delete getRuntimeConfig().agents!.entries!.main!.tools!.github;
    }
    let key: string | undefined;
    try {
      const params = {
        projectGitUrl: "https://github.com/example/selected.git",
        worktree: true,
        worktreeName: "identity-child",
        worktreeBaseRef: "main",
      };
      if (source === "ui") {
        const created = await directSessionReq<{ key: string }>(
          "sessions.create",
          { agentId: "main", message: "Read the selected project", ...params },
          { ...controlUiClient, context },
        );
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        key = created.payload!.key;
      } else {
        const parent = await directSessionReq<{ key: string }>(
          "sessions.create",
          { agentId: "main" },
          { ...controlUiClient, context },
        );
        expect(parent.ok).toBe(true);
        const tool = createSessionsSpawnTool({
          agentSessionKey: parent.payload!.key,
          config: getRuntimeConfig(),
          registerRun: vi.fn(),
          countActiveRuns: () => 0,
        });
        const result = await withPluginRuntimeGatewayContextResolver(
          () => context,
          () =>
            tool.execute("identity-spawn", {
              task: "Read the selected project",
              visible: true,
              ...params,
            }),
        );
        expect(result.details).toMatchObject({ status: "accepted" });
        if (!isRecord(result.details) || typeof result.details.childSessionKey !== "string") {
          throw new Error("Missing child key");
        }
        key = result.details.childSessionKey;
      }
      await settleWorkspaceRuns(context, storePath, key);
      expect(transport.tokens).toEqual([
        inherited ? "different-system-fixture" : "selected-agent-fixture",
      ]);
      const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
      expect(entry?.pendingProjectGitUrl).toBeUndefined();
      expect(entry?.worktree?.id).toBeDefined();
      expect(await fs.readFile(path.join(entry!.spawnedCwd!, "README.md"), "utf8")).toBe(
        "publisher\n",
      );
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
    } finally {
      await settleWorkspaceRuns(context, storePath, key, true);
      const owned = key && managedWorktrees.findLiveByOwner("session", key);
      if (owned) {
        await managedWorktrees.remove({
          id: owned.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
    }
  },
);

test.each(["missing", "removed-after-clone", "removed-before-retry"] as const)(
  "session preparation refuses %s identity without service fallback",
  async (failure) => {
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const context = createDirectChatContext({
      getRuntimeConfig,
      trackExecution: async (run) => await run(),
    });
    if (failure === "missing") {
      await fs.rm(profile, { recursive: true });
    } else {
      transport.afterClone = async () => {
        await fs.rm(profile, { recursive: true });
      };
    }
    transport.transientClone = failure === "removed-before-retry";
    const created = await directSessionReq<{ key: string }>(
      "sessions.create",
      {
        agentId: "main",
        message: "Read the project",
        projectGitUrl: "https://github.com/example/selected.git",
      },
      { ...controlUiClient, context },
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const key = created.payload!.key;
    try {
      await settleWorkspaceRuns(context, storePath, key);
      expect(transport.tokens).toEqual(failure === "missing" ? [] : ["selected-agent-fixture"]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
        status: "failed",
        pendingProjectGitUrl: "https://github.com/example/selected.git",
        lastRunError: expect.stringMatching(/GitHub.*(unavailable|changed)/),
      });
      // Reconnect and retry the persisted intent with a fresh admitted identity.
      transport.afterClone = undefined;
      transport.transientClone = false;
      await writeManagedGitHubProfileFiles(profile, {
        login: "selected-test",
        token: "reconnected-agent-fixture",
      });
      const retried = await directSessionReq(
        "chat.send",
        { agentId: "main", sessionKey: key, message: "Retry", idempotencyKey: "identity-retry" },
        { ...controlUiClient, context },
      );
      expect(retried.ok).toBe(true);
      await settleWorkspaceRuns(context, storePath, key);
      expect(transport.tokens.at(-1)).toBe("reconnected-agent-fixture");
      expect(dispatchInboundMessageMock).toHaveBeenCalledOnce();
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.pendingProjectGitUrl,
      ).toBeUndefined();
    } finally {
      await settleWorkspaceRuns(context, storePath, key, true);
    }
  },
);

test.each([false, true])(
  "deferred refresh uses selected identity and rejects revocation=%s",
  async (revoke) => {
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const context = createDirectChatContext({
      getRuntimeConfig,
      trackExecution: async (run) => await run(),
    });
    // The requested branch appears upstream only after the initial clone.
    transport.afterClone = async () => {
      await git("git", ["--git-dir", transport.upstream, "branch", "later", "main"]);
    };
    if (revoke) {
      transport.beforeLocalGit = async (argv) => {
        if (argv.includes("rev-parse") && argv.some((arg) => arg.includes("origin/later"))) {
          transport.beforeLocalGit = undefined;
          await fs.rm(profile, { recursive: true });
        }
      };
    }
    const created = await directSessionReq<{ key: string }>(
      "sessions.create",
      {
        agentId: "main",
        message: "Use the later branch",
        projectGitUrl: "https://github.com/example/selected.git",
        worktree: true,
        worktreeName: "later-child",
        worktreeBaseRef: "origin/later",
      },
      { ...controlUiClient, context },
    );
    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const key = created.payload!.key;
    try {
      await settleWorkspaceRuns(context, storePath, key);
      expect(transport.tokens).toEqual(
        revoke ? ["selected-agent-fixture"] : ["selected-agent-fixture", "selected-agent-fixture"],
      );
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(revoke ? 0 : 1);
      const entry = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
      if (revoke) {
        expect(entry?.lastRunError).toMatch(/GitHub.*changed/);
      } else {
        expect(managedWorktrees.findLiveByOwner("session", key)?.baseRef).toBe("origin/later");
      }
    } finally {
      await settleWorkspaceRuns(context, storePath, key, true);
      const owned = managedWorktrees.findLiveByOwner("session", key);
      if (owned) {
        await managedWorktrees.remove({
          id: owned.id,
          reason: "test-cleanup",
          allowSnapshotLoss: true,
        });
      }
    }
  },
);
