import { performance } from "node:perf_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";

const mocks = vi.hoisted(() => ({
  createAnthropicPayloadLogger: vi.fn(),
  createCacheTrace: vi.fn(),
  createSessionSettleTracker: vi.fn(),
  getSessionPromptState: vi.fn(),
  installContextGuards: vi.fn(),
  prepareAgentSession: vi.fn(),
  prepareSessionBoundary: vi.fn(),
  prepareSessionManager: vi.fn(),
  buildTrajectoryRunMetadata: vi.fn(),
  createTrajectoryRuntimeRecorder: vi.fn(),
  resolveTrajectorySessionFile: vi.fn(),
  prepareTransport: vi.fn(),
  restoreProjections: vi.fn(),
}));

vi.mock("../../anthropic-payload-log.js", () => ({
  createAnthropicPayloadLogger: mocks.createAnthropicPayloadLogger,
}));
vi.mock("../../cache-trace.js", () => ({ createCacheTrace: mocks.createCacheTrace }));
vi.mock("../session-prompt-state.js", () => ({
  getEmbeddedSessionPromptState: mocks.getSessionPromptState,
}));
vi.mock("../tool-result-truncation.js", () => ({
  restoreCacheTtlToolResultProjections: mocks.restoreProjections,
}));
vi.mock("./attempt-setup.js", () => ({
  installEmbeddedAttemptContextGuards: mocks.installContextGuards,
}));
vi.mock("./attempt-session-prepare.js", () => ({
  prepareEmbeddedAttemptAgentSession: mocks.prepareAgentSession,
  prepareEmbeddedAttemptSessionBoundary: mocks.prepareSessionBoundary,
  prepareEmbeddedAttemptSessionManager: mocks.prepareSessionManager,
}));
vi.mock("./attempt-session-settle.js", () => ({
  createEmbeddedAttemptSessionSettleTracker: mocks.createSessionSettleTracker,
}));
vi.mock("./attempt-stream-settle.js", () => ({
  prepareEmbeddedAttemptTransport: mocks.prepareTransport,
}));
vi.mock("../../../trajectory/metadata.js", () => ({
  buildTrajectoryRunMetadata: mocks.buildTrajectoryRunMetadata,
}));
vi.mock("../../../trajectory/runtime.js", () => ({
  createTrajectoryRuntimeRecorder: mocks.createTrajectoryRuntimeRecorder,
}));
vi.mock("./attempt-transcript-helpers.js", () => ({
  resolveAttemptTrajectorySessionFile: mocks.resolveTrajectorySessionFile,
}));

