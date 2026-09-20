import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../../../config/sessions/session-transcript-reconcile.js";
import { withOwnedSessionTranscriptWrites } from "../../../config/sessions/transcript-write-context.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import * as workerStore from "../../../infra/sqlite-worker-store.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../../infra/sqlite-worker-store.js";
import { createNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "../../admitted-run-context.test-support.js";
import { isRecordedModelFallbackStop } from "../../model-fallback-stop.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createUsageAccumulator } from "../usage-accumulator.js";

const mocks = vi.hoisted(() => ({
  clearActiveEmbeddedRun: vi.fn(),
  completeAfterTurn: vi.fn(),
  completeResult: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  markRequesterTurnYielded: vi.fn(() => 1),
  settleRequesterAfterSessionSpawns: vi.fn(),
  settleStream: vi.fn(),
  runPrompt: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  log: { debug: mocks.logDebug, error: mocks.logError, warn: mocks.logWarn },
}));
vi.mock("../../subagents/registry/subagent-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../subagents/registry/subagent-registry.js")>();
  return {
    ...actual,
    markRequesterTurnYielded: mocks.markRequesterTurnYielded,
    settleRequesterAfterSessionSpawns: mocks.settleRequesterAfterSessionSpawns,
  };
});
vi.mock("../runs.js", () => ({ clearActiveEmbeddedRun: mocks.clearActiveEmbeddedRun }));
vi.mock("./attempt-prompt-phase.js", () => ({
  runEmbeddedAttemptPromptPhase: mocks.runPrompt,
}));
vi.mock("./attempt-result.js", () => ({
  completeEmbeddedAttemptResult: mocks.completeResult,
}));
vi.mock("./attempt-finalize.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./attempt-finalize.js")>();
  return {
    ...actual,
    completeEmbeddedAttemptAfterTurn: mocks.completeAfterTurn,
  };
});
vi.mock("./attempt-stream-settle.js", () => ({
  settleEmbeddedAttemptStream: mocks.settleStream,
}));

import { runEmbeddedAttemptSettledPhase } from "./attempt-settle.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import { createEmbeddedRunContextRecoveryState } from "./context-recovery-state.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";

type SettledInput = Parameters<typeof runEmbeddedAttemptSettledPhase>[0];

