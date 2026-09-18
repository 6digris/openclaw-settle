import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, Model } from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { createNativeInferenceStreamGuard } from "./native-inference-stream.js";
import type { NativeRuntimeResolved } from "./native-runtime.js";
const secret = "synthetic-sensitive-value";
const model: Model = {
  provider: "test",
  id: "test",
  name: "test",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  contextWindow: 8192,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function message(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
function native(): NativeRuntimeResolved {
  return {
    model,
    workspacePath: "/fixture",
    streamFn: () => {
      throw new Error("unused");
    },
    assertProtocolSafe: (value) => {
      if (JSON.stringify(value).includes(secret)) {
        throw new Error("credential reflection");
      }
    },
    hasCredentialPrefix: (value) =>
      typeof value === "string" &&
      Array.from({ length: secret.length - 1 }, (_, i) => secret.slice(0, i + 1)).some((prefix) =>
        value.endsWith(prefix),
      ),
  };
}
async function collect(stream: ReturnType<ReturnType<typeof createNativeInferenceStreamGuard>>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return { events, message: await stream.result() };
}
describe("worker native inference output owner", () => {
  it.each([false, true])(
    "sanitizes credential-bearing provider startup failure (async=%s)",
    async (asyncFailure) => {
      const guard = createNativeInferenceStreamGuard(native());
      const result = await collect(
        guard(() => {
          if (asyncFailure) {
            return Promise.reject(new Error(secret));
          }
          throw new Error(secret);
        }),
      );
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(result.message).toMatchObject({
        stopReason: "error",
        errorMessage: "Runtime-local inference failed its output boundary",
      });
    },
  );
  it.each(["id", "name"] as const)(
    "rejects a complete credential in tool-call %s metadata",
    async (field) => {
      const source = createAssistantMessageEventStream();
      const call = {
        type: "toolCall" as const,
        id: "call",
        name: "read",
        arguments: {},
        [field]: secret,
      };
      const final = message([call]);
      source.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: final });
      source.push({ type: "done", reason: "stop", message: final });
      source.end();
      const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
      expect(result.message.stopReason).toBe("error");
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );
  it("holds incomplete prefixes across tool blocks before any generated tool can escape", async () => {
    const source = createAssistantMessageEventStream();
    const prefix = secret.slice(0, 12),
      suffix = secret.slice(12);
    const call = {
      type: "toolCall" as const,
      id: "call",
      name: "write",
      arguments: { nested: [prefix] },
      async: true as const,
    };
    const partial = message([call]);
    source.push({ type: "start", partial: message([]) });
    source.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial });
    const final = message([call, { type: "text", text: suffix }]);
    source.push({ type: "text_start", contentIndex: 1, partial: final });
    source.push({ type: "done", reason: "stop", message: final });
    source.end();
    const result = await collect(createNativeInferenceStreamGuard(native())(() => source));
    expect(result.message.stopReason).toBe("error");
    expect(JSON.stringify(result.events)).not.toContain(prefix);
    expect(JSON.stringify(result.events)).not.toContain(suffix);
  });
  it("streams ordinary divergence before completion, including snapshot-free deltas", async () => {
    const source = createAssistantMessageEventStream();
    const result = createNativeInferenceStreamGuard(native())(() => source);
    const events: AssistantMessageEvent[] = [];
    const drain = (async () => {
      for await (const event of result) {
        events.push(event);
      }
    })();
    source.push({ type: "start", partial: message([]) });
    source.push({
      type: "text_start",
      contentIndex: 0,
      partial: message([{ type: "text", text: "" }]),
    });
    source.push({ type: "text_delta", contentIndex: 0, delta: "synthetic-" });
    source.push({ type: "text_delta", contentIndex: 0, delta: "ordinary text" });
    await vi.waitFor(() => expect(events.filter((e) => e.type === "text_delta")).toHaveLength(2));
    expect(events.some((e) => e.type === "done")).toBe(false);
    source.push({
      type: "done",
      reason: "stop",
      message: message([{ type: "text", text: "synthetic-ordinary text" }]),
    });
    source.end();
    await drain;
    expect((await result.result()).stopReason).toBe("stop");
  });
  it("blocks completing a credential literal across separate provider responses", async () => {
    const guard = createNativeInferenceStreamGuard(native());
    const first = createAssistantMessageEventStream();
    first.push({
      type: "done",
      reason: "stop",
      message: message([{ type: "text", text: secret.slice(0, 12) }]),
    });
    first.end();
    expect((await collect(guard(() => first))).message.stopReason).toBe("stop");
    const next = createAssistantMessageEventStream();
    next.push({
      type: "done",
      reason: "stop",
      message: message([{ type: "text", text: secret.slice(12) }]),
    });
    next.end();
    const result = await collect(guard(() => next));
    expect(result.message.stopReason).toBe("error");
    expect(JSON.stringify(result.events)).not.toContain(secret.slice(12));
  });
});
