import type { SessionCatalogTranscriptItem } from "openclaw/plugin-sdk/session-catalog";
import type { CodexThreadItem } from "./app-server/protocol.js";
import { projectCodexUserItemText } from "./app-server/transcript-history-projection.js";

const CODEX_MESSAGE_TYPES = new Map<string, SessionCatalogTranscriptItem["type"]>([
  ["userMessage", "userMessage"],
  ["agentMessage", "agentMessage"],
  ["reasoning", "reasoning"],
]);

const CODEX_TOOL_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]);

export function toGenericTranscriptItem(item: CodexThreadItem): SessionCatalogTranscriptItem {
  let type = CODEX_MESSAGE_TYPES.get(item.type);
  if (!type && CODEX_TOOL_TYPES.has(item.type)) {
    const hasResult = item.result !== undefined || Boolean(item.aggregatedOutput);
    type = hasResult ? "toolResult" : "toolCall";
  }
  type ??= "other";
  const fallback = item.title ?? item.name ?? item.tool ?? item.command ?? item.query ?? undefined;
  const resultText =
    item.aggregatedOutput ||
    (item.result === undefined ? undefined : JSON.stringify(item.result, null, 2));
  // File changes carry only a changes array; keep their edits visible.
  const changesText = Array.isArray(item.changes)
    ? item.changes.map((change) => `${change.kind}: ${change.path}`).join("\n") || undefined
    : undefined;
  const text =
    item.type === "userMessage"
      ? projectCodexUserItemText(item)
      : item.text || resultText || changesText || fallback;
  return {
    id: item.id,
    type,
    ...(text ? { text } : {}),
    ...(type === "toolCall" || type === "toolResult" ? toolIdentity(item, type) : {}),
    raw: item as SessionCatalogTranscriptItem["raw"],
  };
}

/** Codex splits a tool into a call and a result that share one item id, so that
    id pairs them into a single native card. Failure is a non-zero exit code or
    an explicit error. */
function toolIdentity(
  item: CodexThreadItem,
  type: "toolCall" | "toolResult",
): Partial<SessionCatalogTranscriptItem> {
  const toolName =
    item.type === "commandExecution"
      ? "shell"
      : item.type === "fileChange"
        ? "apply_patch"
        : (item.tool ?? item.name ?? item.type);
  const failed =
    item.error !== undefined ||
    (typeof item.exitCode === "number" && item.exitCode !== 0) ||
    item.status === "failed";
  return {
    toolName,
    toolCallId: item.id,
    ...(type === "toolCall" ? { toolInput: toolInputOf(item) } : {}),
    ...(type === "toolResult" && typeof item.exitCode === "number"
      ? { exitCode: item.exitCode }
      : {}),
    ...(type === "toolResult" && failed ? { isError: true } : {}),
  };
}

function toolInputOf(item: CodexThreadItem): SessionCatalogTranscriptItem["toolInput"] {
  if (item.type === "commandExecution") {
    return {
      command: item.command ?? "",
      ...(item.cwd ? { cwd: item.cwd } : {}),
    };
  }
  if (item.type === "fileChange") {
    return { changes: Array.isArray(item.changes) ? item.changes : [] };
  }
  return item.arguments ?? {};
}
