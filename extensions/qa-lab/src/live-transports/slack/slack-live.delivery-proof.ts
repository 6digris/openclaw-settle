import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createDebugProxyCaptureReader } from "openclaw/plugin-sdk/proxy-capture";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createQaGatewayCliError } from "../../gateway-log-redaction.js";
import type { SlackQaScenarioEnvironment } from "./scenario-environment.js";
import { runSlackScenario } from "./scenario-runtime.js";
import {
  getSlackQaMessageWriteCursor,
  readSlackQaWriteTrace,
  type SlackQaWriteTrace,
} from "./slack-live.capture.js";
import type { SlackQaConfigOverrides } from "./slack-live.contracts.js";
import {
  MODEL,
  object,
  type ProviderMessage,
  readSlackDeliveryProviderMessages,
} from "./slack-live.provider-capture.js";

type DeliveryMode = NonNullable<SlackQaConfigOverrides["delivery"]>;
type LogTail = {
  file: string;
  cursor: number;
  lines: string[];
  reset: boolean;
  truncated: boolean;
  skippedBytes?: number;
};
const CONTINUATION_EVENT_PREFIXES = [
  "settled post-tool turn ",
  "settled-turn finalization ",
  "reasoning-only assistant turn ",
  "missing assistant terminal message ",
  "empty response ",
  "compaction interrupted visible final answer:",
  "before_agent_finalize requested one more pass:",
];

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
  terminalSendResult?: ProviderMessage["toolResults"][number];
  trace: SlackQaWriteTrace;
  ownerEvents?: string[];
}) {
  const { messages, trace } = params;
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
  let sendEnvelope: Record<string, unknown> | undefined;
  let sendReceipt: Record<string, unknown> | undefined;
  let coreTarget: Record<string, unknown> | undefined;
  let pluginSuccess = false;
  let coreSuccess = false;
  const sendResult = params.terminalSendResult;
  if (params.mode === "message-tool") {
    try {
      sendEnvelope = object(JSON.parse(sendResult?.text ?? ""));
      sendReceipt = object(sendEnvelope.result);
      // Slack's prepared payload uses core delivery; workspace-aware actions
      // retain the plugin envelope. Each owner has explicit success semantics.
      coreTarget = isRecord(sendReceipt.target) ? sendReceipt.target : undefined;
      pluginSuccess = sendEnvelope.ok === true && sendReceipt.channelId === params.channelId;
      coreSuccess =
        sendEnvelope.channel === "slack" &&
        sendEnvelope.via === "direct" &&
        sendEnvelope.deliveryStatus === "sent" &&
        sendReceipt.channel === "slack" &&
        coreTarget?.kind === "channel" &&
        coreTarget.id === params.channelId;
      sendResultMatches =
        sendResult?.id === send?.id &&
        sendResult?.isError === false &&
        (pluginSuccess || coreSuccess) &&
        sendReceipt.messageId === params.finalMessageId;
    } catch {
      /* A missing or non-JSON result cannot establish an explicit send. */
    }
  }
  const shape =
    messages.length === 3 &&
    resultsCorrelated &&
    orderedBlocks &&
    execCallsMatch &&
    messages[0]?.text === params.preamble &&
    messages[0]?.stopReason === "tool_use" &&
    messages[1]?.text === "" &&
    messages[1]?.stopReason === "tool_use" &&
    (params.mode === "message-tool"
      ? tools[2]?.length === 1 &&
        send?.name === "message" &&
        send.input.action === "send" &&
        send.input.channel === "slack" &&
        send.input.target === `channel:${params.channelId}` &&
        send.input.message === params.final &&
        send.input.final === true &&
        messages[2]?.text === "" &&
        messages[2]?.stopReason === "tool_use" &&
        sendResultMatches
      : tools[2]?.length === 0 &&
        messages[2]?.stopReason === "end_turn" &&
        messages[2]?.text === params.final);
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
      preamble: message.text === params.preamble,
      final: message.text === params.final,
      privateFinal: message.text === params.privateFinal,
      blocks: message.blocks.map((block) => block.type),
      tools: message.blocks.filter((block) => block.type === "tool_use").length,
      stopReason: message.stopReason,
      toolResults: message.toolResults.length,
      maxTokens: message.maxTokens,
      outputTokens: message.outputTokens,
      request: message.request
        ? {
            eventId: message.request.eventId,
            sameRequestAsPrevious: message.request.sameRequestAsPrevious,
            sameResponseIdAsPrevious: message.request.sameResponseIdAsPrevious,
            messageCount: message.request.messageCount,
            toolCount: message.request.toolCount,
            lastRole: message.request.lastRole,
            lastUserTextChars: message.request.lastUserText.length,
          }
        : undefined,
    })),
    toolResultsCorrelated: resultsCorrelated,
    explicitSendCorrelated: params.mode === "message-tool" ? sendResultMatches : undefined,
    ownerEventKinds: params.ownerEvents?.map(
      (message) =>
        CONTINUATION_EVENT_PREFIXES.find((prefix) => message.startsWith(prefix))?.trim() ??
        "unclassified-owner-event",
    ),
    explicitSendDiagnostics:
      params.mode === "message-tool"
        ? {
            toolName: send?.name === "message",
            action: send?.input.action === "send",
            channel: send?.input.channel === "slack",
            target: send?.input.target === `channel:${params.channelId}`,
            content: send?.input.message === params.final,
            terminal: send?.input.final === true,
            resultSource: "gateway-transcript",
            resultIdMatches: sendResult?.id === send?.id,
            resultPresent: sendResult !== undefined,
            resultError: sendResult?.isError,
            resultTextParts: sendResult?.textParts,
            envelopeObject: sendEnvelope !== undefined,
            receiptObject: sendReceipt !== undefined,
            pluginSuccess,
            coreSuccess,
            pluginChannelMatches: sendReceipt?.channelId === params.channelId,
            coreChannelMatches:
              coreTarget?.kind === "channel" && coreTarget.id === params.channelId,
            messageMatches: sendReceipt?.messageId === params.finalMessageId,
          }
        : undefined,
    retainedMessages: params.retainedMessages.map((message) => ({
      finalIdentity: message.ts === params.finalMessageId,
      final: message.text.includes(params.final),
      preamble: message.text.includes(params.preamble),
      privateFinal: message.text.includes(params.privateFinal),
      textChars: message.text.length,
    })),
    captureComplete: trace.complete,
    captureIssues: trace.issues,
    unexpectedMethods: unexpected.map(() => "unexpected-method"),
    nonAcknowledgedWrites: trace.writes
      .filter((write) => write.status !== "acknowledged")
      .map((write) => ({
        eventId: write.eventId,
        method:
          write.classification !== "other" || safeOtherMethods.has(write.method)
            ? write.method
            : "unexpected-method",
        classification: write.classification,
        status: write.status,
        responseStatus: write.responseStatus,
        responseOk: write.responseOk,
        errorCode: write.errorCode,
      })),
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
  const finalRequest = messages.at(-1)?.request;
  const failure = (reason: string) =>
    new Error(
      `${reason}; ${JSON.stringify({
        ...facts,
        privateDiagnostics: {
          // Reuse QA's redacted, bounded error excerpt before any collector sees it.
          finalUserInput: finalRequest
            ? createQaGatewayCliError(finalRequest.lastUserText).message
            : undefined,
          ownerEvents: params.ownerEvents
            ?.slice(0, 16)
            .map((message) => createQaGatewayCliError(message).message),
        },
      })}`,
    );
  if (!shape) {
    throw failure("Slack delivery proof inconclusive: provider sequence unexercised");
  }
  const matchedFinal = replies.some(
    (write) =>
      write.status === "acknowledged" &&
      write.message?.channelId === params.channelId &&
      write.message.ts === params.finalMessageId &&
      (write.content.some((text) => text.includes(params.final)) ||
        nativeText.get(`${params.channelId}/${params.finalMessageId}`)?.includes(params.final)),
  );
  if (
    !trace.complete ||
    unexpected.length > 0 ||
    replies.some((write) => write.status !== "acknowledged") ||
    !matchedFinal
  ) {
    throw failure("Slack delivery proof inconclusive: capture incomplete");
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
    throw failure("Slack delivery proof failed: visible final policy");
  }
  if (
    params.mode !== "progress" &&
    (replies.length !== 1 || content.some((text) => text !== params.final))
  ) {
    throw failure("Slack delivery proof failed: intermediate reply content");
  }
  // Progress is an intentional status mode, not a claim that narration was never visible.
  if (
    params.mode === "progress" &&
    (!visibleContent.some((text) => text.includes(params.preamble)) ||
      !replies.some((write) => write.method === "chat.startStream") ||
      !replies.some((write) => write.method === "chat.stopStream"))
  ) {
    throw failure("Slack delivery proof inconclusive: progress presentation unexercised");
  }
  return details;
}

