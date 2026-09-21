import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import { findNamedToolDefinition, hasToolDefinition } from "./mock-openai-directives.js";
import { extractPlannedToolArgs, extractPlannedToolName } from "./mock-openai-events.js";
import {
  extractToolOutput,
  extractToolOutputCallId,
  parseToolOutputJson,
} from "./mock-openai-input.js";
import {
  buildCustomToolCallEventsWithInput,
  buildToolCallEventsWithArgs as buildRawToolCallEventsWithArgs,
} from "./mock-openai-tooling.js";

export const QA_CODE_MODE_TARGET_MARKER = "qa-code-mode-target:";

export function stringifyScenarioToolOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function encodeCodeModeTarget(name: string, args: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ name, args }), "utf8").toString("base64url");
}

export function decodeCodeModeTarget(code: string | undefined) {
  const marker = code
    ?.split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(`// ${QA_CODE_MODE_TARGET_MARKER}`));
  if (!marker) {
    return null;
  }
  try {
    const encoded = marker.slice(`// ${QA_CODE_MODE_TARGET_MARKER}`.length).trim();
    const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!isRecord(parsed) || typeof parsed.name !== "string" || !isRecord(parsed.args)) {
      return null;
    }
    return {
      name: parsed.name,
      args: parsed.args,
    };
  } catch {
    return null;
  }
}

type CodeModeExecSurface = "native" | "guest";

export function resolveCodeModeExecSurface(
  body: Record<string, unknown>,
): CodeModeExecSurface | null {
  const tools = [
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...(Array.isArray(body.dynamicTools) ? body.dynamicTools : []),
  ];
  const execDefinition = findNamedToolDefinition(tools, "exec");
  if (!execDefinition || !hasToolDefinition(body, "wait")) {
    return null;
  }
  if (execDefinition.type === "custom") {
    return "native";
  }
  const schema = execDefinition.input_schema ?? execDefinition.parameters;
  if (!isRecord(schema)) {
    return null;
  }
  const properties = schema.properties;
  const required = schema.required;
  return isRecord(properties) &&
    Object.hasOwn(properties, "code") &&
    Array.isArray(required) &&
    required.includes("code")
    ? "guest"
    : null;
}

export function hasCodeModeExecSurface(body: Record<string, unknown>) {
  return resolveCodeModeExecSurface(body) !== null;
}

export function canPlanScenarioTool(body: Record<string, unknown>, name: string) {
  return (
    hasToolDefinition(body, name) ||
    hasCodeModeExecSurface(body) ||
    hasToolDefinition(body, "tool_search")
  );
}

function readSearchCandidates(output: string): Record<string, unknown>[] {
  const parsed: unknown = parseToolOutputJson(output);
  const candidates = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.results)
      ? parsed.results.flatMap((result) =>
          isRecord(result) && Array.isArray(result.candidates) ? result.candidates : [],
        )
      : [];
  return candidates.filter(isRecord);
}

export function readScenarioToolResult(input: ResponsesInputItem[]) {
  const call = findToolCallByCallId(input, extractToolOutputCallId(input));
  const raw = extractToolOutput(input);
  const wrapped = call?.name === "tool_call" ? parseToolOutputJson(raw) : null;
  if (isRecord(wrapped?.tool) && isRecord(wrapped.result)) {
    const result = wrapped.result;
    const output =
      result.details !== undefined
        ? stringifyScenarioToolOutput(result.details)
        : Array.isArray(result.content)
          ? result.content
              .filter(isRecord)
              .map((item) => (typeof item.text === "string" ? item.text : ""))
              .join("\n")
          : "";
    return { name: wrapped.tool.name, output, discovery: false };
  }
  return {
    name: call?.name,
    output: raw,
    discovery: call?.name === "tool_search" || call?.name === "tool_describe",
  };
}

export function resolveCurrentToolDeclarationSurface(
  body: Record<string, unknown>,
  input: ResponsesInputItem[],
) {
  const additionalTools = input.flatMap((item) =>
    item.type === "additional_tools" && item.role === "developer" && Array.isArray(item.tools)
      ? item.tools
      : [],
  );
  return additionalTools.length === 0
    ? body
    : {
        ...body,
        tools: [...(Array.isArray(body.tools) ? body.tools : []), ...additionalTools],
      };
}

