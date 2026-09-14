import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createDebugProxyCaptureReader,
  type DebugProxyCaptureReader,
} from "openclaw/plugin-sdk/proxy-capture";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackQaScenarioEnvironment } from "./scenario-environment.js";
import { runSlackScenario } from "./scenario-runtime.js";
import {
  getSlackQaMessageWriteCursor,
  readSlackQaWriteTrace,
  type SlackQaWriteTrace,
} from "./slack-live.capture.js";
import type { SlackQaConfigOverrides } from "./slack-live.contracts.js";

type DeliveryMode = NonNullable<SlackQaConfigOverrides["delivery"]>;
type LogTail = {
  file: string;
  cursor: number;
  lines: string[];
  reset: boolean;
  truncated: boolean;
  skippedBytes?: number;
};
type ProviderBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
type ProviderToolResult = { id: string; isError: boolean; text: string };
type ProviderMessage = {
  model: string;
  text: string;
  blocks: ProviderBlock[];
  stopReason: string;
  toolResults: ProviderToolResult[];
  maxTokens: number;
  outputTokens: number;
};
const MODEL = "claude-opus-4-8";
const OBSERVATION_LIMIT = 5000;

function object(value: unknown): Record<string, unknown> {
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
  return relevant
    .filter((event) => event.kind === "request")
    .toSorted((a, b) => Number(a.id) - Number(b.id))
    .map((request) => {
      const response = relevant.find(
        (event) => event.kind === "response" && event.flowId === request.flowId,
      );
      if (!response || response.status !== 200 || typeof request.flowId !== "string") {
        throw new Error("Slack delivery proof provider acknowledgement is missing");
      }
      const body = object(JSON.parse(completePayload(params.store, request)));
      if (
        body.model !== MODEL ||
        !Array.isArray(body.messages) ||
        typeof body.max_tokens !== "number" ||
        body.max_tokens > 2048
      ) {
        throw new Error(
          "Slack delivery proof provider identity or token bound differs from the scenario",
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
          return { id: result.tool_use_id, isError: result.is_error === true, text: content };
        });
      if (typeof stopReason !== "string" || typeof outputTokens !== "number") {
        throw new Error("Slack delivery proof provider terminal metadata is missing");
      }
      return {
        model: MODEL,
        text,
        blocks,
        stopReason,
        toolResults,
        maxTokens: body.max_tokens,
        outputTokens,
      };
    });
}