export async function readSlackTerminalSendResult(params: {
  gateway: Pick<SlackQaScenarioEnvironment["context"]["gateway"], "call">;
  channelId: string;
  sentTs: string;
  toolCallId: string;
}): Promise<ProviderMessage["toolResults"][number]> {
  // A completed message send terminates before another provider request. Read
  // its persisted result through the Gateway, scoped to this owned Slack thread.
  const route = `:channel:${params.channelId.toLowerCase()}:thread:${params.sentTs}`;
  const listing = object(
    await params.gateway.call("sessions.list", { agentId: "qa", search: route, limit: 2 }),
  );
  if (
    listing.hasMore !== false ||
    !Array.isArray(listing.sessions) ||
    listing.sessions.length !== 1
  ) {
    throw new Error("Slack delivery proof terminal session identity is incomplete");
  }
  const session = object(listing.sessions[0]);
  if (
    typeof session.key !== "string" ||
    !session.key.startsWith("agent:qa:slack:") ||
    !session.key.endsWith(route) ||
    typeof session.sessionId !== "string" ||
    !session.sessionId
  ) {
    throw new Error("Slack delivery proof terminal session identity is incomplete");
  }
  const history = object(
    await params.gateway.call("chat.history", {
      sessionKey: session.key,
      agentId: "qa",
      limit: 24,
    }),
  );
  if (
    history.sessionKey !== session.key ||
    history.sessionId !== session.sessionId ||
    history.hasMore !== false ||
    history.nextOffset !== undefined ||
    !Array.isArray(history.messages) ||
    history.messages.length >= 24
  ) {
    throw new Error("Slack delivery proof terminal transcript is incomplete");
  }
  const results = history.messages
    .map(object)
    .filter((message) => message.role === "toolResult" && message.toolCallId === params.toolCallId);
  const result = results[0];
  const content =
    Array.isArray(result?.content) && result.content.length === 1
      ? object(result.content[0])
      : undefined;
  if (
    results.length !== 1 ||
    result?.toolName !== "message" ||
    (isRecord(result["__openclaw"]) && result["__openclaw"].truncated === true) ||
    typeof result.isError !== "boolean" ||
    content?.type !== "text" ||
    typeof content.text !== "string"
  ) {
    throw new Error("Slack delivery proof terminal tool result is incomplete");
  }
  return { id: params.toolCallId, isError: result.isError, text: content.text, textParts: 1 };
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
  const ownerEvents: string[] = [];
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
      // One isolated inbound turn owns this cursor interval. Retain only named
      // retry/finalization events with their run identity in private failure data.
      if (
        typeof message === "string" &&
        message.includes("runId=") &&
        CONTINUATION_EVENT_PREFIXES.some((prefix) => message.startsWith(prefix)) &&
        ownerEvents.length < 16
      ) {
        ownerEvents.push(message);
      }
      if (
        typeof message === "string" &&
        /^slack: delivered \d+ reply(?:ies)? to channel:/u.test(message) &&
        message.endsWith(target)
      ) {
        return ownerEvents;
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
          ? `After the second result, use only the message tool with action="send", channel="slack", target="channel:${environment.channelId}", message="${final}", and final=true to complete this reply. Emit no ordinary text in this tool-call response. Do not produce any further assistant response or tool call after the send.`
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
        const ownerEvents = await waitForDelivery(environment, initialLog);
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
        const messages = readSlackDeliveryProviderMessages({
          store,
          sessionId,
          cursor,
          fixtureMarker: preamble,
        });
        const send = messages[2]?.blocks.find((block) => block.type === "tool_use");
        const terminalSendResult =
          mode === "message-tool" && send?.type === "tool_use"
            ? await readSlackTerminalSendResult({
                gateway: environment.context.gateway,
                channelId: environment.channelId,
                sentTs: context.sentTs,
                toolCallId: send.id,
              })
            : undefined;
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
          terminalSendResult,
          trace,
          ownerEvents,
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
