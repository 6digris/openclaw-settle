import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCodexUserMcpServersThreadConfigPatchForRuntime } from "../agents/cli-runner/bundle-mcp-codex.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  resetAgentRunRegistryForTest,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals-store.js";
import { registerMcpToolApprovalBinding } from "../infra/mcp-tool-approval-binding.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { createPluginApprovalHandlers } from "./server-methods/plugin-approval.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";

const auxiliaries: ReturnType<typeof createGatewayAuxHandlers>[] = [];
const pendingRequests: Promise<void>[] = [];
let fixture: OpenClawTestState | undefined;
const cfg: OpenClawConfig = {
  agents: { list: [{ id: "main" }, { id: "other" }] },
  mcp: { servers: { "project.docs": { command: "docs-mcp" } } },
};

function gateway() {
  const aux = createGatewayAuxHandlers({
    log: {},
    getNativeApprovalRouteCoordinator: () => undefined,
    activateRuntimeSecrets: async () => {
      throw new Error("unexpected secrets reload");
    },
    sharedGatewaySessionGenerationState: { current: undefined, required: null },
    resolveSharedGatewaySessionGenerationForConfig: () => undefined,
    clients: [],
    channelManager: {
      startChannel: async () => new Map(),
      stopChannel: async () => {},
      isManuallyStopped: () => false,
      resolveRuntimeAccountId: (_channel, accountId) => accountId,
    },
    logChannels: { info: () => {} },
    validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
  });
  auxiliaries.push(aux);
  return aux;
}

beforeEach(async () => {
  if (fixture) {
    throw new Error("Previous auxiliary owner cleanup did not finish");
  }
  fixture = await createOpenClawTestState({ label: "mcp-tool-grants" });
  setRuntimeConfigSnapshot(cfg);
});
afterEach(async () => {
  const stopped = await Promise.allSettled(
    auxiliaries.map((aux) => aux.stopOperatorInteractions()),
  );
  await Promise.all(pendingRequests);
  pendingRequests.length = 0;
  auxiliaries.length = 0;
  resetAgentRunRegistryForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  await fixture?.cleanup();
  fixture = undefined;
  for (const result of stopped) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
});

async function requestGrant(
  options: {
    server?: string;
    agentId?: string;
    trusted?: boolean;
    allowedDecisions?: string[];
    isActive?: () => boolean;
    binding?: boolean;
  } = {},
) {
  const aux = gateway();
  const authority = claimAgentRunDelegatedAuthority({
    instanceId: "mcp-instance",
    runId: "mcp-run",
  });
  const request = {
    title: "MCP tool approval",
    description: "Write a note",
    toolName: "codex_mcp_tool_approval",
    toolCallId: "raw-item-1",
    mcpTool: { server: options.server ?? "project.docs", tool: "write_note" },
    agentId: options.agentId ?? "main",
    allowedDecisions: options.allowedDecisions ?? ["allow-once", "allow-always", "deny"],
    twoPhase: true,
  };
  const releaseBinding =
    options.binding === false
      ? undefined
      : registerMcpToolApprovalBinding({
          authority,
          agentId: "main",
          toolCallId: request.toolCallId,
          ...request.mcpTool,
          isActive: options.isActive ?? (() => true),
        });
  const firstResponse = createDeferredCore<Parameters<GatewayRequestHandlerOptions["respond"]>>();
  const args = {
    req: { method: "plugin.approval.request", params: request, id: "request-1" },
    params: request,
    client: {
      connId: "runtime-1",
      connect: { client: { id: "test-client" } },
      ...(options.trusted === false
        ? {}
        : {
            internal: {
              agentRuntimeIdentity: {
                kind: "agentRuntime",
                agentId: "main",
                operationalRunInstance: authority.operationalRunInstance,
                delegatedAuthority: { ...authority, kind: "local" },
                approvalOwnerPluginId: "codex",
              },
            },
          }),
    },
    respond: vi.fn((...response: Parameters<GatewayRequestHandlerOptions["respond"]>) => {
      firstResponse.resolve(response);
    }),
    isWebchatConnect: () => false,
    context: {
      broadcast: vi.fn(),
      getRuntimeConfig: () => cfg,
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
      hasExecApprovalClients: () => true,
      validateAgentRuntimeApprovalAuthority: () => validateAgentRunDelegatedAuthority(authority),
    },
  } as unknown as GatewayRequestHandlerOptions;
  try {
    const pending = Promise.resolve(
      createPluginApprovalHandlers(aux.pluginApprovalManager)["plugin.approval.request"]!(args),
    );
    // Retirement releases unanswered observers; join them before closing the shared database.
    pendingRequests.push(pending.catch(() => {}));
    const [ok, payload, error] = await Promise.race([
      firstResponse.promise,
      pending.then(() => {
        throw new Error("MCP approval request completed before acceptance");
      }),
    ]);
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ status: "accepted" });
    expect(error).toBeUndefined();
    const record = (await aux.pluginApprovalManager.listPendingRecords())[0];
    if (!record) {
      throw new Error("MCP approval request did not register");
    }
    return { aux, authority, pending, record };
  } finally {
    releaseBinding?.();
  }
}