export function verifySlackDeliveryObservations(params: {
  mode: DeliveryMode;
  preamble: string;
  final: string;
  privateFinal: string;
  channelId: string;
  finalMessageId: string;
  commands: [string, string];
  outputs: [string, string];
  retainedMessages: Array<{ ts: string; text: string }>;
  messages: ProviderMessage[];
  trace: SlackQaWriteTrace;
}) {
  const { messages, trace } = params;
  const expectedCalls = params.mode === "message-tool" ? 4 : 3;
  const tools = messages.map((message) =>
    message.blocks.filter((block) => block.type === "tool_use"),
  );
  const resultsCorrelated = messages.every((message, index) => {
    const priorTools = tools.slice(0, index).flat();
    return (
      message.toolResults.length === index &&
      priorTools.length === index &&
      message.toolResults.every(
        (result, resultIndex) =>
          result.id === priorTools[resultIndex]?.id &&
          !result.isError &&
          (resultIndex >= 2 || result.text.trim() === params.outputs[resultIndex]),
      )
    );
  });
  const orderedBlocks =
    messages[0]?.blocks.map((block) => block.type).join(",") === "text,tool_use" &&
    messages[1]?.blocks.map((block) => block.type).join(",") === "tool_use";
  const execCallsMatch = [0, 1].every(
    (index) =>
      tools[index]?.length === 1 &&
      tools[index]?.[0]?.name === "exec" &&
      tools[index]?.[0]?.input.command === params.commands[index],
  );
  const send = tools[2]?.[0];
  let sendResultMatches = false;
  if (params.mode === "message-tool") {
    try {
      const result = object(JSON.parse(messages[3]?.toolResults[2]?.text ?? ""));
      const sent = object(result.result);
      sendResultMatches =
        result.ok === true &&
        sent.channelId === params.channelId &&
        sent.messageId === params.finalMessageId;
    } catch {
      /* A missing or non-JSON result cannot establish an explicit send. */
    }
  }
  const shape =
    messages.length === expectedCalls &&
    resultsCorrelated &&
    orderedBlocks &&
    execCallsMatch &&
    messages[0]?.text === params.preamble &&
    messages[0]?.stopReason === "tool_use" &&
    messages[1]?.text === "" &&
    messages[1]?.stopReason === "tool_use" &&
    tools.at(-1)?.length === 0 &&
    messages.at(-1)?.stopReason === "end_turn" &&
    messages.at(-1)?.text ===
      (params.mode === "message-tool" ? params.privateFinal : params.final) &&
    (params.mode !== "message-tool" ||
      (tools[2]?.length === 1 &&
        send?.name === "message" &&
        send.input.action === "send" &&
        send.input.channel === "slack" &&
        send.input.target === `channel:${params.channelId}` &&
        send.input.message === params.final &&
        messages[2]?.text === "" &&
        messages[2]?.stopReason === "tool_use" &&
        sendResultMatches));
  const safeOtherMethods = new Set([
    "auth.test",
    "conversations.info",
    "conversations.history",
    "conversations.replies",
    "conversations.members",
    "users.info",
    "bots.info",
    "apps.connections.open",
    "reactions.add",
    "reactions.remove",
    "chat.delete",
  ]);
  const unexpected = trace.writes.filter(
    (write) => write.classification === "other" && !safeOtherMethods.has(write.method),
  );
  const replies = trace.writes.filter((write) => write.classification === "reply");
  const content = replies.flatMap((write) => write.content);
  const nativeText = new Map<string, string>();
  for (const write of replies) {
    if (
      write.status === "acknowledged" &&
      write.message &&
      ["chat.startStream", "chat.appendStream", "chat.stopStream"].includes(write.method)
    ) {
      const key = `${write.message.channelId}/${write.message.ts}`;
      // Native appends are serialized for one message. Status/block fields and
      // independent messages are not fragments of that message's markdown.
      const prior = write.method === "chat.startStream" ? "" : (nativeText.get(key) ?? "");
      nativeText.set(key, prior + (write.nativeMarkdown ?? ""));
    }
  }
  const visibleContent = [...content, ...nativeText.values()];
  const facts = {
    mode: params.mode,
    model: MODEL,
    providerShapeExercised: shape,
    provider: messages.map((message) => ({
      textChars: message.text.length,
      blocks: message.blocks.map((block) => block.type),
      tools: message.blocks.filter((block) => block.type === "tool_use").length,
      stopReason: message.stopReason,
      toolResults: message.toolResults.length,
      maxTokens: message.maxTokens,
      outputTokens: message.outputTokens,
    })),
    toolResultsCorrelated: resultsCorrelated,
    explicitSendCorrelated: params.mode === "message-tool" ? sendResultMatches : undefined,
    retainedMessages: params.retainedMessages.map((message) => ({
      finalIdentity: message.ts === params.finalMessageId,
      final: message.text.includes(params.final),
      preamble: message.text.includes(params.preamble),
      privateFinal: message.text.includes(params.privateFinal),
      textChars: message.text.length,
    })),
    captureComplete: trace.complete,
    captureIssues: trace.issues,
    unexpectedMethods: unexpected.map((write) => write.method),
    replyWrites: replies.map((write, index) => ({
      observation: index + 1,
      method: write.method,
      status: write.status,
      preamble: write.content.some((text) => text.includes(params.preamble)),
      final: write.content.some((text) => text.includes(params.final)),
      privateFinal: write.content.some((text) => text.includes(params.privateFinal)),
      contentChars: write.content.map((text) => text.length),
    })),
    nativeMessages: [...nativeText.values()].map((text) => ({
      preamble: text.includes(params.preamble),
      final: text.includes(params.final),
      privateFinal: text.includes(params.privateFinal),
      textChars: text.length,
    })),
    metadataWrites: trace.writes.filter((write) => write.classification === "metadata").length,
  };
  const details = JSON.stringify(facts);
  if (!shape) {
    throw new Error(`Slack delivery proof inconclusive: provider sequence unexercised; ${details}`);
  }
  const matchedFinal = replies.some(
    (write) =>
      write.status === "acknowledged" &&
      write.message?.channelId === params.channelId &&
      write.message.ts === params.finalMessageId &&
      (write.content.some((text) => text.includes(params.final)) ||
        nativeText.get(`${params.channelId}/${params.finalMessageId}`)?.includes(params.final)),
  );
  if (!trace.complete || unexpected.length > 0 || !matchedFinal) {
    throw new Error(`Slack delivery proof inconclusive: capture incomplete; ${details}`);
  }
  const retainedFinal = params.retainedMessages.find(
    (message) => message.ts === params.finalMessageId,
  );
  if (
    !retainedFinal?.text.includes(params.final) ||
    params.retainedMessages.some((message) => message.text.includes(params.privateFinal)) ||
    (params.mode !== "progress" &&
      (params.retainedMessages.length !== 1 || retainedFinal.text !== params.final)) ||
    !visibleContent.some((text) => text.includes(params.final)) ||
    visibleContent.some((text) => text.includes(params.privateFinal))
  ) {
    throw new Error(`Slack delivery proof failed: visible final policy; ${details}`);
  }
  if (
    params.mode !== "progress" &&
    (replies.length !== 1 || content.some((text) => text !== params.final))
  ) {
    throw new Error(`Slack delivery proof failed: intermediate reply content; ${details}`);
  }
  // Progress is an intentional status mode, not a claim that narration was never visible.
  if (
    params.mode === "progress" &&
    (!visibleContent.some((text) => text.includes(params.preamble)) ||
      !replies.some((write) => write.method === "chat.startStream") ||
      !replies.some((write) => write.method === "chat.stopStream"))
  ) {
    throw new Error(
      `Slack delivery proof inconclusive: progress presentation unexercised; ${details}`,
    );
  }
  return details;
}

