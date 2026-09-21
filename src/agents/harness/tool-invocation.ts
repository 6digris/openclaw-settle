import { asNonArrayRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";
import type { AgentToolResultMiddlewareEvent } from "../../plugins/agent-tool-result-middleware-types.js";
import { runWithToolExecutionValidation } from "../agent-tools.execution-validation.js";
import type { AnyAgentTool } from "../agent-tools.types.js";
import {
  consumeTrustedToolNoStartError,
  isToolResultError,
  resolveToolResultFailureKind,
} from "../tool-result-error.js";
import { createAgentHarnessToolExecutionBoundaryRegistry } from "./tool-execution.js";
import { resolveAgentHarnessToolResultPresentation } from "./tool-result-facts.js";

/** Owns host execution and presentation; adapters retain their native terminal owner. */
export async function runAgentHarnessToolInvocation<TResult>(params: {
  tool?: AnyAgentTool;
  unavailableToolMessage?: string;
  call: AgentHarnessToolCall;
  runId?: string;
  signal: AbortSignal;
  boundaries: ReturnType<typeof createAgentHarnessToolExecutionBoundaryRegistry>;
  retainExecutionSnapshot?: boolean;
  prepareArguments?: (args: unknown) => unknown;
  assertCurrent?: () => void;
  beforeExecute?: () => void | Promise<void>;
  validateArguments?: (args: unknown) => void | Promise<void>;
  snapshotResult?: (result: AgentToolResult<unknown>) => unknown;
  applyMiddleware: (event: AgentToolResultMiddlewareEvent) => Promise<AgentToolResult<unknown>>;
  onExecutionResult?: (execution: AgentHarnessToolExecution) => void;
  onResult: (result: AgentHarnessToolPresentation) => TResult | Promise<TResult>;
  onError: (failure: AgentHarnessToolInvocationFailure) => TResult | Promise<TResult>;
}): Promise<TResult> {
  const startedAt = Date.now();
  const boundary = params.boundaries.begin({
    toolCallId: params.call.toolCallId,
    runId: params.runId,
    arguments: asNonArrayRecord(params.call.arguments),
    retainAfterCompletion: params.retainExecutionSnapshot,
  });
  let rawResult: AgentToolResult<unknown> | undefined;
  try {
    // Compatibility preparation receives native bytes before record coercion.
    const tool = params.tool;
    if (!tool) {
      throw new Error(
        params.unavailableToolMessage ?? `OpenClaw tool is unavailable: ${params.call.toolName}`,
      );
    }
    const prepare = tool.prepareArguments;
    const toolArgs = prepare
      ? Reflect.apply(prepare, tool, [params.call.arguments])
      : params.call.arguments;
    const preparedArgs = params.prepareArguments
      ? await params.prepareArguments(toolArgs)
      : toolArgs;
    boundary.setArguments(
      isRecord(preparedArgs) ? preparedArgs : asNonArrayRecord(params.call.arguments),
    );
    await params.beforeExecute?.();
    const execute = () => {
      params.assertCurrent?.();
      boundary.markDispatched();
      return tool.execute(params.call.toolCallId, preparedArgs, params.signal);
    };
    rawResult = params.validateArguments
      ? await runWithToolExecutionValidation(
          params.call.toolCallId,
          params.validateArguments,
          execute,
        )
      : await execute();
    boundary.capture();
    const execution: AgentHarnessToolExecution = {
      boundary,
      startedAt,
      executedArguments: boundary.executedArguments,
      rawResult,
      rawResultSnapshot: params.snapshotResult ? params.snapshotResult(rawResult) : rawResult,
      rawIsError: isToolResultError(rawResult),
      rawFailureKind: resolveToolResultFailureKind(rawResult),
    };
    params.onExecutionResult?.(execution);
    const result = await params.applyMiddleware({
      threadId: params.call.threadId,
      turnId: params.call.turnId,
      toolCallId: params.call.toolCallId,
      toolName: params.call.toolName,
      args: structuredClone(execution.executedArguments),
      cwd: params.call.cwd,
      isError: execution.rawIsError,
      result: rawResult,
    });
    const presentation = resolveAgentHarnessToolResultPresentation({
      result,
      executionIsError: execution.rawIsError,
      executionFailureKind: execution.rawFailureKind,
    });
    return await params.onResult({
      ...execution,
      result,
      observerResult: presentation.result,
      isError: presentation.isError,
      failureKind: presentation.failureKind,
    });
  } catch (error) {
    // Presentation can fail after dispatch; execution evidence remains monotonic.
    boundary.capture({ noStart: consumeTrustedToolNoStartError(error) });
    return await params.onError({
      error,
      boundary,
      startedAt,
      executedArguments: boundary.executedArguments,
      rawResult,
    });
  } finally {
    boundary.dispose();
  }
}

type AgentHarnessToolCall = {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  threadId?: string;
  turnId?: string;
  cwd?: string;
};

type AgentHarnessToolExecution = {
  boundary: ReturnType<ReturnType<typeof createAgentHarnessToolExecutionBoundaryRegistry>["begin"]>;
  startedAt: number;
  executedArguments: Record<string, unknown>;
  rawResult: AgentToolResult<unknown>;
  rawResultSnapshot: unknown;
  rawIsError: boolean;
  rawFailureKind: ReturnType<typeof resolveToolResultFailureKind>;
};

type AgentHarnessToolPresentation = AgentHarnessToolExecution & {
  result: AgentToolResult<unknown>;
  observerResult: AgentToolResult<unknown>;
  isError: boolean;
  failureKind: ReturnType<typeof resolveToolResultFailureKind>;
};

type AgentHarnessToolInvocationFailure = {
  error: unknown;
  boundary: AgentHarnessToolExecution["boundary"];
  startedAt: number;
  executedArguments: Record<string, unknown>;
  rawResult: AgentToolResult<unknown> | undefined;
};
