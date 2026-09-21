import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import * as subagentStore from "../../agents/subagents/registry/subagent-registry.store.sqlite.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseByPath } from "../../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { resolveApprovalSessionAudienceWithFallback } from "../approval-session-audience.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import type { OperatorApprovalRecord } from "../operator-approval-store.types.js";
import { createChatRunState } from "../server-chat-state.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

vi.mock("../../infra/command-analysis/explain.js", () => ({
  resolveCommandAnalysisSummaryForDisplay: vi.fn(async () => null),
}));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    for (const dir of tempDirs.dirs) {
      closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: dir }));
    }
    cleanup();
  }),
);

function databaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(tempDirs.make("exec-approval-id-"));
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function identity(enabled: boolean): AgentRuntimeIdentity {
  return {
    kind: "agentRuntime",
    agentId: "main",
    sessionKey: "agent:main:session-1",
    operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
    delegatedAuthority: {
      kind: "local",
      operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
      lifecycleGeneration: "generation-1",
      claimId: "claim-1",
    },
    turnSourceChannel: "telegram",
    turnSourceTo: "chat-1",
    turnSourceAccountId: "default",
    turnSourceThreadId: "thread-1",
    ...(enabled
      ? {
          executionIdentity: {
            tokenVersion: 1,
            createdAt: 1,
            runId: "run-1",
            contextId: "context-1",
            executionId: "execution-1",
          },
        }
      : {}),
  };
}

function requestOptions(
  runtimeIdentity: AgentRuntimeIdentity,
  validateAuthority: () => boolean = () => true,
): GatewayRequestHandlerOptions {
  const request = {
    command: "echo ok",
    cwd: "/tmp",
    agentId: "forged-agent",
    sessionKey: "forged-session",
    sessionId: "forged-session-id",
    runId: "forged-run",
    turnSourceChannel: "forged-channel",
    turnSourceTo: "forged-target",
    turnSourceAccountId: "forged-account",
    turnSourceThreadId: "forged-thread",
    timeoutMs: 2_000,
    twoPhase: true,
  };
  return {
    req: { method: "exec.approval.request", params: request, id: "req-1" },
    params: request,
    client: {
      connId: "conn-agent-runtime",
      connect: { client: { id: "test-client", displayName: "Test Client" } },
      internal: { agentRuntimeIdentity: runtimeIdentity },
    },
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      broadcast: vi.fn(),
      getRuntimeConfig: () => ({}),
      hasExecApprovalClients: () => true,
      chatRunState: createChatRunState(),
      validateAgentRuntimeApprovalAuthority: validateAuthority,
      logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    },
  } as unknown as GatewayRequestHandlerOptions;
}