function createFixture() {
  const order: string[] = [];
  const queueHandle = { kind: "embedded", runId: "run-1" };
  const unsubscribe = vi.fn(() => order.push("unsubscribe"));
  const waitForPendingEvents = vi.fn(async () => undefined);
  const subscription = {
    assistantTexts: [],
    didSendDeterministicApprovalPrompt: vi.fn(() => false),
    didSendViaMessagingTool: vi.fn(() => false),
    getAcceptedSessionSpawns: vi.fn(() => []),
    getAssistantTurnCount: vi.fn(() => 1),
    getCompactionCount: vi.fn(() => 0),
    getCurrentAttemptAssistant: vi.fn(() => undefined),
    getHeartbeatToolResponse: vi.fn(() => undefined),
    getItemLifecycle: vi.fn(() => ({ startedCount: 0, completedCount: 0, activeCount: 0 })),
    getLastAssistantTextMessageIndex: vi.fn(() => undefined),
    getLastAssistantUsage: vi.fn(() => undefined),
    getLastCompactionTokensAfter: vi.fn(() => undefined),
    getLastToolError: vi.fn(() => undefined),
    getLatestMcpAppChannelView: vi.fn(() => undefined),
    getLatestMcpConnectAction: vi.fn(() => undefined),
    getMessagingToolSentMediaUrls: vi.fn(() => []),
    getMessagingToolSentTargets: vi.fn(() => []),
    getMessagingToolSentTexts: vi.fn(() => []),
    getMessagingToolSourceReplyPayloads: vi.fn(() => []),
    getSourceReplyDelivered: vi.fn(() => undefined),
    getSourceReplyDeliveryState: vi.fn(() => undefined),
    getPendingToolMediaReply: vi.fn(() => undefined),
    getToolAutoDeliveryMediaUrls: vi.fn(() => []),
    getReplayState: vi.fn(() => ({ replayInvalid: false, hadPotentialSideEffects: false })),
    getSuccessfulCronAdds: vi.fn(() => []),
    getUsageTotals: vi.fn(() => ({ input: 1, output: 2, total: 3 })),
    getVisibleBlockReplyCount: vi.fn(() => 0),
    hasToolMediaBlockReply: vi.fn(() => false),
    hasSuccessfulModelResponse: vi.fn(() => false),
    isCompactionInFlight: vi.fn(() => false),
    setTerminalLifecycleMeta: vi.fn(),
    toolMetas: [{ toolName: "exec", isError: false }],
    unsubscribe,
    waitForCompactionRetry: vi.fn(async () => undefined),
    waitForPendingEvents,
  };
  const detachBackend = vi.fn(() => order.push("detach-backend"));
  const clearTimers = vi.fn(() => order.push("clear-timers"));
  const getBeforeAgentFinalizeRevisionReason = vi.fn(() => "revision");
  const getBeforeAgentFinalizeRevisionEntryId = vi.fn(() => undefined);
  const promptActiveSession = vi.fn(async () => undefined);
  const messages = [
    {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-responses",
      provider: "openai",
      model: "model",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 100,
    },
  ];
  const activeSession = {
    agent: { state: { messages } },
    isCompacting: false,
    isStreaming: false,
    messages,
    sessionId: "active-session",
    getActiveToolNames: vi.fn(() => ["read"]),
  };
  const sessionManager = {
    kind: "session-manager",
    appendMessage: vi.fn((message) => messages.push(message)),
    buildSessionContext: vi.fn(() => ({ messages: [] })),
    getSessionTarget: vi.fn(() => undefined),
    getSessionId: () => "active-session",
  };
  const hookRunner = { hasHooks: vi.fn(() => false) };
  const cacheTrace = { recordStage: vi.fn() };
  const trajectoryRecorder = { recordEvent: vi.fn(), flush: vi.fn(async () => undefined) };
  const toolResultPromptProjectionState = { kind: "tool-result-projection" };
  const sessionPromptState = { toolResults: toolResultPromptProjectionState };
  const sessionRuntimeState = {
    currentTurnImageFailureCount: 0,
    prePromptMessageCount: 2,
    promptCache: undefined,
    systemPromptText: "system prompt",
  };
  const state: SettledInput["state"] = {
    beforeAgentRunBlockedBy: undefined,
    terminal: { kind: "ok" },
    trajectoryEndRecorded: false,
  };
  const result = { messages: [{ role: "assistant", content: "done" }] };
  const preparedStreamRuntime = {
    abortable: (promise: Promise<unknown>) => promise,
    cache: {},
    history: {
      contextEnginePromptAuthority: "assembled",
      contextEngineAssemblySucceeded: true,
      unwindowedContextEngineMessagesForPrecheck: [{ role: "user", content: "history" }],
    },
    isProbeSession: false,
    onBlockReplyFlush: vi.fn(),
    promptActiveSession,
    stream: {
      subscription,
      queueHandle,
      stopAcceptingSteerMessages: vi.fn(),
      getBeforeAgentFinalizeRevisionReason,
      getBeforeAgentFinalizeRevisionEntryId,
    },
    timeout: {
      getRunAbortDeadlineAtMs: vi.fn(() => 123),
      clearTimers,
    },
  };
  const sessionRuntime = {
    agentSession: {
      activeSession,
      clientToolCallSlots: [],
      hasDeliveredSourceReply: vi.fn(() => true),
      hookRunner,
      setActiveSessionSystemPrompt: vi.fn(),
      settingsManager: { getCompactionReserveTokens: vi.fn(() => 1_000) },
    },
    anthropicPayloadLogger: {},
    boundary: {
      boundaryTimezone: "UTC",
      includeBoundaryTimestamp: true,
      orphanRepair: undefined,
      setCurrentUserTimestampOverride: vi.fn(),
    },
    cacheTrace,
    contextGuards: {
      getAfterTurnCheckpoint: vi.fn(() => 2),
      takePendingMidTurnPrecheckRequest: vi.fn(() => null),
    },
    preparedUserTurnMessage: {
      role: "user",
      content: "hello",
      timestamp: 100,
      __openclaw: { senderName: "Alice" },
    },
    sessionManager,
    sessionPromptState,
    state: sessionRuntimeState,
    toolResultPromptProjectionState,
    trajectoryRecorder,
    transcriptPolicy: { appendOnlyRuntimeContext: true },
    transport: {
      effectiveAgentTransport: "sse",
      effectiveExtraParams: {},
      effectivePromptCacheRetention: "long",
      streamStrategy: "provider",
    },
  };
  const input = {
    attempt: {
      admittedRunContext: createTestAdmittedRunContext("run-1"),
      config: {},
      model: { api: "openai-responses" },
      modelId: "model",
      promptCacheKey: undefined,
      provider: "openai",
      replyOperation: { detachBackend, turnKind: "visible" },
      runId: "run-1",
      sessionFile: "/tmp/session.jsonl",
      sessionId: "session-1",
      sessionKey: "agent:main",
      trigger: "user",
      workspaceDir: "/workspace",
    },
    agentDir: "/agent",
    isRawModelRun: false,
    resolveActiveContextEnginePluginId: vi.fn(),
    runAbortController: new AbortController(),
    prepared: {
      promptToolPolicy: { apply: vi.fn(), refresh: vi.fn(), current: {} },
      bootstrap: {
        bootstrapPromptWarning: {},
        shouldRecordCompletedBootstrapTurn: false,
      },
      bundleTools: {
        tools: [{ name: "read" }],
        uncompactedEffectiveTools: [{ name: "read" }],
      },
      sessionRuntime,
      systemPrompt: {
        runtimeInfo: { model: { id: "model" } },
        systemPromptReport: { chars: 13 },
      },
      toolBase: { nestedToolActivities: [] },
      toolCatalog: {
        effectiveTools: [{ name: "read" }],
        emptyExplicitToolAllowlistError: undefined,
        toolSearch: { compacted: false },
      },
    },
    sessionLock: {
      withOwnedTranscriptWrite: vi.fn(async (operation: () => unknown) => await operation()),
    },
    setup: {
      effectiveFsWorkspaceOnly: false,
      effectiveWorkspace: "/workspace",
      sandbox: null,
      sessionAgentId: "main",
    },
    diagnostics: { diagnosticTrace: {}, runTrace: {} },
    state,
    lifecycle: {
      readYieldState: () => ({
        yieldAbortSettled: null,
        yieldDetected: true,
        yieldMessage: "yield",
      }),
    },
    getRepairedRejectedProviderReplay: () => true,
    preparedStreamRuntime,
  } as unknown as SettledInput;

  mocks.runPrompt.mockImplementation(async (promptInput, promptState) => {
    order.push("prompt");
    Object.assign(promptState, {
      contextBudgetStatus: { status: "ok" },
      preflightRecovery: { attempted: false },
      finalPromptText: "final prompt",
    });
    promptInput.prepared.sessionRuntime.state.prePromptMessageCount = 4;
    promptInput.state.beforeAgentRunBlockedBy = "before_agent";
    return { promptStartedAt: 100, transcriptLeafId: "before-prompt" };
  });
  mocks.settleStream.mockImplementation(async () => {
    order.push("finalize");
    return {
      promptError: null,
      promptErrorSource: null,
      timedOutDuringCompaction: false,
      messagesSnapshot: [{ role: "assistant", content: "done" }],
      sessionIdUsed: "settled-session",
      lastAssistant: { role: "assistant", content: "done" },
      currentAttemptAssistant: { role: "assistant", content: "done" },
      currentAttemptCompletedAssistant: undefined,
      attemptUsage: { input: 1, output: 2, total: 3 },
      promptCache: { cacheRead: 1 },
      lastCallUsage: undefined,
      compactionOccurredThisAttempt: false,
    };
  });
  mocks.completeAfterTurn.mockResolvedValue(undefined);
  mocks.completeResult.mockImplementation(() => {
    order.push("result");
    return result;
  });
  mocks.clearActiveEmbeddedRun.mockImplementation(() => order.push("clear-active-run"));

  return {
    cacheTrace,
    clearTimers,
    detachBackend,
    getBeforeAgentFinalizeRevisionReason,
    input,
    order,
    queueHandle,
    result,
    sessionManager,
    sessionRuntimeState,
    state,
    subscription,
    trajectoryRecorder,
    unsubscribe,
  };
}

