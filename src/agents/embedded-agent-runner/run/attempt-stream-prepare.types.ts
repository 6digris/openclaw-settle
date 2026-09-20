import type { DiagnosticTraceContext } from "../../../infra/diagnostic-trace-context.js";
import type { DiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import type { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { NestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import type { AgentSession } from "../../sessions/index.js";
import type { ToolSearchCatalogToolExecutor } from "../../tool-search.js";
import type { createEmbeddedAttemptDeferredLifecycleOwner } from "./deferred-lifecycle-owner.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import type {
  EmbeddedAttemptClientToolCallSlot,
  EmbeddedRunAttemptParams,
  StreamRunState,
} from "./types.js";

export type PrepareEmbeddedAttemptStreamInput = {
  attempt: EmbeddedRunAttemptInternalParams;
  applyPermissionMode?: (
    mode: NonNullable<EmbeddedRunAttemptParams["permissionMode"]> | null,
    revokeApprovals: () => void,
  ) => void;
  activeSession: AgentSession;
  onModelUsage?: Parameters<typeof subscribeEmbeddedAgentSession>[0]["onModelUsage"];
  runtimeChannel?: string;
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  hookAgentId: string;
  diagnosticTrace: DiagnosticTraceContext;
  clientToolCallSlots: readonly EmbeddedAttemptClientToolCallSlot[];
  nestedToolActivities: NestedToolActivity[];
  isReplaySafeTool: (tool: Parameters<ToolSearchCatalogToolExecutor>[0]["tool"]) => boolean;
  runAbortController: AbortController;
  abortRun: (isTimeout?: boolean, reason?: unknown) => void;
  markExternalAbort: () => void;
  getRunState: () => StreamRunState;
  hasDeliveredSourceReply: () => boolean;
  markSourceReplyDelivered: () => void;
  onBlockReply: EmbeddedRunAttemptParams["onBlockReply"];
  onBlockReplyFlush: EmbeddedRunAttemptParams["onBlockReplyFlush"];
  sandboxSessionKey: string;
  builtinToolNames: ReadonlySet<string>;
  coreBuiltinToolNames?: ReadonlySet<string>;
  replaySafeToolNames: ReadonlySet<string>;
  codeModeExecToolNames?: ReadonlySet<string>;
  sideEffectToolOwners?: ReadonlyMap<string, string>;
  trustedLocalMediaToolNames: ReadonlySet<string>;
  diagnosticOwner: DiagnosticEmbeddedRunOwner;
  trajectoryRecorder?: Parameters<
    typeof createEmbeddedAttemptDeferredLifecycleOwner
  >[0]["trajectoryRecorder"];
};
