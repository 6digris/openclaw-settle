import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { buildOpenAIResponsesParams } from "./openai-responses-params-internal.js";
import {
  convertProviderResponsesMessages,
  createOpenAIResponsesAssistantOutput,
} from "./openai-responses-replay-messages-internal.js";

const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

function completedToolHistory(names: string[]): Context {
  return {
    messages: names.flatMap((name, index) => {
      const callId = `call_${index}`;
      const assistant: AssistantMessage = {
        ...createOpenAIResponsesAssistantOutput(model),
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: callId, name, arguments: { query: "test" } }],
      };
      return [assistant, makeTextToolResult(callId, name, "found", false, index + 1)];
    }),
  };
}

describe.each([
  {
    route: "ChatGPT Responses transport",
    buildInput: (context: Context) => buildOpenAIResponsesParams(model, context, undefined).input,
  },
  {
    route: "OpenAI Responses transport",
    buildInput: (context: Context) =>
      buildOpenAIResponsesParams(
        { ...model, api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
        context,
        undefined,
      ).input,
  },
  {
    route: "Responses provider adapter",
    buildInput: (context: Context) =>
      convertProviderResponsesMessages(model, context, new Set(["openai"])),
  },
])("$route historical tool names", ({ buildInput }) => {
  it("replays a completed qualified MCP call with a valid wire name and its original result", () => {
    const context = completedToolHistory(["sentry.search_issues"]);
    const original = structuredClone(context);
    const input = buildInput(context);

    expect(input).toEqual([
      {
        type: "function_call",
        call_id: "call_0",
        name: expect.stringMatching(/^[a-zA-Z0-9_-]{1,64}$/),
        arguments: '{"query":"test"}',
      },
      { type: "function_call_output", call_id: "call_0", output: "found" },
    ]);
    expect(context).toEqual(original);
  });

  it("preserves valid names and keeps punctuation variants distinct across replay windows", () => {
    const validNames = ["sentry_search_issues", "lookup-Weather_2", "a".repeat(128)];
    const names = [...validNames, "sentry.search_issues", "sentry:search_issues"];
    const context = completedToolHistory(names);
    const original = structuredClone(context);
    const input = buildInput(context);
    const calls = input.filter((item) => item.type === "function_call");
    const wireNames = calls.map((call) => call.name);

    expect(wireNames.slice(0, validNames.length)).toEqual(validNames);
    expect(new Set(wireNames).size).toBe(names.length);
    for (const [index, name] of names.entries()) {
      const wireName = wireNames[index];
      expect(wireName).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(buildInput(completedToolHistory([name]))[0]).toMatchObject({
        name: wireName,
      });
    }
    expect(input.filter((item) => item.type === "function_call_output")).toEqual(
      names.map((_, index) => ({
        type: "function_call_output",
        call_id: `call_${index}`,
        output: "found",
      })),
    );
    expect(context).toEqual(original);
  });

  it("bounds encoded names without collapsing long names with a shared prefix", () => {
    const input = buildInput(
      completedToolHistory(["", "tools.查找", `${"a".repeat(64)}.one`, `${"a".repeat(64)}.two`]),
    );
    const names = input.filter((item) => item.type === "function_call").map((call) => call.name);
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });
});