async function createPersistedImageNoteFixture(
  testState: OpenClawTestState,
  storage: "file-backed" | "incognito" = "file-backed",
) {
  const fixture = createFixture();
  const target = {
    agentId: "main",
    sessionId: "image-note",
    sessionKey:
      storage === "incognito"
        ? "agent:main:dashboard:incognito-image-note"
        : "agent:main:image-note",
    storePath: path.join(testState.agentDir("main"), "openclaw-agent.sqlite"),
  };
  const entry = await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1,
    lifecycleRevision: "image-note-generation",
    activeWriterRunId: fixture.input.attempt.runId,
    ...(storage === "incognito" ? { incognito: true } : {}),
  });
  if (!entry?.lifecycleRevision) {
    throw new Error("Expected a durable lifecycle revision for the admitted image-note writer");
  }
  const manager = SessionManager.open(target, testState.workspaceDir);
  const activeSession = fixture.input.prepared.sessionRuntime.agentSession.activeSession;
  manager.appendMessage({ role: "user", content: "Describe this image", timestamp: 1 });
  for (const message of activeSession.messages) {
    if (message.role !== "assistant") {
      throw new Error("Expected the completed assistant turn in the settlement fixture");
    }
    manager.appendMessage(message);
  }
  await waitForSessionTranscriptProjection(target);
  const before = await loadTranscriptEvents(target);
  const previousLeaf = manager.getLeafId();
  const previousMessages = manager.buildSessionContext().messages;
  activeSession.agent.state.messages = [...previousMessages];
  Object.defineProperty(activeSession, "messages", {
    get: () => activeSession.agent.state.messages,
  });
  fixture.input.prepared.sessionRuntime.sessionManager = manager;
  fixture.input.attempt.sessionTarget = target;
  fixture.input.attempt.sessionId = target.sessionId;
  fixture.input.attempt.sessionKey = target.sessionKey;
  fixture.input.getRepairedRejectedProviderReplay = () => false;
  fixture.input.preparedStreamRuntime.stream.getBeforeAgentFinalizeRevisionReason = () => undefined;
  fixture.sessionRuntimeState.currentTurnImageFailureCount = 1;
  const settleStream = mocks.settleStream.getMockImplementation()!;
  mocks.settleStream.mockImplementationOnce(async (...args) => ({
    ...(await settleStream(...args)),
    messagesSnapshot: [...previousMessages],
  }));
  const lifecycle = createEmbeddedAttemptTranscriptLifecycle(fixture.input.attempt);
  fixture.input.sessionLock.withOwnedTranscriptWrite = (operation) =>
    withOwnedSessionTranscriptWrites(
      {
        sessionTarget: {
          ...target,
          expectedLifecycleRevision: entry.lifecycleRevision,
          expectedWriterRunId: fixture.input.attempt.runId,
        },
        assertCommitAllowed: () => fixture.input.runAbortController.signal.throwIfAborted(),
        withTranscriptWrite: (write) => lifecycle.withTranscriptWrite(write),
      },
      () => lifecycle.withTranscriptWrite(operation),
    );
  return {
    fixture,
    target,
    manager,
    activeSession,
    before,
    previousLeaf,
    previousMessages,
    lifecycle,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.completeResult.mockReset();
});