async function tail(environment: SlackQaScenarioEnvironment, cursor?: number): Promise<LogTail> {
  const value = object(
    await environment.context.gateway.call("logs.tail", {
      ...(cursor === undefined ? {} : { cursor }),
      limit: 5000,
      maxBytes: 1_000_000,
    }),
  );
  if (
    typeof value.file !== "string" ||
    typeof value.cursor !== "number" ||
    !Array.isArray(value.lines) ||
    value.lines.some((line) => typeof line !== "string")
  ) {
    throw new Error("Slack delivery proof completion log is unavailable");
  }
  // The logs.tail owner always returns loss flags in its LogTailPayload.
  // SAFETY: Guards above validate its variable file, cursor, and text-array fields.
  return value as LogTail;
}

async function waitForDelivery(environment: SlackQaScenarioEnvironment, initial: LogTail) {
  const deadline = Date.now() + environment.scenario.timeoutMs;
  let cursor = initial.cursor;
  const target = ` to channel:${environment.channelId}`;
  while (Date.now() < deadline) {
    const observed = await tail(environment, cursor);
    if (
      observed.file !== initial.file ||
      observed.reset ||
      observed.truncated ||
      observed.skippedBytes
    ) {
      throw new Error("Slack delivery proof completion log lost its cursor");
    }
    for (const line of observed.lines) {
      const record = object(JSON.parse(line));
      const payload = record["0"];
      // This is the existing dispatch owner's post-cleanup log, not the earlier agent terminal event.
      const message = isRecord(payload) ? payload.message : record.message;
      if (
        typeof message === "string" &&
        /^slack: delivered \d+ reply(?:ies)? to channel:/u.test(message) &&
        message.endsWith(target)
      ) {
        return;
      }
    }
    cursor = observed.cursor;
    await sleep(100);
  }
  throw new Error("Slack delivery proof inconclusive: dispatch completion was not observed");
}

