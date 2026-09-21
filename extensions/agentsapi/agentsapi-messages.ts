import type {
  AgentHarnessAttemptParamsV2,
  AgentMessage,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  calculateCost,
  type AssistantMessage,
  type ToolResultMessage,
} from "openclaw/plugin-sdk/llm";
import { appendSessionTranscriptMessageByIdentityStrict } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  AgentsApiEvent,
  AgentsApiFunctionCall,
  AgentsApiItem,
  AgentsApiTurn,
} from "./agentsapi-client.js";

type AgentEvent = Parameters<NonNullable<AgentHarnessAttemptParamsV2["onAgentEvent"]>>[0];
type AgentsApiReply = { lastAssistant?: AssistantMessage; usage: AssistantMessage["usage"] };

export function createAgentsApiMessageProjection(
  remoteSessionId: string,
  emitEvent: (event: AgentEvent) => void | Promise<void>,
) {
  const reply: AgentsApiReply = { usage: emptyUsage() };
  const texts = new Map<string, Map<number, string>>();
  const assistantPhases = new Map<string, string | null | undefined>();
  let visibleAssistantItemId: string | undefined;
  const emitAssistantSnapshot = (itemId: string, text: string, delta = "") => {
    const replace = visibleAssistantItemId !== itemId;
    visibleAssistantItemId = itemId;
    // Steering can supersede a completed turn; append-only delivery waits for canonical items.
    void emitEvent({
      stream: "assistant",
      data: {
        itemId,
        text,
        delta: replace ? "" : delta,
        replaceable: true,
        ...(replace ? { replace: true } : {}),
      },
    });
  };
  const complete = (turnId: string, text: string): void => {
    emitAssistantSnapshot(`agentsapi:${remoteSessionId}:${turnId}:reply`, text);
  };
  return {
    reply,
    observe(event: AgentsApiEvent): void {
      if (event.item?.type === "message" && event.item.role === "assistant") {
        assistantPhases.set(event.item.id, event.item.phase);
        if (event.type === "agent.session.turn.item.done") {
          const parts = new Map<number, string>();
          event.item.content?.forEach((part, index) => {
            if (part.type === "output_text") {
              parts.set(index, part.text ?? "");
            }
          });
          texts.set(event.item.id, parts);
        }
        const parts = texts.get(event.item.id);
        if (event.item.phase !== "commentary" && parts) {
          emitAssistantSnapshot(
            `agentsapi:${remoteSessionId}:${event.item.id}`,
            joinTextParts(parts),
          );
        }
      }
      if (
        event.type === "agent.session.turn.output_text.delta" ||
        event.type === "agent.session.turn.output_text.done"
      ) {
        if (!event.item_id) {
          throw new Error("Agents API text event has no item identity");
        }
        const parts = texts.get(event.item_id) ?? new Map<number, string>();
        const index = event.content_index ?? 0;
        parts.set(
          index,
          event.type.endsWith(".done")
            ? (event.text ?? "")
            : (parts.get(index) ?? "") + (event.delta ?? ""),
        );
        texts.set(event.item_id, parts);
        if (
          assistantPhases.has(event.item_id) &&
          assistantPhases.get(event.item_id) !== "commentary"
        ) {
          emitAssistantSnapshot(
            `agentsapi:${remoteSessionId}:${event.item_id}`,
            joinTextParts(parts),
            event.delta ?? "",
          );
        }
      }
    },
    complete,
    commit(
      params: AgentHarnessAttemptParamsV2,
      turn: AgentsApiTurn | NonNullable<AgentsApiEvent["turn"]>,
      items: AgentsApiItem[],
      assertCurrent: () => void,
    ): Promise<void> {
      return commitAgentsApiReply(
        params,
        remoteSessionId,
        turn,
        items,
        assertCurrent,
        reply,
        complete,
      );
    },
  };
}

