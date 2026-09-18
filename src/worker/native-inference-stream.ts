import { appendTextDeltaToAssistantMessage } from "../../packages/agent-core/src/agent-stream-response.js";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStreamLike,
} from "../llm/types.js";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import type { NativeRuntimeResolved } from "./native-runtime.js";

function stringValues(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return value !== null && typeof value === "object"
    ? Object.values(value).map(stringValues).join("")
    : "";
}
function generatedText(message: AssistantMessage): string {
  return message.content
    .map((block) =>
      block.type === "text"
        ? block.text
        : block.type === "thinking"
          ? block.thinking
          : stringValues(block.arguments),
    )
    .join("");
}

/** Guard provider output before the shared loop can publish it or execute generated tools. */
export function createNativeInferenceStreamGuard(native: NativeRuntimeResolved) {
  let completedText = "";
  return (
    start: () => AssistantMessageEventStreamLike | Promise<AssistantMessageEventStreamLike>,
    signal?: AbortSignal,
  ): AssistantMessageEventStreamLike => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let pending: AssistantMessageEvent[] = [];
      let bytes = 0;
      let currentMessage: AssistantMessage | undefined;
      try {
        const source = await start();
        for await (const raw of source) {
          signal?.throwIfAborted();
          const event = structuredClone(raw);
          const snapshot =
            event.type === "done"
              ? event.message
              : event.type === "error"
                ? event.error
                : event.partial;
          currentMessage =
            snapshot ??
            (event.type === "text_delta" && currentMessage
              ? appendTextDeltaToAssistantMessage(currentMessage, event.contentIndex, event.delta)
              : undefined);
          if (!currentMessage) {
            throw new Error("Native stream delta has no message owner");
          }
          native.assertProtocolSafe(event);
          const text = completedText + generatedText(currentMessage);
          native.assertProtocolSafe(text);
          if (event.type !== "done" && event.type !== "error" && native.hasCredentialPrefix(text)) {
            bytes += Buffer.byteLength(JSON.stringify(event));
            if (bytes > WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES) {
              throw new Error("Native credential-prefix buffer exceeded");
            }
            pending.push(event);
            continue;
          }
          if (event.type === "error" && pending.length) {
            throw new Error("Native stream failed with an unresolved credential prefix");
          }
          for (const held of pending) {
            output.push(held);
          }
          pending = [];
          bytes = 0;
          output.push(event);
          if (event.type === "done") {
            completedText = text;
          }
        }
        await source.result();
        if (pending.length) {
          throw new Error("Native stream ended with an unresolved credential prefix");
        }
      } catch {
        // Provider exceptions can contain headers/keys. Keep failures fixed and credential-free.
        const aborted = signal?.aborted === true;
        output.push({
          type: "error",
          reason: aborted ? "aborted" : "error",
          error: {
            role: "assistant",
            content: [],
            provider: native.model.provider,
            model: native.model.id,
            api: native.model.api,
            timestamp: Date.now(),
            stopReason: aborted ? "aborted" : "error",
            errorMessage: aborted
              ? "Runtime-local inference cancelled"
              : "Runtime-local inference failed its output boundary",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        });
      } finally {
        output.end();
      }
    })();
    return output;
  };
}