export async function runSlackDeliveryProof(
  environment: SlackQaScenarioEnvironment,
  mode: DeliveryMode,
) {
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const preamble = `SLACK-DELIVERY-PREAMBLE-${suffix}`;
  const final = `SLACK-DELIVERY-FINAL-${suffix}`;
  const privateFinal = `SLACK-DELIVERY-PRIVATE-${suffix}`;
  const outputs: [string, string] = [`FIRST-${suffix}`, `SECOND-${suffix}`];
  const commands: [string, string] = [
    `sleep 2; printf '${outputs[0]}\\n'`,
    `sleep 2; printf '${outputs[1]}\\n'`,
  ];
  const sessionId = environment.context.gateway.runtimeEnv.OPENCLAW_DEBUG_PROXY_SESSION_ID;
  if (!sessionId) {
    throw new Error("Slack delivery proof requires the existing debug capture session");
  }
  const store = createDebugProxyCaptureReader({ env: environment.context.gateway.runtimeEnv });
  let cursor = 0;
  let initialLog: LogTail | undefined;
  let resolvedSettings: Record<string, unknown> | undefined;
  return await runSlackScenario(environment, {
    configOverrides: { delivery: mode, replyToMode: "all" },
    buildRun: (sutUserId) => ({
      expectReply: true,
      input: [
        `<@${sutUserId}> This is a bounded delivery test. In your first model response emit exactly ${preamble} as ordinary assistant text, then call the execution tool once to run: ${commands[0]}.`,
        "Wait for that result. In your second model response emit NO text; only call the execution tool again to run:",
        `${commands[1]}. Do not combine these calls. Do not call any other tools.`,
        mode === "message-tool"
          ? `After the second result, use only the message tool with action="send", channel="slack", target="channel:${environment.channelId}", and message="${final}". Emit no ordinary text in this tool-call response. After that send completes, finish with ordinary assistant text exactly ${privateFinal}. That final text is private under the configured message-tool-only policy.`
          : `After the second result, finish with ordinary assistant text exactly ${final}. Do not use the message tool.`,
      ].join(" "),
      matchText: final,
      beforeRun: async () => {
        const cfg = object(object(await environment.context.gateway.call("config.get")).config);
        const slack = object(object(cfg.channels).slack);
        const account = object(object(slack.accounts)[environment.sutAccountId]);
        const agents = object(cfg.agents);
        const defaults = object(agents.defaults);
        const qa = object(object(agents.entries).qa);
        const selections = [object(defaults.model), object(qa.model)];
        resolvedSettings = {
          streaming: account.streaming,
          replyToMode: account.replyToMode,
          visibleReplies: object(object(cfg.messages).groupChat).visibleReplies,
          blockStreamingDefault: defaults.blockStreamingDefault,
          verboseDefault: defaults.verboseDefault,
          reasoningDefault: defaults.reasoningDefault,
          thinkingDefault: defaults.thinkingDefault,
          loggingLevel: object(cfg.logging).level,
          modelSelections: selections,
          qaIdentityAbsent: qa.identity === undefined,
        };
        const streaming = object(account.streaming);
        const checks = {
          streamingMode: streaming.mode === (mode === "progress" ? "progress" : "off"),
          nativeTransport: streaming.nativeTransport === (mode === "progress"),
          blockStreamingDisabled: object(streaming.block).enabled === false,
          blockStreamingDefault: defaults.blockStreamingDefault === "off",
          verboseDefault: defaults.verboseDefault === "off",
          reasoningDefault: defaults.reasoningDefault === "off",
          thinkingDefault: defaults.thinkingDefault === "off",
          qaIdentityAbsent: qa.identity === undefined,
          modelSelections: selections.every(
            (selection) =>
              selection.primary === `anthropic/${MODEL}` &&
              (selection.fallbacks === undefined ||
                (Array.isArray(selection.fallbacks) && selection.fallbacks.length === 0)),
          ),
          visibleReplies:
            resolvedSettings.visibleReplies ===
            (mode === "message-tool" ? "message_tool" : "automatic"),
          loggingLevel: resolvedSettings.loggingLevel === "debug",
          replyToMode: account.replyToMode === "all",
        };
        const failed = Object.entries(checks)
          .filter(([, passed]) => !passed)
          .map(([name]) => name);
        if (failed.length > 0) {
          throw new Error(
            `Slack delivery proof runtime configuration differs from the selected mode; failed checks: ${failed.join(",")}`,
          );
        }
        initialLog = await tail(environment);
        cursor = getSlackQaMessageWriteCursor({ store, sessionId });
      },
      afterReply: async (reply, context) => {
        if (!initialLog) {
          throw new Error("Slack delivery proof did not establish a pre-send boundary");
        }
        await waitForDelivery(environment, initialLog);
        // The first matched reply may precede cleanup. Read the complete bounded
        // thread after the owner finishes; a deleted final must not qualify.
        const history = await context.sutReadClient.conversations.replies({
          channel: context.channelId,
          ts: context.sentTs,
          inclusive: true,
          limit: 50,
        });
        if (
          !history.ok ||
          history.has_more ||
          history.response_metadata?.next_cursor ||
          !Array.isArray(history.messages)
        ) {
          throw new Error("Slack delivery proof inconclusive: final thread readback is incomplete");
        }
        const retainedMessages = history.messages
          .filter((message) => message.user === environment.sutIdentity.userId)
          .map((message) => {
            if (typeof message.ts !== "string" || typeof message.text !== "string") {
              throw new Error("Slack delivery proof final message identity is missing");
            }
            return { ts: message.ts, text: message.text };
          });
        const trace = await readSlackQaWriteTrace({
          store,
          sessionId,
          afterRequestEventId: cursor,
        });
        const messages = readSlackDeliveryProviderMessages({ store, sessionId, cursor });
        const details = verifySlackDeliveryObservations({
          mode,
          preamble,
          final,
          privateFinal,
          channelId: environment.channelId,
          finalMessageId: reply.ts ?? "",
          commands,
          outputs,
          retainedMessages,
          messages,
          trace,
        });
        return JSON.stringify({
          ...JSON.parse(details),
          resolvedSettings,
          dispatchCompleted: true,
          captureOrder: trace.order,
        });
      },
    }),
  });
}
