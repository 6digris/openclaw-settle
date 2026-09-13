import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { parseDateStringTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { withSessionTranscriptWriteLock } from "openclaw/plugin-sdk/session-transcript-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";
import type { ClaudeTranscriptItem } from "./session-catalog-transcript.js";

function importedClaudeMessage(
  item: ClaudeTranscriptItem,
  fallbackTimestamp: number,
): AgentMessage | undefined {
  const timestamp = parseDateStringTimestampMs(item.timestamp) ?? fallbackTimestamp;
  const importedText = item.text?.trim();
  if (!importedText && item.type === "reasoning") {
    return undefined;
  }
  const text = importedText || "[Unsupported Claude transcript item]";
  if (item.type === "userMessage") {
    // Imported native rows are not OpenClaw-authored; mirrorOrigin excludes them
    // from self-echo provenance so a repeated native prompt stays observable.
    return {
      role: "user",
      content: text,
      timestamp,
      __openclaw: { mirrorOrigin: "claude-catalog-import" },
    } as AgentMessage;
  }
  // Native blocks, not labelled prose: Control UI builds tool cards, call/result
  // pairing, and reasoning disclosures from message and block shape. Rows whose
  // native identity could not be read keep the labelled form.
  if (item.type === "toolResult" && item.toolCallId) {
    return {
      role: "toolResult",
      toolCallId: item.toolCallId,
      toolName: item.toolName ?? "tool",
      content: [{ type: "text", text }],
      isError: item.isError === true,
      timestamp,
    };
  }
  const prefix =
    item.type === "toolCall" && !item.toolName
      ? "Tool call\n\n"
      : item.type === "toolResult"
        ? "Tool result\n\n"
        : "";
  const content =
    item.type === "reasoning"
      ? [{ type: "thinking" as const, thinking: text }]
      : item.type === "toolCall" && item.toolName
        ? [
            {
              type: "toolCall" as const,
              id: item.toolCallId ?? `claude:${item.uuid ?? timestamp}`,
              name: item.toolName,
              arguments: isRecord(item.toolInput) ? item.toolInput : {},
            },
          ]
        : [{ type: "text" as const, text: `${prefix}${text}` }];
  return {
    role: "assistant",
    content,
    timestamp,
    api: "anthropic-messages",
    provider: CLAUDE_CLI_BACKEND_ID,
    model: "native-history",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
  } as AgentMessage;
}

export async function importClaudeHistory(params: {
  items: ClaudeTranscriptItem[];
  threadId: string;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  storePath: string;
  cwd?: string;
  config: OpenClawConfig;
}): Promise<void> {
  const items = params.items.toReversed();
  await withSessionTranscriptWriteLock(params, async (transcript) => {
    for (const [index, item] of items.entries()) {
      const imported = importedClaudeMessage(item, Date.now() + index);
      if (!imported) {
        continue;
      }
      // The idempotency key rides on the message so recovery re-imports dedupe.
      const message: AgentMessage & { idempotencyKey: string } = {
        ...imported,
        idempotencyKey: `claude-catalog:${params.threadId}:${item.uuid ?? index}`,
      };
      await transcript.appendMessage({
        message,
        idempotencyLookup: "scan",
        cwd: params.cwd,
      });
    }
  });
}