import { createEmbeddedAttemptPreparation } from "./attempt-preparation.js";
import { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";
import { cleanupEmbeddedAttemptResources } from "./attempt-subscription-cleanup.js";

type PrepareInput = Parameters<typeof prepareEmbeddedAttemptSessionRuntime>[0];

function createFixture(runId = "run-1") {
  const order: string[] = [];
  const activeMarker = { type: "custom", customType: "openclaw.cache-ttl", data: "active" };
  const sessionManager = {
    kind: "manager",
    getBranch: () => [activeMarker],
    getEntries: () => [activeMarker, { ...activeMarker, data: "sibling" }],
  };
  const activeSession = {
    dispose: vi.fn(),
    messages: [{ role: "user" }, { role: "assistant" }],
    sessionId: "active-session",
  };
  const settingsManager = { kind: "settings" };
  const setActiveSessionSystemPrompt = vi.fn();
  const agentSession = {
    activeSession,
    clientToolDefs: [{ name: "read" }, { name: "write" }],
    setActiveSessionSystemPrompt,
    settingsManager,
  };
  const boundary = { setCurrentUserTimestampOverride: vi.fn() };
  const promptState = { toolResults: { projected: true } };
  const abortActiveSession = vi.fn(async () => undefined);
  const buildAbortSettlePromise = vi.fn(() => null);
  const trackPromptSettlePromise = vi.fn((promise: Promise<void>) => promise);
  const settleTracker = {
    abortActiveSession,
    buildAbortSettlePromise,
    trackPromptSettlePromise,
  };
  const contextGuards = {
    getAfterTurnCheckpoint: vi.fn(() => null),
    remove: vi.fn(),
    takePendingMidTurnPrecheckRequest: vi.fn(() => null),
  };
  const cacheTrace = { kind: "cache-trace" };
  const anthropicPayloadLogger = { kind: "payload-logger" };
  const trajectoryRecorder = {
    enabled: true,
    recordEvent:
      vi.fn<NonNullable<PrepareInput["resources"]["trajectoryRecorder"]>["recordEvent"]>(),
    flush: async () => {},
    describeFlushState: () => undefined,
  } satisfies NonNullable<PrepareInput["resources"]["trajectoryRecorder"]>;
  const transport = {
    compactionReplayEnabled: true,
    effectiveAgentTransport: "sse",
    effectiveExtraParams: { cacheRetention: "long" },
    effectivePromptCacheRetention: "long",
    providerTextTransforms: undefined,
    streamStrategy: "provider",
  };
  const transcriptPolicy = { repairToolUseResultPairing: true };
  const getUserTranscriptContexts = vi.fn(() => []);

  mocks.prepareSessionManager.mockImplementation(async (input) => {
    order.push("manager");
    input.onSessionManagerCreated(sessionManager);
    return {
      isOpenAIResponsesApi: true,
      preparedUserTurnMessage: { role: "user", content: "hello" },
      sessionManager,
      transcriptPolicy,
      userMessageBoundary: {
        getUserTranscriptContexts,
        preparedUserTurnMessage: { role: "user", content: "hello" },
      },
    };
  });
  mocks.prepareAgentSession.mockImplementation(async (input) => {
    order.push("agent-session");
    input.onSessionCreated(activeSession);
    input.onSystemPromptChanged("runtime prompt");
    return agentSession;
  });
  mocks.prepareSessionBoundary.mockImplementation(() => {
    order.push("boundary");
    return boundary;
  });
  mocks.getSessionPromptState.mockImplementation(() => {
    order.push("prompt-state");
    return promptState;
  });
  mocks.createSessionSettleTracker.mockImplementation(() => {
    order.push("settle-tracker");
    return settleTracker;
  });
  mocks.installContextGuards.mockImplementation(() => {
    order.push("context-guards");
    return contextGuards;
  });
  mocks.createCacheTrace.mockImplementation(() => {
    order.push("cache-trace");
    return cacheTrace;
  });
  mocks.createAnthropicPayloadLogger.mockImplementation(() => {
    order.push("payload-logger");
    return anthropicPayloadLogger;
  });
  mocks.resolveTrajectorySessionFile.mockResolvedValue("/tmp/trajectory.jsonl");
  mocks.buildTrajectoryRunMetadata.mockReturnValue({ trace: "metadata" });
  mocks.createTrajectoryRuntimeRecorder.mockImplementation(() => {
    order.push("trajectory");
    return trajectoryRecorder;
  });
  mocks.prepareTransport.mockImplementation(async () => {
    order.push("transport");
    return transport;
  });

  const resourceEvents: Record<string, string> = {
    session: "own-session",
    sessionManager: "own-manager",
    getUserTranscriptContexts: "own-user-transcript-contexts",
    removeToolResultContextGuard: "own-context-guards",
    buildAbortSettlePromise: "own-settle-tracker",
    trajectoryRecorder: "own-trajectory",
  };
  const resources = new Proxy<PrepareInput["resources"]>(
    { trajectoryRecorder: null, buildAbortSettlePromise: () => null },
    {
      set: (target, key, value) => {
        order.push(resourceEvents[String(key)]!);
        return Reflect.set(target, key, value);
      },
    },
  );
  const onSessionYieldReady = vi.fn(() => order.push("own-yield"));
  const externalAbortController = {
    setActiveSessionAbort: vi.fn(() => order.push("arm-session-abort")),
  };
  const abortController = new AbortController();
  const prepare = createEmbeddedAttemptPreparation({
    assertCurrent: () => abortController.signal.throwIfAborted(),
  });
  const input = {
    attempt: {
      model: { api: "openai-responses", contextWindow: 128_000 },
      modelId: "gpt-5",
      provider: "openai",
      runId,
      sessionId: "session-1",
      workspaceDir: "/workspace",
    },
    agentDir: "/agent",
    prepare,
    isRawModelRun: false,
    resolveActiveContextEnginePluginId: vi.fn(),
    setup: {
      agentCoreThinkingLevel: "medium",
      effectiveCwd: "/workspace",
      effectiveWorkspace: "/workspace",
      getCurrentAttemptPluginMetadataSnapshot: vi.fn(),
      getProviderRuntimeHandle: vi.fn(),
      prepStages: { mark: vi.fn() },
      providerThinkingLevel: "medium",
      sessionAgentId: "main",
      sandboxSessionKey: "sandbox-1",
    },
    toolBase: {
      computerContextEpoch: { value: 0 },
      localModelLeanEnabled: false,
      codeModeControlsEnabledForRun: false,
    },
    toolCatalog: {
      effectiveTools: Array.from({ length: 4 }, (_, i) => ({ name: `tool-${i}` })),
      toolSearchRunPlan: { replayAllowedToolNames: new Set(["read"]) },
    },
    bundleTools: { clientTools: [], uncompactedEffectiveTools: [] },
    systemPrompt: { systemPromptText: "initial prompt" },
    sessionLock: {
      transcriptLifecycle: {},
      withOwnedTranscriptWrite: vi.fn(async (operation: () => unknown) => {
        order.push("owned-boundary");
        return await operation();
      }),
    },
    runAbortSignal: abortController.signal,
    externalAbortController,
    resources,
    onSessionYieldReady,
  } as unknown as PrepareInput;

  return {
    abortController,
    abortActiveSession,
    activeSession,
    anthropicPayloadLogger,
    boundary,
    buildAbortSettlePromise,
    cacheTrace,
    contextGuards,
    externalAbortController,
    getUserTranscriptContexts,
    input,
    prepare,
    resources,
    onSessionYieldReady,
    order,
    promptState,
    sessionManager,
    settingsManager,
    trajectoryRecorder,
    transport,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepareEmbeddedAttemptSessionRuntime", () => {
  it("prepares the session runtime in ownership-safe order and keeps prompt state live", async () => {
    const fixture = createFixture();

    const result = await prepareEmbeddedAttemptSessionRuntime(fixture.input);

    expect(mocks.restoreProjections).toHaveBeenCalledWith(
      fixture.promptState.toolResults,
      fixture.sessionManager.getBranch(),
    );
    expect(fixture.order).toEqual([
      "manager",
      "own-manager",
      "own-user-transcript-contexts",
      "agent-session",
      "own-session",
      "owned-boundary",
      "boundary",
      "prompt-state",
      "settle-tracker",
      "arm-session-abort",
      "own-settle-tracker",
      "own-yield",
      "context-guards",
      "own-context-guards",
      "cache-trace",
      "payload-logger",
      "trajectory",
      "own-trajectory",
      "transport",
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        anthropicPayloadLogger: fixture.anthropicPayloadLogger,
        boundary: fixture.boundary,
        cacheTrace: fixture.cacheTrace,
        contextGuards: fixture.contextGuards,
        sessionManager: fixture.sessionManager,
        sessionPromptState: fixture.promptState,
        toolResultPromptProjectionState: fixture.promptState.toolResults,
        trajectoryRecorder: fixture.trajectoryRecorder,
        transport: fixture.transport,
      }),
    );
    expect(result.state).toEqual({
      currentTurnImageFailureCount: 0,
      prePromptMessageCount: 2,
      promptCache: undefined,
      systemPromptText: "runtime prompt",
    });
    expect(mocks.prepareSessionBoundary).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: fixture.input.runAbortSignal,
        getUserTranscriptContexts: fixture.getUserTranscriptContexts,
        preparedUserTurnMessage: { role: "user", content: "hello" },
      }),
    );
    expect(fixture.externalAbortController.setActiveSessionAbort).toHaveBeenCalledWith(
      fixture.abortActiveSession,
    );
    expect(fixture.resources.buildAbortSettlePromise).toBe(fixture.buildAbortSettlePromise);
    expect(fixture.resources.getUserTranscriptContexts).toBe(fixture.getUserTranscriptContexts);
    expect(fixture.onSessionYieldReady).toHaveBeenCalledWith({
      abortActiveSession: fixture.abortActiveSession,
      activeSession: fixture.activeSession,
    });

    result.state.prePromptMessageCount = 7;
    result.state.promptCache = { cacheRead: 3 } as never;
    result.state.systemPromptText = "updated prompt";
    const guardInput = mocks.installContextGuards.mock.calls[0]?.[0];
    expect(guardInput.getPrePromptMessageCount()).toBe(7);
    expect(guardInput.getPromptCache()).toEqual({ cacheRead: 3 });
    expect(guardInput.getPromptCacheRetention()).toBe("long");
    expect(guardInput.getCompactionReplayEnabled()).toBe(true);
    expect(guardInput.getSystemPrompt()).toBe("updated prompt");
    guardInput.onCurrentTurnImageFailure(2);
    guardInput.onCurrentTurnImageFailure(1);
    expect(result.state.currentTurnImageFailureCount).toBe(2);
  });

  it("publishes every cleanup owner before a later transport failure", async () => {
    const fixture = createFixture();
    mocks.prepareTransport.mockRejectedValueOnce(new Error("transport failed"));

    await expect(prepareEmbeddedAttemptSessionRuntime(fixture.input)).rejects.toThrow(
      "transport failed",
    );

    expect(fixture.resources.sessionManager).toBe(fixture.sessionManager);
    expect(fixture.resources.session).toBe(fixture.activeSession);
    expect(fixture.resources.removeToolResultContextGuard).toBe(fixture.contextGuards.remove);
    expect(fixture.resources.buildAbortSettlePromise).toBe(fixture.buildAbortSettlePromise);
    expect(fixture.resources.trajectoryRecorder).toBe(fixture.trajectoryRecorder);
  });

  it("settles pending user-turn persistence before reconciling the session boundary", async () => {
    const fixture = createFixture();
    let releasePersistence: (() => void) | undefined;
    const pendingPersistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const waitForRuntimePersistence = vi.fn(async () => await pendingPersistence);
    fixture.input.attempt.userTurnTranscriptRecorder = {
      waitForRuntimePersistence,
    } as unknown as PrepareInput["attempt"]["userTurnTranscriptRecorder"];

    const preparing = prepareEmbeddedAttemptSessionRuntime(fixture.input);
    await vi.waitFor(() => expect(waitForRuntimePersistence).toHaveBeenCalledOnce());
    expect(mocks.prepareSessionBoundary).not.toHaveBeenCalled();

    releasePersistence?.();
    await preparing;

    expect(mocks.prepareSessionBoundary).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "admits control work between expensive ready trajectory seeds (cancel second: %s)",
    async (cancelSecond) => {
      let elapsed = 0;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
      const events: string[] = [];
      const pathsReady = createDeferred();
      const controlDone = createDeferred();
      const failure = new Error("cancelled before trajectory seeding");
      let firstRecorderOwnedAtControl = false;
      try {
        const start = async (runId: string) => {
          const fixture = createFixture(runId);
          const reachedPath = createDeferred();
          mocks.resolveTrajectorySessionFile.mockImplementationOnce(async () => {
            reachedPath.resolve();
            await pathsReady.promise;
            return "/tmp/trajectory.jsonl";
          });
          const result = fixture.prepare("attempt.session-runtime", () =>
            prepareEmbeddedAttemptSessionRuntime(fixture.input),
          );
          await reachedPath.promise;
          return { fixture, result };
        };
        const first = await start("first");
        const second = await start("second");
        const results = Promise.allSettled([first.result, second.result]);
        mocks.createTrajectoryRuntimeRecorder.mockImplementation(({ runId }) => {
          const { fixture } = runId === "first" ? first : second;
          fixture.trajectoryRecorder.recordEvent.mockImplementation((event: string) => {
            if (event === "trace.metadata") {
              events.push(`${runId}.seed`);
              elapsed += 10;
            }
          });
          return fixture.trajectoryRecorder;
        });
        setImmediate(() => {
          firstRecorderOwnedAtControl =
            first.fixture.resources.trajectoryRecorder === first.fixture.trajectoryRecorder;
          events.push("control");
          if (cancelSecond) {
            second.fixture.abortController.abort(failure);
          }
          controlDone.resolve();
        });
        pathsReady.resolve();

        const [firstResult, secondResult] = await results;
        await controlDone.promise;
        expect(firstResult.status).toBe("fulfilled");
        expect(firstRecorderOwnedAtControl).toBe(true);
        expect(first.fixture.resources.trajectoryRecorder).toBe(first.fixture.trajectoryRecorder);
        expect(events).toEqual(
          cancelSecond ? ["first.seed", "control"] : ["first.seed", "control", "second.seed"],
        );
        if (!cancelSecond) {
          expect(secondResult.status).toBe("fulfilled");
          expect(second.fixture.resources.trajectoryRecorder).toBe(
            second.fixture.trajectoryRecorder,
          );
          return;
        }

        expect(secondResult).toEqual({ status: "rejected", reason: failure });
        expect(mocks.createTrajectoryRuntimeRecorder).toHaveBeenCalledOnce();
        const { resources, activeSession, contextGuards, sessionManager } = second.fixture;
        expect(resources.trajectoryRecorder).toBeNull();
        expect(resources.session).toBe(activeSession);
        expect(resources.sessionManager).toBe(sessionManager);
        const flushReady = createDeferred();
        const flush = vi.fn(async () => await flushReady.promise);
        const cleanup = cleanupEmbeddedAttemptResources({
          ...resources,
          sessionManager: resources.sessionManager,
          flushPendingToolResultsAfterIdle: flush,
          aborted: true,
          abortSettlePromise: resources.buildAbortSettlePromise(),
        });
        expect(contextGuards.remove).toHaveBeenCalledOnce();
        expect(activeSession.dispose).not.toHaveBeenCalled();
        flushReady.resolve();
        await cleanup;
        expect(flush).toHaveBeenCalledWith({ agent: undefined, sessionManager, timeoutMs: 0 });
        expect(activeSession.dispose).toHaveBeenCalledOnce();
        await expect(first.fixture.prepare("attempt.tool-catalog", () => "next")).resolves.toBe(
          "next",
        );
      } finally {
        pathsReady.resolve();
        clock.mockRestore();
      }
    },
  );
});