async function commitAgentsApiReply(
  params: AgentHarnessAttemptParamsV2,
  remoteSessionId: string,
  turn: AgentsApiTurn | NonNullable<AgentsApiEvent["turn"]>,
  items: AgentsApiItem[],
  assertCurrent: () => void,
  reply: AgentsApiReply,
  emitFinalReply: (turnId: string, text: string) => void | Promise<void>,
): Promise<void> {
  assertCurrent();
  const completedMessages = items.filter(
    (item) => item.type === "message" && item.role === "assistant" && item.status === "completed",
  );
  const finalItems = completedMessages.filter((item) => item.phase === "final_answer");
  const visibleItems = finalItems.length
    ? finalItems
    : completedMessages.filter((item) => item.phase !== "commentary");
  const text = visibleItems
    .map(
      (item) =>
        item.content
          ?.filter((part) => part.type === "output_text")
          .map((part) => part.text ?? "")
          .join("") ?? "",
    )
    .join("\n");
  let usage = emptyUsage();
  if (turn.usage) {
    usage = {
      ...usage,
      input: turn.usage.input_tokens - (turn.usage.input_tokens_details?.cached_tokens ?? 0),
      output: turn.usage.output_tokens,
      cacheRead: turn.usage.input_tokens_details?.cached_tokens ?? 0,
      totalTokens: turn.usage.input_tokens + turn.usage.output_tokens,
    };
  }
  reply.usage = usage;
  if (turn.usage) {
    params.hostCapabilities.reportOutputTokens?.(usage.output);
    calculateCost(params.model, usage);
  }
  if (text) {
    const assistant: AssistantMessage & { idempotencyKey: string } = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-responses",
      provider: "openai",
      model: params.model.id,
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
      idempotencyKey: `agentsapi:${remoteSessionId}:${turn.id}`,
    };
    reply.lastAssistant = await appendAgentsApiTranscriptMessage(params, assistant, assertCurrent);
    await params.onAssistantMessageStart?.();
  }
  assertCurrent();
  await emitFinalReply(turn.id, text);
  assertCurrent();
  if (text) {
    await params.onPartialReply?.({ text });
    assertCurrent();
  }
}

/** Persist host tool evidence before its result is acknowledged by the native session. */
export async function recordAgentsApiToolTranscript(
  params: AgentHarnessAttemptParamsV2,
  call: AgentsApiFunctionCall,
  result: Awaited<ReturnType<AnyAgentTool["execute"]>>,
  isError: boolean,
  assertCurrent: () => void,
): Promise<void> {
  const identity = `agentsapi:tool:${call.turn_id}:${call.call_id}`;
  const toolCall: AssistantMessage & { idempotencyKey: string } = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: call.call_id,
        name: call.name,
        arguments: asOptionalRecord(call.arguments) ?? {},
      },
    ],
    api: "openai-responses",
    provider: "openai",
    model: params.model.id,
    usage: emptyUsage(),
    stopReason: "toolUse",
    timestamp: Date.now(),
    idempotencyKey: `${identity}:call`,
  };
  const toolResult: ToolResultMessage & { idempotencyKey: string } = {
    role: "toolResult",
    toolCallId: call.call_id,
    toolName: call.name,
    content: result.content,
    details: result.details,
    isError,
    timestamp: Date.now(),
    idempotencyKey: `${identity}:result`,
  };
  await appendAgentsApiTranscriptMessage(params, toolCall, assertCurrent);
  await appendAgentsApiTranscriptMessage(params, toolResult, assertCurrent);
}

async function appendAgentsApiTranscriptMessage<TMessage extends AgentMessage>(
  params: AgentHarnessAttemptParamsV2,
  message: TMessage,
  assertCurrent: () => void,
): Promise<TMessage> {
  assertCurrent();
  const { agentId, sessionId, sessionKey, storePath } = params.sessionTarget ?? {};
  if (
    !agentId ||
    !sessionId ||
    !sessionKey ||
    !storePath ||
    sessionId !== params.sessionId ||
    agentId !== params.agentId ||
    sessionKey !== params.sessionKey
  ) {
    throw new Error("Agents API requires a matching host-prepared session target");
  }
  const append = await appendSessionTranscriptMessageByIdentityStrict({
    ...params.sessionTarget,
    agentId,
    sessionId,
    sessionKey,
    storePath,
    config: params.config,
    message,
    prepareMessageAfterIdempotencyCheck: (prepared) => {
      assertCurrent();
      return prepared;
    },
  });
  assertCurrent();
  if (append.kind !== "result") {
    throw new Error("Agents API transcript append was refused");
  }
  return append.result.message;
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function joinTextParts(parts: Map<number, string>): string {
  return [...parts.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, text]) => text)
    .join("");
}
