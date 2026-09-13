import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const MAX_TRANSCRIPT_ITEM_BYTES = 4 * 1024 * 1024;
const MAX_TRANSCRIPT_TEXT_LENGTH = 1_000_000;

export type ClaudeTranscriptItem = {
  type: string;
  text?: string;
  content?: unknown;
  timestamp?: string;
  model?: string;
  uuid?: string;
  resumeCursor?: string;
  truncated?: true;
  /** Tool identity lifted out of the native blocks so an imported call renders
      as a native tool card; a call and its result share `toolCallId`. */
  toolName?: string;
  toolCallId?: string;
  toolInput?: unknown;
  isError?: boolean;
};

/** Claude reports a turn's calls and results as content blocks; the first block
    of each kind owns the identity the import pairs a card on. */
function toolIdentity(type: string, content: unknown): Partial<ClaudeTranscriptItem> {
  if (!Array.isArray(content)) {
    return {};
  }
  if (type === "toolCall") {
    const block = content.find((entry) => isRecord(entry) && entry.type === "tool_use");
    if (!isRecord(block) || typeof block.name !== "string") {
      return {};
    }
    return {
      toolName: block.name,
      ...(typeof block.id === "string" ? { toolCallId: block.id } : {}),
      ...(block.input !== undefined ? { toolInput: block.input } : {}),
    };
  }
  if (type === "toolResult") {
    const block = content.find((entry) => isRecord(entry) && entry.type === "tool_result");
    if (!isRecord(block)) {
      return {};
    }
    return {
      toolName: "tool",
      ...(typeof block.tool_use_id === "string" ? { toolCallId: block.tool_use_id } : {}),
      ...(content.some((entry) => isRecord(entry) && entry.is_error === true)
        ? { isError: true }
        : {}),
    };
  }
  return {};
}

function transcriptItemType(role: string, content: unknown): string {
  if (!Array.isArray(content)) {
    return role === "user" ? "userMessage" : "agentMessage";
  }
  const types = content.flatMap((block) =>
    isRecord(block) && typeof block.type === "string" ? [block.type] : [],
  );
  if (types.length > 0 && types.every((type) => type === "tool_result")) {
    return "toolResult";
  }
  if (types.length > 0 && types.every((type) => type === "tool_use")) {
    return "toolCall";
  }
  if (types.length > 0 && types.every((type) => type === "thinking")) {
    return "reasoning";
  }
  return role === "user" ? "userMessage" : "agentMessage";
}

export function collectTranscriptText(value: unknown, fragments: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) {
      fragments.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectTranscriptText(item, fragments);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of ["text", "thinking", "content", "input"]) {
    if (key in value) {
      collectTranscriptText(value[key], fragments);
    }
  }
}

export function parseTranscriptLine(
  line: Buffer,
  optionalString: (value: unknown, maxLength: number) => string | undefined,
): ClaudeTranscriptItem | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(line.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.isSidechain === true || raw.isMeta === true || !isRecord(raw.message)) {
    return undefined;
  }
  const role = raw.message.role;
  if ((role !== "user" && role !== "assistant") || raw.type !== role) {
    return undefined;
  }
  const content = raw.message.content;
  if (typeof content !== "string" && !Array.isArray(content)) {
    return undefined;
  }
  const fragments: string[] = [];
  collectTranscriptText(content, fragments);
  const text = [...new Set(fragments)].join("\n\n");
  const itemType = transcriptItemType(role, content);
  const item: ClaudeTranscriptItem = {
    type: itemType,
    ...(text ? { text } : {}),
    ...toolIdentity(itemType, content),
    content,
    ...(optionalString(raw.timestamp, 128)
      ? { timestamp: optionalString(raw.timestamp, 128) }
      : {}),
    ...(optionalString(raw.message.model, 256)
      ? { model: optionalString(raw.message.model, 256) }
      : {}),
    ...(optionalString(raw.uuid, 256) ? { uuid: optionalString(raw.uuid, 256) } : {}),
  };
  if (Buffer.byteLength(JSON.stringify(item), "utf8") <= MAX_TRANSCRIPT_ITEM_BYTES) {
    return item;
  }
  return {
    type: item.type,
    text: `${truncateUtf16Safe(text, MAX_TRANSCRIPT_TEXT_LENGTH)}\n\n[oversized Claude item truncated]`,
    ...(item.timestamp ? { timestamp: item.timestamp } : {}),
    ...(item.model ? { model: item.model } : {}),
    ...(item.uuid ? { uuid: item.uuid } : {}),
    truncated: true,
  };
}
