import type { DebugProxyCaptureReader } from "openclaw/plugin-sdk/proxy-capture";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type ProviderBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ProviderToolResult = { id: string; isError: boolean; text: string; textParts?: number };
export type ProviderMessage = {
  model: string;
  text: string;
  blocks: ProviderBlock[];
  stopReason: string;
  toolResults: ProviderToolResult[];
  maxTokens: number;
  outputTokens: number;
  request?: {
    eventId: number;
    sameRequestAsPrevious?: boolean;
    sameResponseIdAsPrevious?: boolean;
    messageCount: number;
    toolCount: number;
    lastRole: "user" | "assistant" | "other";
    lastUserText: string;
  };
};
export const MODEL = "claude-opus-4-8";
const OBSERVATION_LIMIT = 5000;

export function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("Slack delivery proof received an incomplete capture object");
  }
  return value;
}

function completePayload(store: DebugProxyCaptureReader, event: Record<string, unknown>) {
  if (typeof event.metaJson === "string") {
    const meta = object(JSON.parse(event.metaJson));
    if (meta.captureTruncated === true || meta.bodyCapture !== undefined) {
      throw new Error("Slack delivery proof provider capture is incomplete");
    }
  }
  const payload =
    typeof event.dataBlobId === "string" && event.dataBlobId
      ? store.readBlob(event.dataBlobId)
      : event.dataText;
  if (typeof payload !== "string") {
    throw new Error("Slack delivery proof provider capture body is missing");
  }
  return payload;
}