describe("gateway MCP tool grants", () => {
  it("mints once for the authenticated agent and projects the grant after gateway restart", async () => {
    const { aux, pending, record } = await requestGrant({ agentId: "other" });
    expect(await aux.pluginApprovalManager.resolve(record.id, "allow-always")).toBe(true);
    await pending;
    const expected = {
      server: "project.docs",
      tool: "write_note",
      source: "allow-always",
      addedAt: expect.any(Number),
    };
    expect(loadExecApprovalsReadOnly().agents).toEqual({ main: { mcpTools: [expected] } });
    expect(await aux.pluginApprovalManager.resolve(record.id, "allow-always")).toBe(false);
    await aux.stopOperatorInteractions();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const restarted = gateway();
    expect(restarted.pluginApprovalManager.runtimeEpoch).not.toBe(
      aux.pluginApprovalManager.runtimeEpoch,
    );
    expect(loadExecApprovalsReadOnly().agents).toEqual({ main: { mcpTools: [expected] } });
    expect(
      await buildCodexUserMcpServersThreadConfigPatchForRuntime(cfg, { agentId: "main" }),
    ).toMatchObject({
      mcp_servers: { "project.docs": { tools: { write_note: { approval_mode: "approve" } } } },
    });
    expect(
      await buildCodexUserMcpServersThreadConfigPatchForRuntime(cfg, { agentId: "other" }),
    ).not.toMatchObject({
      mcp_servers: { "project.docs": { tools: { write_note: { approval_mode: "approve" } } } },
    });
  });

  it.each([
    { name: "unconfigured apps", server: "codex_apps" },
    { name: "unconfigured computer use", server: "computer" },
    { name: "untrusted caller", trusted: false },
    { name: "remote or missing live proof", binding: false },
    { name: "allow once", decision: "allow-once" as const },
    { name: "deny", decision: "deny" as const },
    { name: "explicit prompt", prompt: true },
    { name: "native prompt spelling", nativePrompt: true },
    { name: "removed server", removed: true },
    { name: "closed authority", closed: true },
  ])("does not mint for $name", async (options) => {
    const { aux, authority, pending, record } = await requestGrant(options);
    if (options.prompt) {
      setRuntimeConfigSnapshot({
        ...cfg,
        mcp: {
          servers: {
            "project.docs": { command: "docs-mcp", codex: { defaultToolsApprovalMode: "prompt" } },
          },
        },
      });
    }
    if (options.removed) {
      setRuntimeConfigSnapshot({ ...cfg, mcp: { servers: {} } });
    }
    if (options.nativePrompt) {
      setRuntimeConfigSnapshot({
        ...cfg,
        mcp: {
          servers: {
            "project.docs": { command: "docs-mcp", default_tools_approval_mode: "prompt" },
          },
        },
      });
    }
    if (options.closed) {
      releaseAgentRunDelegatedAuthority(authority);
    }
    await aux.pluginApprovalManager.resolve(record.id, options.decision ?? "allow-always");
    await pending;
    expect(loadExecApprovalsReadOnly().agents).toEqual({});
  });

  it("keeps one-shot approval when correlation is lost while the prompt is pending", async () => {
    let active = true;
    const { aux, pending, record } = await requestGrant({ isActive: () => active });
    active = false;
    expect(await aux.pluginApprovalManager.resolve(record.id, "allow-always")).toBe(true);
    await pending;
    expect(loadExecApprovalsReadOnly().agents).toEqual({});
    expect(
      (await aux.pluginApprovalManager.getSnapshot(record.id))?.mcpToolApprovalActive,
    ).toBeUndefined();
  });

  it("rejects an unadvertised allow-always without minting", async () => {
    const { aux, pending, record } = await requestGrant({
      allowedDecisions: ["allow-once", "deny"],
    });
    expect(await aux.pluginApprovalManager.resolve(record.id, "allow-always")).toBe(false);
    expect(loadExecApprovalsReadOnly().agents).toEqual({});
    await aux.pluginApprovalManager.resolve(record.id, "deny");
    await pending;
  });

  it("waits for real registration before exposing a grant request", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const register = ExecApprovalManager.prototype.register;
    const registration = vi
      .spyOn(ExecApprovalManager.prototype, "register")
      .mockImplementationOnce(async function (this: ExecApprovalManager, ...args) {
        entered.resolve();
        await release.promise;
        return register.call(this, ...args);
      });
    let settled = false;
    const request = requestGrant();
    void request.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await Promise.race([entered.promise, request]);
      expect(settled).toBe(false);
      release.resolve();
      const { aux, pending, record } = await request;
      expect(await aux.pluginApprovalManager.resolve(record.id, "deny")).toBe(true);
      await pending;
    } finally {
      release.resolve();
      registration.mockRestore();
      await request.catch(() => {});
    }
  });
});