describe("exec approval signed agent runtime", () => {
  it("prepares retained approval lineage without synchronously loading full registry payloads", async (testContext) => {
    await withOpenClawTestState(
      {
        scenario: "minimal",
        env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" },
      },
      async () => {
        clearSubagentRunsReadCacheForTest();
        const child = "agent:main:subagent:incognito-approval-child";
        const parent = "agent:main:dashboard:incognito-approval-parent";
        const root = "agent:main:dashboard:incognito-approval-root";
        const run = createSubagentRunRecord({
          runId: "approval-retained-child",
          childSessionKey: child,
          requesterSessionKey: parent,
          completion: { required: false },
          delivery: { status: "not_required" },
        });
        subagentStore.saveSubagentRegistryToSqlite(new Map([[run.runId, run]]));
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: parent },
          {
            sessionId: "approval-incognito-parent",
            updatedAt: 1,
            parentSessionKey: root,
            incognito: true,
          },
        );
        const hostRegistryReads = trackSqliteStatementExecutions(
          openOpenClawStateDatabase().db,
          ["registryPayload"],
          (sql) =>
            /\bfrom\s+"?subagent_runs\b/iu.test(sql) && /\bpayload_json\b/iu.test(sql)
              ? "registryPayload"
              : null,
        );
        const registered = createDeferredCore<OperatorApprovalRecord>();
        const manager = createTestApprovalManager(testContext, {
          resolveAudienceSessionKeys: resolveApprovalSessionAudienceWithFallback,
          validateAgentRuntimeDelegatedAuthority: () => true,
          onLifecycle: (event) => {
            if (event.phase === "pending") {
              registered.resolve(event.record);
            }
          },
        });
        const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
        const opts = requestOptions({ ...identity(false), sessionKey: child });
        const approvalId = "approval-prepared-lineage";
        Object.assign(opts.params, {
          id: approvalId,
          timeoutMs: 60_000,
          requireDeliveryRoute: false,
          suppressDelivery: true,
        });
        const pending = Promise.resolve(handler(opts));
        try {
          const approval = await Promise.race([
            registered.promise,
            pending.then(() => {
              throw new Error("Approval request ended before registration");
            }),
          ]);
          expect(approval.audienceSessionKeys).toEqual([child, parent, root]);
          expect(hostRegistryReads.counts.registryPayload).toBe(0);
        } finally {
          hostRegistryReads.restore();
          await manager.resolve(approvalId, "deny");
          await pending;
          await manager.drain();
          clearSubagentRunsReadCacheForTest();
        }
      },
    );
  });

  it("rejects closed authority before creating an exec approval", async (testContext) => {
    const manager = createTestApprovalManager(testContext, {
      validateAgentRuntimeDelegatedAuthority: () => false,
    });
    const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
    const opts = requestOptions(identity(false), () => false);

    await handler(opts);

    expect(await manager.listPendingRecords()).toHaveLength(0);
    expect(vi.mocked(opts.respond).mock.calls[0]?.[2]).toMatchObject({
      message: expect.stringContaining("no longer active"),
    });
  });

  it("sanitizes display-only cwd and resolvedPath in the stored request", async (testContext) => {
    const manager = createTestApprovalManager(testContext, {
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
    const opts = requestOptions(identity(false));
    // Bidi override in cwd/resolvedPath can spoof what path reviewers see.
    (opts.params as Record<string, unknown>).cwd = "/tmp/safe‮evil";
    (opts.params as Record<string, unknown>).resolvedPath = "/usr/bin/echo​x";
    // Free-form policy strings must not reach reviewer meta rows: security/ask
    // are closed enums (arbitrary values null out), host is escape-hardened.
    (opts.params as Record<string, unknown>).security = "full‮looks-deny";
    (opts.params as Record<string, unknown>).ask = "always​ish";
    const pending = handler(opts);
    await vi.waitFor(async () => expect(await manager.listPendingRecords()).toHaveLength(1));
    const record = (await manager.listPendingRecords())[0]!;
    expect(record.request.cwd).toBe("/tmp/safe\\u{202E}evil");
    expect(record.request.resolvedPath).toBe("/usr/bin/echo\\u{200B}x");
    expect(record.request.security).toBeNull();
    expect(record.request.ask).toBeNull();
    await manager.resolve(record.id, "deny");
    await pending;
  });

  it("cancels an exec approval when authority closes after the handshake", async (testContext) => {
    let active = true;
    const manager = createTestApprovalManager(testContext, {
      validateAgentRuntimeDelegatedAuthority: () => active,
    });
    const handler = createExecApprovalHandlers(manager)["exec.approval.request"]!;
    const opts = requestOptions(identity(false), () => active);
    const pending = handler(opts);
    await vi.waitFor(async () => expect(await manager.listPendingRecords()).toHaveLength(1));
    const record = (await manager.listPendingRecords())[0]!;
    active = false;

    await expect(manager.awaitDecision(record.id)).resolves.toBeNull();
    await pending;
    expect(await manager.getSnapshot(record.id)).toMatchObject({ status: "cancelled" });
  });

  it.each([
    ["enabled", true],
    ["disabled", false],
  ] as const)("uses signed runtime provenance with collection %s", async (_label, enabled) => {
    const options = databaseOptions();
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: { runtimeEpoch: "runtime-a", databaseOptions: options },
      validateAgentRuntimeDelegatedAuthority: () => true,
    });
    const handler = createExecApprovalHandlers(manager)["exec.approval.request"];
    if (!handler) {
      throw new Error("exec approval request handler is unavailable");
    }
    const opts = requestOptions(identity(enabled));

    const pending = handler(opts);
    await vi.waitFor(() => expect(opts.context.broadcast).toHaveBeenCalled());
    const approvalId = String(
      (vi.mocked(opts.context.broadcast).mock.calls[0]?.[1] as { id?: unknown } | undefined)?.id,
    );
    expect((await manager.getSnapshot(approvalId))?.request).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:session-1",
      sessionId: null,
      runId: "run-1",
      turnSourceChannel: "telegram",
      turnSourceTo: "chat-1",
      turnSourceAccountId: "default",
      turnSourceThreadId: "thread-1",
    });
    const db = openOpenClawStateDatabase(options).db;
    if (enabled) {
      expect(
        db
          .prepare(
            "SELECT approval_id, source_context_id, source_execution_id FROM operator_approval_execution_identities WHERE approval_id = ?",
          )
          .get(approvalId),
      ).toEqual({
        approval_id: approvalId,
        source_context_id: "context-1",
        source_execution_id: "execution-1",
      });
    } else {
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'operator_approval_execution_identities'",
          )
          .get(),
      ).toBeUndefined();
    }
    await manager.resolve(approvalId, "deny");
    await pending;
  });
});