export function findToolCallByCallId(input: ResponsesInputItem[], callId: string) {
  return input.toReversed().find((item) => {
    const type = item.type;
    return (type === "function_call" || type === "custom_tool_call") && item.call_id === callId;
  });
}

export function parseToolCallArguments(toolCall: ResponsesInputItem) {
  if (typeof toolCall.arguments !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(toolCall.arguments);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readGeneratedCodeModeExecSource(toolCall: ResponsesInputItem | undefined) {
  if (toolCall?.type === "custom_tool_call" && typeof toolCall.input === "string") {
    return toolCall.input;
  }
  const code = toolCall ? parseToolCallArguments(toolCall)?.code : undefined;
  return typeof code === "string" ? code : undefined;
}

function isGeneratedCodeModeExecCall(toolCall: ResponsesInputItem | undefined) {
  const source = toolCall?.name === "exec" ? readGeneratedCodeModeExecSource(toolCall) : undefined;
  return typeof source === "string" && decodeCodeModeTarget(source) !== null;
}

export function parseNativeCodeModeOutput(
  output: unknown,
): { status: "waiting"; cellId: string } | { status: "completed"; value: unknown } | null {
  if (!Array.isArray(output)) {
    return null;
  }
  const readText = (item: unknown) =>
    typeof item === "string"
      ? item
      : isRecord(item) && typeof item.text === "string"
        ? item.text
        : null;
  const statusText = readText(output[0]);
  if (!statusText) {
    return null;
  }
  const cellId = /^Script running with cell ID ([^\s\n]+)/u.exec(statusText)?.[1];
  if (cellId) {
    return { status: "waiting", cellId };
  }
  if (!statusText.startsWith("Script completed\n")) {
    return null;
  }
  for (const item of output.slice(1).toReversed()) {
    const text = readText(item);
    if (!text) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(text);
      return { status: "completed", value };
    } catch {
      // Native Code Mode may emit non-JSON content before the final value.
    }
  }
  return null;
}

export function isGeneratedCodeModeWaitCall(
  input: ResponsesInputItem[],
  toolCall: ResponsesInputItem,
) {
  if (toolCall.name !== "wait") {
    return false;
  }
  const args = parseToolCallArguments(toolCall);
  const waitId =
    typeof args?.cell_id === "string"
      ? args.cell_id
      : typeof args?.runId === "string"
        ? args.runId
        : undefined;
  if (!waitId) {
    return false;
  }
  return input.some((item) => {
    if (
      (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") ||
      typeof item.call_id !== "string"
    ) {
      return false;
    }
    const native = parseNativeCodeModeOutput(item.output);
    const parsed = native ?? parseToolOutputJson(stringifyScenarioToolOutput(item.output));
    return (
      parsed?.status === "waiting" &&
      (("cellId" in parsed && parsed.cellId === waitId) ||
        ("runId" in parsed && parsed.runId === waitId)) &&
      isGeneratedCodeModeExecCall(findToolCallByCallId(input, item.call_id))
    );
  });
}

export function isCodeModeControlToolOutput(
  body: Record<string, unknown>,
  input: ResponsesInputItem[],
) {
  if (!hasCodeModeExecSurface(body)) {
    return false;
  }
  const toolOutputCallId = extractToolOutputCallId(input);
  if (!toolOutputCallId) {
    return false;
  }
  const toolCall = findToolCallByCallId(input, toolOutputCallId);
  return (
    isGeneratedCodeModeExecCall(toolCall) ||
    (toolCall ? isGeneratedCodeModeWaitCall(input, toolCall) : false)
  );
}

export function buildScenarioToolCallEvents(
  body: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>,
  input: ResponsesInputItem[],
): StreamEvent[] {
  // Discovery can add a direct declaration or return an id for tool_call.
  // A catalog match alone is not a callable tool or a completed scenario action.
  if (
    !hasToolDefinition(body, name) &&
    !hasCodeModeExecSurface(body) &&
    hasToolDefinition(body, "tool_search")
  ) {
    const previous = findToolCallByCallId(input, extractToolOutputCallId(input));
    if (previous?.name === "tool_search") {
      const target = readSearchCandidates(extractToolOutput(input)).find(
        (candidate) => candidate.name === name && typeof candidate.id === "string",
      );
      if (!target) {
        throw new Error(`QA mock target tool unavailable after search: ${name}`);
      }
      if (!hasToolDefinition(body, "tool_call")) {
        throw new Error(`QA mock target tool has no declared dispatch surface: ${name}`);
      }
      return buildScenarioToolCallEvents(body, "tool_call", { id: target.id, args }, input);
    }
    return buildScenarioToolCallEvents(
      body,
      "tool_search",
      { queries: [{ query: name, limit: 1 }] },
      input,
    );
  }
  // Code Mode hides catalog capabilities behind exec/wait. Route through that
  // visible surface while retaining the nested capability as debug evidence.
  if (
    name === "exec" ||
    name === "wait" ||
    hasToolDefinition(body, name) ||
    !hasCodeModeExecSurface(body)
  ) {
    const declaration = [
      ...(Array.isArray(body.tools) ? body.tools : []),
      ...(Array.isArray(body.dynamicTools) ? body.dynamicTools : []),
    ].find((tool) => findNamedToolDefinition(tool, name));
    const definition = findNamedToolDefinition(declaration, name);
    // Function and custom calls both retain their declared namespace; Codex
    // dispatches the complete identity and rejects a flattened nested tool.
    const namespace =
      declaration &&
      typeof declaration === "object" &&
      declaration.type === "namespace" &&
      typeof declaration.name === "string"
        ? declaration.name
        : undefined;
    if (definition?.type === "custom" && typeof args.input === "string") {
      return buildCustomToolCallEventsWithInput(name, args.input, namespace);
    }
    return buildRawToolCallEventsWithArgs(name, args, namespace);
  }
  const encodedTarget = encodeCodeModeTarget(name, args);
  if (resolveCodeModeExecSurface(body) === "native") {
    return buildCustomToolCallEventsWithInput(
      "exec",
      [
        `// ${QA_CODE_MODE_TARGET_MARKER}${encodedTarget}`,
        `const targetName = ${JSON.stringify(name)};`,
        `const targetArgs = ${JSON.stringify(args)};`,
        "const target = ALL_TOOLS.find((entry) => entry.name === targetName);",
        "if (!target) throw new Error(`QA mock target tool unavailable: ${targetName}`);",
        "let value = await tools[target.name](targetArgs);",
        'if (targetName === "read" && value?.kind === "text" && typeof value.content === "string") {',
        "  value = { ...value, content: value.content.slice(0, 2048) };",
        "}",
        "text(JSON.stringify(value));",
      ].join("\n"),
    );
  }
  return buildRawToolCallEventsWithArgs("exec", {
    code: [
      `// ${QA_CODE_MODE_TARGET_MARKER}${encodedTarget}`,
      `const targetName = ${JSON.stringify(name)};`,
      `const targetArgs = ${JSON.stringify(args)};`,
      "const target = (await catalog.search(targetName)).find((entry) => entry.toolName === targetName);",
      "if (!target) throw new Error(`QA mock target tool unavailable: ${targetName}`);",
      "const value = await target(targetArgs);",
      'if (targetName === "read" && value?.kind === "text" && typeof value.content === "string") {',
      "  return { ...value, content: value.content.slice(0, 2048) };",
      "}",
      "return value;",
    ].join("\n"),
  });
}

export function extractScenarioPlannedTool(events: StreamEvent[], input: ResponsesInputItem[]) {
  const wireName = extractPlannedToolName(events);
  const wireArgs = extractPlannedToolArgs(events);
  if (wireName === "tool_call" && isRecord(wireArgs?.args)) {
    const target = readSearchCandidates(extractToolOutput(input)).find(
      (candidate) => candidate.id === wireArgs.id || candidate.name === wireArgs.id,
    );
    return {
      name:
        typeof target?.name === "string"
          ? target.name
          : typeof wireArgs.id === "string"
            ? wireArgs.id
            : undefined,
      args: wireArgs.args,
      wireName,
    };
  }
  const source =
    typeof wireArgs?.input === "string"
      ? wireArgs.input
      : typeof wireArgs?.code === "string"
        ? wireArgs.code
        : undefined;
  if (wireName !== "exec" || !source) {
    return { name: wireName, args: wireArgs, wireName };
  }
  const target = decodeCodeModeTarget(source);
  return target
    ? { name: target.name, args: target.args, wireName }
    : { name: wireName, args: wireArgs, wireName };
}