export function readSlackDeliveryProviderMessages(params: {
  store: DebugProxyCaptureReader;
  sessionId: string;
  cursor: number;
  fixtureMarker: string;
}): ProviderMessage[] {
  const events = params.store.getSessionEvents(params.sessionId, OBSERVATION_LIMIT);
  if (events.length >= OBSERVATION_LIMIT) {
    throw new Error("Slack delivery proof capture window is incomplete");
  }
  const relevant = events.filter(
    (event) =>
      typeof event.id === "number" &&
      event.id > params.cursor &&
      event.host === "api.anthropic.com" &&
      typeof event.path === "string" &&
      event.path.split("?")[0] === "/v1/messages",
  );
  if (relevant.some((event) => event.kind === "error")) {
    throw new Error("Slack delivery proof provider transport failed");
  }
  let previousRequest: string | undefined;
  let previousResponseId: string | undefined;
  return relevant
    .filter((event) => event.kind === "request")
    .toSorted((a, b) => Number(a.id) - Number(b.id))
    .map((request, requestIndex, requests) => {
      const response = relevant.find(
        (event) => event.kind === "response" && event.flowId === request.flowId,
      );
      if (!response || response.status !== 200 || typeof request.flowId !== "string") {
        throw new Error("Slack delivery proof provider acknowledgement is missing");
      }
      const requestText = completePayload(params.store, request);
      const body = object(JSON.parse(requestText));
      if (
        body.model !== MODEL ||
        !Array.isArray(body.messages) ||
        typeof body.max_tokens !== "number" ||
        body.max_tokens > 2048
      ) {
        // This guard precedes normal observation projection. Retain only bounded
        // predicate facts and fixture correlation so failed capture remains diagnosable.
        const facts = {
          requestOrdinal: requestIndex + 1,
          capturedRequests: requests.length,
          responseCorrelated: true,
          responseStatus: response.status,
          modelMatches: body.model === MODEL,
          modelType: typeof body.model,
          messagesArray: Array.isArray(body.messages),
          maxTokensType: typeof body.max_tokens,
          maxTokensValue:
            typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens)
              ? body.max_tokens
              : null,
          maxTokensWithinBound: typeof body.max_tokens === "number" && body.max_tokens <= 2048,
          maxTokensLimit: 2048,
          fixtureUserTextMatches:
            params.fixtureMarker.length > 0 &&
            Array.isArray(body.messages) &&
            body.messages.some(
              (entry) =>
                isRecord(entry) &&
                entry.role === "user" &&
                (typeof entry.content === "string"
                  ? entry.content.includes(params.fixtureMarker)
                  : Array.isArray(entry.content) &&
                    entry.content.some(
                      (block) =>
                        isRecord(block) &&
                        block.type === "text" &&
                        typeof block.text === "string" &&
                        block.text.includes(params.fixtureMarker),
                    )),
            ),
        };
        throw new Error(
          `Slack delivery proof provider identity or token bound differs from the scenario; providerRequest=${JSON.stringify(facts)}`,
        );
      }
      const frames = completePayload(params.store, response)
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data: "))
        .map((line) => object(JSON.parse(line.slice(6))));
      const start = frames.find((event) => event.type === "message_start");
      const message = object(start?.message);
      if (
        message.model !== MODEL ||
        frames.at(-1)?.type !== "message_stop" ||
        frames.some((event) => event.type === "error")
      ) {
        throw new Error(
          "Slack delivery proof provider stream did not complete on the selected model",
        );
      }
      // Anthropic indexes blocks in wire order. Require complete, non-overlapping
      // blocks so aggregating text cannot hide narration emitted after a tool call.
      const blocks: ProviderBlock[] = [];
      let openIndex: number | undefined;
      let partialInput = "";
      for (const frame of frames) {
        if (frame.type === "content_block_start") {
          if (openIndex !== undefined || frame.index !== blocks.length) {
            throw new Error("Slack delivery proof provider block order is incomplete");
          }
          const block = object(frame.content_block);
          if (block.type === "text" && typeof block.text === "string") {
            blocks.push({ type: "text", text: block.text });
          } else if (
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
          ) {
            blocks.push({
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: object(block.input),
            });
          } else {
            throw new Error("Slack delivery proof provider returned an unexpected content block");
          }
          openIndex = blocks.length - 1;
          partialInput = "";
        } else if (frame.type === "content_block_delta" || frame.type === "content_block_stop") {
          if (openIndex === undefined || frame.index !== openIndex) {
            throw new Error("Slack delivery proof provider block boundary is missing");
          }
          const block = blocks[openIndex]!;
          if (frame.type === "content_block_stop") {
            if (block.type === "tool_use" && partialInput) {
              block.input = object(JSON.parse(partialInput));
            }
            openIndex = undefined;
          } else {
            const delta = object(frame.delta);
            if (
              block.type === "text" &&
              delta.type === "text_delta" &&
              typeof delta.text === "string"
            ) {
              block.text += delta.text;
            } else if (
              block.type === "tool_use" &&
              delta.type === "input_json_delta" &&
              typeof delta.partial_json === "string"
            ) {
              partialInput += delta.partial_json;
            } else {
              throw new Error("Slack delivery proof provider block delta is unexpected");
            }
          }
        }
      }
      if (openIndex !== undefined) {
        throw new Error("Slack delivery proof provider block did not complete");
      }
      const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      const terminal = frames.findLast((event) => event.type === "message_delta");
      const stopReason = object(terminal?.delta).stop_reason;
      const outputTokens = object(terminal?.usage).output_tokens;
      const toolResults = body.messages
        .flatMap((value) => {
          const entry = object(value);
          return entry.role === "user" && Array.isArray(entry.content) ? entry.content : [];
        })
        .filter((value) => object(value).type === "tool_result")
        .map((value) => {
          const result = object(value);
          if (typeof result.tool_use_id !== "string") {
            throw new Error("Slack delivery proof tool result identity is missing");
          }
          const content =
            typeof result.content === "string"
              ? result.content
              : Array.isArray(result.content)
                ? result.content
                    .map((part) => {
                      const block = object(part);
                      if (block.type !== "text" || typeof block.text !== "string") {
                        throw new Error("Slack delivery proof tool result is not text");
                      }
                      return block.text;
                    })
                    .join("\n")
                : "";
          return {
            id: result.tool_use_id,
            isError: result.is_error === true,
            text: content,
            textParts: Array.isArray(result.content) ? result.content.length : 1,
          };
        });
      if (typeof stopReason !== "string" || typeof outputTokens !== "number") {
        throw new Error("Slack delivery proof provider terminal metadata is missing");
      }
      const sameRequestAsPrevious =
        previousRequest === undefined ? undefined : requestText === previousRequest;
      const sameResponseIdAsPrevious =
        previousResponseId === undefined || typeof message.id !== "string"
          ? undefined
          : message.id === previousResponseId;
      previousRequest = requestText;
      previousResponseId = typeof message.id === "string" ? message.id : undefined;
      return {
        model: MODEL,
        text,
        blocks,
        stopReason,
        toolResults,
        maxTokens: body.max_tokens,
        outputTokens,
        request: {
          eventId: Number(request.id),
          sameRequestAsPrevious,
          sameResponseIdAsPrevious,
          messageCount: body.messages.length,
          toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
          lastRole:
            object(body.messages.at(-1) ?? {}).role === "user"
              ? "user"
              : object(body.messages.at(-1) ?? {}).role === "assistant"
                ? "assistant"
                : "other",
          // Keep only the final user request part for private failure diagnosis,
          // never system instructions, headers, or the full conversation.
          lastUserText: body.messages
            .filter((entry) => object(entry).role === "user")
            .slice(-1)
            .flatMap((entry) => {
              const content = object(entry).content;
              return typeof content === "string"
                ? [content]
                : Array.isArray(content)
                  ? content.flatMap((part) => {
                      const block = object(part);
                      return block.type === "text" && typeof block.text === "string"
                        ? [block.text]
                        : [];
                    })
                  : [];
            })
            .join("\n"),
        },
      };
    });
}
