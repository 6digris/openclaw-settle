import { vi } from "vitest";
import type { ReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import { createDiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import type { NestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import type { AgentSession } from "../../sessions/agent-session.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";

export function prepareCatalogExecutor(
  projections: NestedToolActivity[],
  options?: {
    activeSession?: AgentSession;
    attempt?: Partial<Parameters<typeof prepareEmbeddedAttemptStream>[0]["attempt"]>;
    getRunState?: () => {
      aborted: boolean;
      promptError: unknown;
      timedOut: boolean;
      yieldDetected: boolean;
    };
    runAbortController?: AbortController;
    sandboxSessionKey?: string;
    sessionKey?: string;
    replyOperation?: ReplyOperation;
    onAttemptAbort?: () => void;
    abortRun?: (isTimeout?: boolean, reason?: unknown) => void;
    markExternalAbort?: () => void;
    toolProgressDetail?: "explain" | "raw";
    onAgentEvent?: (event: { stream: string; data: Record<string, unknown> }) => void;
    trustedLocalMediaToolNames?: ReadonlySet<string>;
  },
) {
  const runAbortController = options?.runAbortController ?? new AbortController();
  return prepareEmbeddedAttemptStream({
    attempt: {
      runId: "run-output-schema",
      sessionId: "session-output-schema",
      sessionKey: options?.sessionKey ?? "agent:main:main",
      replyOperation: options?.replyOperation,
      onAttemptAbort: options?.onAttemptAbort,
      toolProgressDetail: options?.toolProgressDetail,
      onAgentEvent: options?.onAgentEvent,
      ...options?.attempt,
    } as never,
    activeSession:
      options?.activeSession ??
      ({
        agent: {},
        isStreaming: false,
        sessionManager: SessionManager.inMemory(),
        subscribe: () => () => {},
      } as never),
    hookRunner: undefined as never,
    hookAgentId: "main",
    diagnosticTrace: {} as never,
    diagnosticOwner: createDiagnosticEmbeddedRunOwner({
      sessionId: "session-output-schema",
      runId: "run-output-schema",
    }),
    clientToolCallSlots: [],
    nestedToolActivities: projections,
    isReplaySafeTool: () => false,
    runAbortController,
    abortRun: options?.abortRun ?? vi.fn(),
    markExternalAbort: options?.markExternalAbort ?? vi.fn(),
    getRunState:
      options?.getRunState ??
      (() => ({
        aborted: false,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      })),
    hasDeliveredSourceReply: () => false,
    markSourceReplyDelivered: vi.fn(),
    onBlockReply: vi.fn(),
    onBlockReplyFlush: vi.fn(),
    sandboxSessionKey: options?.sandboxSessionKey ?? "agent:main:main",
    builtinToolNames: new Set(),
    replaySafeToolNames: new Set(),
    trustedLocalMediaToolNames: options?.trustedLocalMediaToolNames ?? new Set(),
  });
}
