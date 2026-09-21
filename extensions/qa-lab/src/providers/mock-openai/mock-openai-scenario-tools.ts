// Adapts scenario tool calls and results to the declared provider transport.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResponsesInputItem, StreamEvent } from "./mock-openai-contracts.js";
import {
  findNamedToolDefinition,
  hasDeferredToolDefinition,
  hasToolDefinition,
} from "./mock-openai-directives.js";
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
    if (!isRecord(parsed)) {
      return null;
    }
    if (typeof parsed.name !== "string" || !isRecord(parsed.args)) {
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
  return properties !== null &&
    typeof properties === "object" &&
    !Array.isArray(properties) &&
    Object.hasOwn(properties, "code") &&
    Array.isArray(required) &&
    required.includes("code")
    ? "guest"
    : null;
}

export function hasCodeModeExecSurface(body: Record<string, unknown>) {
  return resolveCodeModeExecSurface(body) !== null;
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

export function readDeferredToolCall(args: Record<string, unknown> | null | undefined) {
  return typeof args?.id === "string" && (args.args === undefined || isRecord(args.args))
    ? { name: args.id, args: isRecord(args.args) ? args.args : {} }
    : null;
}

export function extractScenarioToolOutput(input: ResponsesInputItem[]) {
  const output = extractToolOutput(input);
  const call = findToolCallByCallId(input, extractToolOutputCallId(input));
  if (call?.name !== "tool_call") {
    return output;
  }
  const target = readDeferredToolCall(parseToolCallArguments(call));
  const envelope = parseToolOutputJson(output);
  if (
    !target ||
    !envelope ||
    !isRecord(envelope.tool) ||
    (envelope.tool.id !== target.name && envelope.tool.name !== target.name) ||
    !isRecord(envelope.result)
  ) {
    return output;
  }
  const result = envelope.result;
  return Object.hasOwn(result, "details")
    ? stringifyScenarioToolOutput(result.details)
    : extractToolOutput([{ type: "function_call_output", output: result.content }]);
}

export function buildScenarioToolCallEvents(
  body: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>,
): StreamEvent[] {
  if (!hasToolDefinition(body, name) && hasDeferredToolDefinition(body, name)) {
    return buildScenarioToolCallEvents(body, "tool_call", { id: name, args });
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

export function extractScenarioPlannedTool(events: StreamEvent[]) {
  const wireName = extractPlannedToolName(events);
  const wireArgs = extractPlannedToolArgs(events);
  if (wireName === "tool_call") {
    const target = readDeferredToolCall(wireArgs);
    if (target) {
      return { ...target, wireName };
    }
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