describe("runEmbeddedAttemptSettledPhase", () => {
  it("runs prompt and finalization, cleans stream resources, then projects the result", async () => {
    const fixture = createFixture();

    const result = await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(result).toBe(fixture.result);
    expect(fixture.order).toEqual([
      "prompt",
      "finalize",
      "clear-timers",
      "unsubscribe",
      "detach-backend",
      "clear-active-run",
      "result",
    ]);
    expect(fixture.state).toEqual(
      expect.objectContaining({
        beforeAgentRunBlockedBy: "before_agent",
        terminal: { kind: "ok" },
        trajectoryEndRecorded: true,
      }),
    );
    expect(fixture.sessionRuntimeState).toEqual(
      expect.objectContaining({
        prePromptMessageCount: 4,
        promptCache: { cacheRead: 1 },
      }),
    );
    expect(mocks.completeAfterTurn).toHaveBeenCalledWith(
      fixture.input,
      expect.objectContaining({ sessionIdUsed: "settled-session" }),
      expect.objectContaining({ transcriptLeafId: "before-prompt" }),
    );
    expect(mocks.completeResult).toHaveBeenCalledWith(
      fixture.input,
      expect.objectContaining({ sessionIdUsed: "settled-session" }),
      expect.objectContaining({
        beforeAgentFinalizeRevisionReason: "revision",
        sessionIdUsed: "settled-session",
        sessionFileUsed: "/tmp/session.jsonl",
      }),
    );
    expect(fixture.detachBackend).toHaveBeenCalledWith(fixture.queueHandle);
    expect(mocks.clearActiveEmbeddedRun).toHaveBeenCalledWith(
      "session-1",
      fixture.queueHandle,
      "agent:main",
      "/tmp/session.jsonl",
    );
  });

  it("persists image failure notes after after-turn transcript reconciliation", async () => {
    const fixture = createFixture();
    fixture.sessionRuntimeState.currentTurnImageFailureCount = 1;
    await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(fixture.sessionManager.appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "openclaw.system-note",
        display: true,
        content: expect.stringMatching(/1.*image contents.*unavailable.*resend.*not claim/is),
      }),
    );
    expect(fixture.sessionManager.appendMessage.mock.calls[0]?.[0]).not.toHaveProperty(
      "excludeFromContext",
    );
    expect(mocks.completeResult).toHaveBeenCalledWith(
      fixture.input,
      expect.any(Object),
      expect.objectContaining({
        messagesSnapshot: expect.arrayContaining([
          expect.objectContaining({ customType: "openclaw.system-note", display: true }),
        ]),
      }),
    );
  });

  it("persists and publishes image failure notes through settlement without parent SQL", async () => {
    await withOpenClawTestState({ label: "settled-image-note" }, async (testState) => {
      const { fixture, target, activeSession, before, previousLeaf, previousMessages, lifecycle } =
        await createPersistedImageNoteFixture(testState);
      const actualAttemptResult =
        await vi.importActual<typeof import("./attempt-result.js")>("./attempt-result.js");
      mocks.completeResult.mockImplementationOnce(
        actualAttemptResult.completeEmbeddedAttemptResult,
      );

      try {
        const database = openOpenClawAgentDatabase({ agentId: "main", path: target.storePath });
        // Prepare before instrumentation so the probes must observe cached statements too.
        const calibration = database.db.prepare("SELECT 1 AS value");
        const probes = {
          prepare: vi.spyOn(DatabaseSync.prototype, "prepare"),
          exec: vi.spyOn(DatabaseSync.prototype, "exec"),
          get: vi.spyOn(StatementSync.prototype, "get"),
          all: vi.spyOn(StatementSync.prototype, "all"),
          run: vi.spyOn(StatementSync.prototype, "run"),
          iterate: vi.spyOn(StatementSync.prototype, "iterate"),
        };
        const measured = await (async () => {
          try {
            database.db.exec("SELECT 1");
            database.db.prepare("SELECT 1");
            calibration.get();
            calibration.all();
            calibration.run();
            expect([...calibration.iterate()]).toEqual([{ value: 1 }]);
            for (const [name, probe] of Object.entries(probes)) {
              expect(
                probe.mock.calls.length,
                `positive parent ${name} calibration`,
              ).toBeGreaterThan(0);
              probe.mockClear();
            }

            const result = await runEmbeddedAttemptSettledPhase(fixture.input);
            return {
              result,
              parentSql: Object.fromEntries(
                Object.entries(probes).map(([name, probe]) => [name, probe.mock.calls.length]),
              ),
            };
          } finally {
            Object.values(probes).forEach((probe) => probe.mockRestore());
          }
        })();

        const after = await loadTranscriptEvents(target);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after).toHaveLength(before.length + 1);
        const reopened = SessionManager.open(target);
        const appended = reopened.getLeafEntry();
        expect(appended).toMatchObject({
          type: "message",
          parentId: previousLeaf,
          message: {
            role: "custom",
            customType: "openclaw.system-note",
            display: true,
            content: expect.stringMatching(/1.*image contents.*unavailable.*resend.*not claim/is),
            details: {
              source: "prompt-image-hydration",
              runId: fixture.input.attempt.runId,
              failedMediaCount: 1,
            },
            timestamp: expect.any(Number),
          },
        });
        if (appended?.type !== "message") {
          throw new Error("Expected a durable image failure message");
        }
        expect(appended.message).not.toHaveProperty("excludeFromContext");
        const expectedMessages = [...previousMessages, appended.message];
        expect(activeSession.messages).toEqual(expectedMessages);
        expect(measured.result.messagesSnapshot).toEqual(expectedMessages);
        expect(fixture.unsubscribe).toHaveBeenCalledOnce();
        expect(fixture.detachBackend).toHaveBeenCalledOnce();
        expect(measured.parentSql).toEqual({
          prepare: 0,
          exec: 0,
          get: 0,
          all: 0,
          run: 0,
          iterate: 0,
        });
      } finally {
        await lifecycle.dispose();
      }
    });
  });

  it.each(["file-backed", "incognito"] as const)(
    "publishes the canonical redacted %s image failure note into live messages and the result",
    async (storage) => {
      await withOpenClawTestState({ label: "settled-image-note-redaction" }, async (testState) => {
        const { fixture, target, activeSession, previousMessages, lifecycle } =
          await createPersistedImageNoteFixture(testState, storage);
        fixture.input.attempt.config = { logging: { redactPatterns: ["run-1"] } };
        const actualAttemptResult =
          await vi.importActual<typeof import("./attempt-result.js")>("./attempt-result.js");
        mocks.completeResult.mockImplementationOnce(
          actualAttemptResult.completeEmbeddedAttemptResult,
        );
        try {
          const result = await runEmbeddedAttemptSettledPhase(fixture.input);
          const stored = SessionManager.open(target).getLeafEntry();
          expect(stored).toMatchObject({
            type: "message",
            message: { role: "custom", customType: "openclaw.system-note" },
          });
          if (stored?.type !== "message") {
            throw new Error("Expected a durable image failure message");
          }
          expect(JSON.stringify(stored.message)).not.toContain("run-1");
          const expected = [...previousMessages, stored.message];
          expect({ live: activeSession.messages, result: result.messagesSnapshot }).toEqual({
            live: expected,
            result: expected,
          });
        } finally {
          await lifecycle.dispose();
        }
      });
    },
  );

  it.each(["cancel before commit", "retarget after commit", "unknown reply after commit"] as const)(
    "keeps image note publication with its original owner: %s",
    async (transition) => {
      await withOpenClawTestState({ label: "settled-image-note-owner" }, async (testState) => {
        const { fixture, target, manager, activeSession, before, previousMessages, lifecycle } =
          await createPersistedImageNoteFixture(testState);
        const replacement = {
          ...target,
          sessionId: "replacement",
          sessionKey: "agent:main:replacement",
        };
        await upsertSessionEntryCore(replacement, {
          sessionId: replacement.sessionId,
          updatedAt: 1,
        });
        const replacementManager = SessionManager.open(replacement);
        replacementManager.appendMessage({
          role: "user",
          content: "Keep replacement",
          timestamp: 2,
        });
        await waitForSessionTranscriptProjection(replacement);
        const replacementBefore = await loadTranscriptEvents(replacement);
        const replacementMessages = replacementManager.buildSessionContext().messages;
        const committed = createDeferredCore();
        const release = createDeferredCore();
        const cancellation = new Error("image note owner cancelled before commit");
        let noteInFlight = false;
        let interceptedNotes = 0;
        let cancelledGrants = 0;
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        const admissionSpy = vi
          .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit) =>
            createAdmission((request, grant) => {
              if (
                transition === "cancel before commit" &&
                noteInFlight &&
                request.stage === "commit"
              ) {
                cancelledGrants++;
                fixture.input.runAbortController.abort(cancellation);
              }
              admit(request, grant);
            }),
          );
        const runOperation = workerStore.runSqliteWorkerStoreOperation;
        const operationSpy = vi
          .spyOn(workerStore, "runSqliteWorkerStoreOperation")
          .mockImplementation(
            <Operations extends SqliteWorkerOperations, T>(
              store: SqliteWorkerStore<Operations>,
              operation: (scope: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
              stateContext?: Parameters<typeof runOperation>[2],
              assertCurrent?: Parameters<typeof runOperation>[3],
              admission?: Parameters<typeof runOperation>[4],
              requireStateLifecycle?: Parameters<typeof runOperation>[5],
            ) =>
              runOperation(
                store,
                (scope) =>
                  operation({
                    execute: async (command, options) => {
                      const selected =
                        command.type === "database.domain.execute" &&
                        isRecord(command.input) &&
                        isRecord(command.input.command) &&
                        command.input.command.type === "session.transcript.appendMessage";
                      if (!selected) {
                        return await scope.execute(command, options);
                      }
                      interceptedNotes++;
                      noteInFlight = true;
                      try {
                        const result = await scope.execute(command, options);
                        if (transition === "unknown reply after commit") {
                          throw new SqliteWorkerError(
                            "Transcript reply outcome is unknown",
                            "outcome-unknown",
                          );
                        }
                        if (transition === "retarget after commit") {
                          committed.resolve();
                          await release.promise;
                        }
                        return result;
                      } finally {
                        noteInFlight = false;
                      }
                    },
                  }),
                stateContext,
                assertCurrent,
                admission,
                requireStateLifecycle,
              ),
          );
        const outcome = runEmbeddedAttemptSettledPhase(fixture.input).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        try {
          if (transition === "retarget after commit") {
            await Promise.race([
              committed.promise,
              outcome.then(() => {
                throw new Error("Attempt settled before the real image note commit boundary");
              }),
            ]);
            expect(activeSession.messages).toEqual(previousMessages);
            expect(mocks.completeResult).not.toHaveBeenCalled();
            manager.setSessionTarget(replacement);
            activeSession.agent.state.messages = [...replacementMessages];
            release.resolve();
          }
          const settled = await outcome;
          expect(interceptedNotes).toBe(1);
          expect(settled.ok).toBe(false);
          if (settled.ok) {
            throw new Error("Expected stale image note publication to be rejected");
          }
          expect(mocks.completeResult).not.toHaveBeenCalled();
          expect(fixture.unsubscribe).toHaveBeenCalledOnce();
          expect(fixture.detachBackend).toHaveBeenCalledOnce();
          expect(await loadTranscriptEvents(replacement)).toEqual(replacementBefore);
          const originalAfter = await loadTranscriptEvents(target);
          if (transition === "cancel before commit") {
            expect(cancelledGrants).toBe(1);
            expect(settled.error).toMatchObject({ message: cancellation.message });
            expect(isRecordedModelFallbackStop(settled.error)).toBe(false);
            expect(originalAfter).toEqual(before);
            expect(activeSession.messages).toEqual(previousMessages);
          } else {
            expect(cancelledGrants).toBe(0);
            expect(originalAfter.slice(0, before.length)).toEqual(before);
            expect(originalAfter).toHaveLength(before.length + 1);
            expect(originalAfter.at(-1)).toMatchObject({
              type: "message",
              message: {
                customType: "openclaw.system-note",
                details: { source: "prompt-image-hydration", runId: fixture.input.attempt.runId },
              },
            });
            expect(isRecordedModelFallbackStop(settled.error)).toBe(true);
            const committedEntry = SessionManager.open(target).getLeafEntry();
            expect(committedEntry).toBeDefined();
            if (transition === "retarget after commit") {
              expect(settled.error).toMatchObject({
                message: expect.stringMatching(/committed.*do not replay/is),
                committedMessageId: committedEntry?.id,
                committedTarget: target,
              });
              expect(activeSession.messages).toEqual(replacementMessages);
              expect(manager.getSessionTarget()?.sessionId).toBe(replacement.sessionId);
            } else {
              expect(settled.error).toMatchObject({ code: "outcome-unknown" });
              expect(settled.error).not.toHaveProperty("committedMessageId");
              expect(activeSession.messages).toEqual(previousMessages);
            }
          }
        } finally {
          release.resolve();
          await outcome;
          operationSpy.mockRestore();
          admissionSpy.mockRestore();
          await lifecycle.dispose();
        }
      });
    },
  );

  it("carries a successful hidden target through settlement into the terminal receipt", async () => {
    const fixture = createFixture();
    fixture.input.prepared.toolBase.nestedToolActivities.push(
      createNestedToolActivity({
        runId: "run-test",
        scopeId: "scope-test",
        afterEntryId: null,
        startOrder: 0,
        parentToolCallId: "outer-exec",
        toolCallId: "tool_search_code:outer-exec:read:1",
        toolName: "read",
        input: { path: "qa/scenarios/index.yaml" },
        result: {
          content: [{ type: "text", text: "QA scenario pack mission" }],
          details: {},
        },
        isError: false,
        startedAt: 1,
        timestamp: 2,
      }),
      createNestedToolActivity({
        runId: "run-test",
        scopeId: "scope-test",
        afterEntryId: null,
        startOrder: 0,
        parentToolCallId: "outer-exec",
        toolCallId: "tool_search_code:outer-exec:write:2",
        toolName: "write",
        input: { path: "qa/scenarios/index.yaml", content: "invalid" },
        result: {
          content: [{ type: "text", text: "write failed" }],
          details: {},
        },
        isError: true,
        startedAt: 3,
        timestamp: 4,
      }),
    );
    const actualStreamSettle = await vi.importActual<typeof import("./attempt-stream-settle.js")>(
      "./attempt-stream-settle.js",
    );
    const actualAttemptResult =
      await vi.importActual<typeof import("./attempt-result.js")>("./attempt-result.js");
    mocks.settleStream.mockImplementationOnce(actualStreamSettle.settleEmbeddedAttemptStream);
    mocks.completeResult.mockImplementationOnce(actualAttemptResult.completeEmbeddedAttemptResult);

    const attempt = await runEmbeddedAttemptSettledPhase(fixture.input);
    const prepared = prepareEmbeddedRunTerminal({
      runParams: {
        admittedRunContext: createTestAdmittedRunContext("run-1"),
        sessionId: "session-1",
        runId: "run-1",
        workspaceDir: "/workspace",
        prompt: "read the QA scenario index",
        trigger: "user",
        timeoutMs: 60_000,
      },
      attempt,
      currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
      provider: "openai",
      model: "model",
      activeErrorContext: { provider: "openai", model: "model" },
      authProfileStore: { version: 1, profiles: {} },
      sessionIdUsed: attempt.sessionIdUsed,
      sessionFileUsed: attempt.sessionFileUsed,
      outerContextTokenMeta: {},
      usageAccumulator: createUsageAccumulator(),
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      resolvedToolResultFormat: "markdown",
      terminalState: {
        outcome: { reason: "completed", status: "ok", stopReason: "stop" },
        signalOwnedInterruption: false,
      },
    });

    expect(
      (
        prepared.agentMeta as {
          terminalReceipt?: { successfulToolNames?: string[] };
        }
      ).terminalReceipt?.successfulToolNames,
    ).toEqual(["exec", "read"]);
  });

  it("preserves a prompt failure while still completing stream cleanup", async () => {
    const fixture = createFixture();
    const failure = new Error("prompt failed");
    mocks.runPrompt.mockRejectedValueOnce(failure);
    fixture.unsubscribe.mockImplementationOnce(() => {
      fixture.order.push("unsubscribe");
      throw new Error("unsubscribe failed");
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(mocks.settleStream).not.toHaveBeenCalled();
    expect(mocks.completeResult).not.toHaveBeenCalled();
    expect(fixture.clearTimers).toHaveBeenCalledOnce();
    expect(fixture.detachBackend).toHaveBeenCalledWith(fixture.queueHandle);
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining("unsubscribe failed, possible resource leak"),
    );
  });

  it("releases the active run when backend cleanup throws during a failed prompt", async () => {
    const fixture = createFixture();
    const failure = new Error("prompt failed");
    mocks.runPrompt.mockRejectedValueOnce(failure);
    fixture.detachBackend.mockImplementationOnce(() => {
      fixture.order.push("detach-backend");
      throw new Error("backend detach failed");
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(mocks.clearActiveEmbeddedRun).toHaveBeenCalledOnce();
    expect(mocks.logError).toHaveBeenCalledWith(
      expect.stringContaining("backend detach failed, possible resource leak"),
    );
  });

  it("reports a backend cleanup failure after releasing a successful run", async () => {
    const fixture = createFixture();
    const failure = new Error("backend detach failed");
    fixture.detachBackend.mockImplementationOnce(() => {
      fixture.order.push("detach-backend");
      throw failure;
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(mocks.clearActiveEmbeddedRun).toHaveBeenCalledOnce();
  });

  it("reports active-run cleanup failure after detaching the backend", async () => {
    const fixture = createFixture();
    const failure = new Error("active run cleanup failed");
    mocks.clearActiveEmbeddedRun.mockImplementationOnce(() => {
      fixture.order.push("clear-active-run");
      throw failure;
    });

    await expect(runEmbeddedAttemptSettledPhase(fixture.input)).rejects.toBe(failure);

    expect(fixture.detachBackend).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "retains child receipts for logical-run settlement (yielded: %s)",
    async (yieldDetected) => {
      const fixture = createFixture();
      const acceptedSessionSpawns = [
        {
          runId: "child-run",
          childSessionKey: "agent:main:subagent:child",
          expectsCompletionMessage: true,
        },
      ];
      mocks.completeResult.mockReturnValueOnce({
        ...fixture.result,
        terminal: { kind: "ok" },
        yieldDetected,
        acceptedSessionSpawns,
      });

      const result = await runEmbeddedAttemptSettledPhase(fixture.input);

      expect(result.acceptedSessionSpawns).toEqual(acceptedSessionSpawns);
      expect(fixture.order).toContain("clear-active-run");
      expect(mocks.markRequesterTurnYielded).not.toHaveBeenCalled();
      expect(mocks.settleRequesterAfterSessionSpawns).not.toHaveBeenCalled();
    },
  );

  it("defaults a source-less settlement failure without dropping it", async () => {
    const fixture = createFixture();
    const failure = new Error("settlement failed");
    mocks.settleStream.mockImplementationOnce(async () => {
      return {
        promptError: failure,
        promptErrorSource: null,
        timedOutDuringCompaction: true,
        messagesSnapshot: [],
        sessionIdUsed: "settled-session",
        lastAssistant: undefined,
        currentAttemptAssistant: undefined,
        attemptUsage: undefined,
        promptCache: undefined,
        lastCallUsage: undefined,
        compactionOccurredThisAttempt: false,
      };
    });

    await runEmbeddedAttemptSettledPhase(fixture.input);

    expect(fixture.state.terminal).toEqual({
      kind: "failed",
      source: "prompt",
      error: failure,
      timeoutObservation: "compaction",
    });
  });
});
