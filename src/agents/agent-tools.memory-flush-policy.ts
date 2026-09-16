import { wrapToolMemoryFlushAppendOnlyWrite } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

const MEMORY_FLUSH_ALLOWED_TOOL_NAMES = new Set(["read", "write"]);

type MemoryFlushWriteOptions = Parameters<typeof wrapToolMemoryFlushAppendOnlyWrite>[1];

/** Restrict memory-flush turns to reads and the existing append-only write boundary. */
export function selectMemoryFlushTools(
  tools: AnyAgentTool[],
  writeOptions?: MemoryFlushWriteOptions,
): AnyAgentTool[] {
  if (!writeOptions) {
    return tools;
  }
  const selected: AnyAgentTool[] = [];
  for (const tool of tools) {
    if (!MEMORY_FLUSH_ALLOWED_TOOL_NAMES.has(tool.name)) {
      continue;
    }
    selected.push(
      tool.name === "write" ? wrapToolMemoryFlushAppendOnlyWrite(tool, writeOptions) : tool,
    );
  }
  return selected;
}
