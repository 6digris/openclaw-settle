import type { CodexAppServerClient } from "./client.js";
/** Minimal orchestration fixture; execution/replay/diagnostics remain owned by the real controller. */
import type { CodexDynamicToolBridge } from "./dynamic-tools.js";
import { createCodexAttemptServerRequestController } from "./run-attempt-server-requests.js";
import { createCodexDynamicToolExecutionRegistry } from "./run-attempt-tools.js";

export function createNativeToolControllerFixture(params: {
  bridge: CodexDynamicToolBridge;
  client: CodexAppServerClient;
  threadId: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
  signal: AbortSignal;
}) {
  const turnIdRef: { current?: string } = {};
  const resources = {
    prompt: {
      context: {
        runtime: {
          connection: {
            params: {
              runId: params.runId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              agentId: "main",
              config: {},
            },
            computerUseConfig: { enabled: false },
            runAbortController: { signal: params.signal },
            appServer: { approvalPolicy: "never" },
            sessionAgentId: "main",
          },
        },
        attemptTools: {
          toolBridge: params.bridge,
          toolOutcomeOrdinals: new Map(),
          suppressedDynamicToolOutcomeOrdinals: new Set(),
        },
      },
    },
    state: { client: params.client, thread: { threadId: params.threadId } },
    projectorRef: {},
  } as unknown as Parameters<typeof createCodexAttemptServerRequestController>[0];
  const turn = {
    state: { activeAppServerTurnRequests: 0 },
    turnIdRef,
    userInputBridgeRef: {},
    openClawDynamicToolExecutions: createCodexDynamicToolExecutionRegistry(),
    pendingOpenClawDynamicToolCompletionIds: new Set(),
    noteProgress: () => {},
  } as unknown as Parameters<typeof createCodexAttemptServerRequestController>[1];
  const lifecycle = {
    emitExecutionPhaseOnce: () => {},
    scheduleTurnReleaseAfterTerminalDynamicTool: () => {},
    scheduleTerminalDynamicToolReleaseCheck: () => {},
  } as unknown as Parameters<typeof createCodexAttemptServerRequestController>[2];
  const controller = createCodexAttemptServerRequestController(
    resources,
    turn,
    lifecycle,
    async () => {},
  );
  return { ...controller, turnIdRef };
}
