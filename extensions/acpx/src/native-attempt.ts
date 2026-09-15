import type { AcpRuntimeTurn, AcpRuntimeTurnResult } from "acpx/runtime";
import {
  clearActiveEmbeddedRun,
  resolveBootstrapContextForRun,
  resolveAgentHarnessBeforePromptBuildResult,
  setActiveEmbeddedRun,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
  type EmbeddedRunAttemptResult,
  type AgentMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentityStrict,
  publishSessionTranscriptUpdateByIdentity,
  readVisibleSessionTranscriptMessageEntries,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import type { AcpxNativeRuntime, AcpxNativeTarget } from "./native-types.js";

type Assistant = Extract<AgentMessage, { role: "assistant" }>;
export type AcpxNativeAttemptInput = Pick<
  AgentHarnessAttemptParamsV2,
  | "abortSignal"
  | "bootstrapContextMode"
  | "bootstrapContextRunKind"
  | "chatType"
  | "config"
  | "extraSystemPrompt"
  | "images"
  | "modelId"
  | "onAssistantMessageStart"
  | "onAttemptTimeout"
  | "onExecutionStarted"
  | "onPartialReply"
  | "onReasoningStream"
  | "onToolResult"
  | "prompt"
  | "provider"
  | "replyOperation"
  | "runId"
  | "sessionFile"
  | "sessionId"
  | "sessionKey"
  | "sourceReplyDeliveryMode"
  | "timeoutMs"
  | "toolAuthorityFingerprint"
  | "trigger"
  | "userTurnTranscriptRecorder"
  | "workspaceDir"
> & {
  model: Pick<AgentHarnessAttemptParamsV2["model"], "api">;
  hostCapabilities: Pick<
    AgentHarnessAttemptParamsV2["hostCapabilities"],
    "assertActive" | "requestApproval"
  >;
};

export async function runAcpxNativeAttempt(params: {
  input: AcpxNativeAttemptInput;
  native: AcpxNativeRuntime;
  target: AcpxNativeTarget;
  command: string[];
  harnessId: string;
  label: string;
  active: Map<string, () => void>;
}): Promise<EmbeddedRunAttemptResult> {
  const { input, native, target } = params;
  const controller = new AbortController();
  const signal = input.abortSignal
    ? AbortSignal.any([input.abortSignal, controller.signal])
    : controller.signal;
  let turn: AcpRuntimeTurn | undefined;
  let settled = false;
  let timedOut = false;
  let text = "";
  let reasoning = "";
  let toolActivity = false;
  let permissionNotGranted = false;
  let failedTool = false;
  let result: AcpRuntimeTurnResult | undefined;
  let failure: unknown;
  let assistant: Assistant | undefined;
  let assistantIdempotencyKey: string | undefined;
  let terminalAnchor: EmbeddedRunAttemptResult["contextEngineTerminalAnchor"];
  const toolMetas: AgentHarnessAttemptResult["toolMetas"] = [];
  const transcript = {
    ...target,
    storePath: resolveStorePath(input.config?.session?.store, { agentId: target.agentId }),
  };
  let messages: AgentMessage[] = [];
  let entries: Awaited<ReturnType<typeof readVisibleSessionTranscriptMessageEntries>> = [];
  const assertActive = () => {
    signal.throwIfAborted();
    input.hostCapabilities.assertActive();
  };
  const cancel = () => controller.abort();
  const activeRun = {
    kind: "embedded" as const,
    runId: input.runId,
    toolAuthorityFingerprint: input.toolAuthorityFingerprint,
    queueMessage: async () => {
      throw new Error(`${params.label} does not support live message injection`);
    },
    isStreaming: () => turn !== undefined && !settled,
    isAborted: () => signal.aborted,
    isCompacting: () => false,
    cancel,
    abort: cancel,
    sourceReplyDeliveryMode: input.sourceReplyDeliveryMode,
  };
  assertActive();
  params.active.set(input.sessionId, cancel);
  setActiveEmbeddedRun(
    input.sessionId,
    activeRun,
    input.sessionKey,
    input.sessionFile,
    target.agentId,
  );
  input.replyOperation?.attachBackend(activeRun);
  const timer = setTimeout(() => {
    timedOut = true;
    input.onAttemptTimeout?.(new Error("Native ACP turn timed out"));
    cancel();
  }, input.timeoutMs);
  timer.unref();
  try {
    entries = await readVisibleSessionTranscriptMessageEntries(transcript);
    messages = entries.map((entry) => entry.message);
    assertActive();
    await native.withSession(
      {
        ...target,
        command: params.command,
        cwd: input.workspaceDir,
        model: `${input.provider}/${input.modelId}`,
        assertActive,
        onPermissionRequest: async (request, context) => {
          assertActive();
          const approval = await input.hostCapabilities.requestApproval({
            signal: AbortSignal.any([signal, context.signal]),
            title: `${params.label}: ${request.raw.toolCall.title}`,
            description: JSON.stringify(request.raw.toolCall),
            severity: "warning",
            toolName: request.inferredKind ?? "other",
            toolCallId: request.raw.toolCall.toolCallId,
            allowedDecisions: ["allow-once", "deny"],
            timeoutMs: input.timeoutMs,
          });
          assertActive();
          permissionNotGranted ||= approval?.decision !== "allow-once";
          return { outcome: approval?.decision === "allow-once" ? "allow_once" : "reject_once" };
        },
      },
      async ({ runtime, handle, lastRequestId, getStatus }) => {
        let previous = messages;
        if (lastRequestId) {
          const marker = `${lastRequestId}:acp-native:assistant`;
          const index = entries.findLastIndex(
            (entry) =>
              entry.entryId === lastRequestId ||
              ("idempotencyKey" in entry.message && entry.message.idempotencyKey === marker),
          );
          if (index < 0) {
            throw new Error(
              "Native conversation history cannot be reconciled; reset this session before continuing",
            );
          }
          previous = messages.slice(index + 1);
        }
        const recorder = input.userTurnTranscriptRecorder;
        if (!recorder) {
          throw new Error("Native ACP turn requires the admitted user transcript recorder");
        }
        await recorder.persistApproved({ expectedSessionId: input.sessionId });
        assertActive();
        if (recorder.isBlocked() || !recorder.hasPersisted()) {
          throw new Error("Native ACP user turn was not admitted to its transcript");
        }
        const admission = recorder.getAdmissionReceipt();
        if (!admission) {
          throw new Error("Native ACP turn is missing its committed input anchor");
        }
        const user = recorder.getPersistedMessage?.() ?? recorder.message;
        if (!user) {
          throw new Error("Native ACP turn is missing its committed input message");
        }
        previous = previous.filter(
          (message) =>
            message !== entries.find((entry) => entry.entryId === admission.entryId)?.message,
        );
        const bootstrap = !lastRequestId
          ? await resolveBootstrapContextForRun({
              workspaceDir: input.workspaceDir,
              config: input.config,
              sessionKey: input.sessionKey,
              sessionId: input.sessionId,
              agentId: target.agentId,
              chatType: input.chatType,
              contextMode: input.bootstrapContextMode,
              runKind: input.bootstrapContextRunKind,
            })
          : undefined;
        const built = await resolveAgentHarnessBeforePromptBuildResult({
          prompt: input.prompt,
          messages,
          developerInstructions: [
            ...(bootstrap?.contextFiles.map((file) => `${file.path}\n${file.content}`) ?? []),
            input.extraSystemPrompt,
          ]
            .filter((part): part is string => Boolean(part))
            .join("\n\n"),
          ctx: {
            runId: input.runId,
            agentId: target.agentId,
            sessionId: input.sessionId,
            sessionKey: input.sessionKey,
            workspaceDir: input.workspaceDir,
            config: input.config,
            trigger: input.trigger,
            modelProviderId: input.provider,
            modelId: input.modelId,
          },
          bootstrapContextRunKind: input.bootstrapContextRunKind,
        });
        if (built.toolsAllow) {
          throw new Error("Native ACP cannot enforce a prompt-hook tool restriction");
        }
        assertActive();
        const contextPrompt =
          previous.length === 0
            ? built.prompt
            : `Conversation context before this turn:\n${JSON.stringify(previous)}\n\nCurrent user turn:\n${built.prompt}`;
        const prompt = built.developerInstructions
          ? `OpenClaw workspace context:\n${built.developerInstructions}\n\n${contextPrompt}`
          : contextPrompt;
        turn = runtime.startTurn({
          handle,
          text: prompt,
          mode: "prompt",
          requestId: admission.entryId,
          signal,
          ...(input.images?.length
            ? {
                attachments: input.images.map((image) => ({
                  data: image.data,
                  mediaType: image.mimeType,
                })),
              }
            : {}),
        });
        void turn.result.catch(() => {});
        await turn.promptStarted;
        recorder.markSentToProvider?.();
        input.onExecutionStarted?.();
        for await (const event of turn.events) {
          if (event.type === "text_delta") {
            if (event.stream === "thought") {
              reasoning += event.text;
              await input.onReasoningStream?.({ text: reasoning });
            } else {
              if (!text) {
                await input.onAssistantMessageStart?.();
              }
              text += event.text;
              await input.onPartialReply?.({ text });
            }
          } else if (event.type === "tool_call") {
            toolActivity = true;
            failedTool ||= event.status === "failed";
            const existingTool = event.toolCallId
              ? toolMetas.find((tool) => tool.toolCallId === event.toolCallId)
              : undefined;
            if (existingTool) {
              existingTool.meta = event.text;
              existingTool.isError ||= event.status === "failed";
            } else {
              toolMetas.push({
                toolName: event.title ?? event.kind ?? "tool",
                toolCallId: event.toolCallId,
                meta: event.text,
                isError: event.status === "failed",
              });
            }
            await input.onToolResult?.({ text: event.text });
          }
        }
        result = await turn.result;
        if (!text && permissionNotGranted) {
          text = `${params.label} could not complete this turn because permission was not granted.`;
        } else if (!text && failedTool) {
          text = `${params.label} reported a failed tool operation and did not return an answer.`;
        }
        const status = await getStatus();
        const usage = status.usage?.perRequest?.[admission.entryId];
        assistant = {
          role: "assistant",
          provider: input.provider,
          model: input.modelId,
          api: input.model.api,
          content: [
            ...(reasoning ? [{ type: "thinking" as const, thinking: reasoning }] : []),
            ...(text ? [{ type: "text" as const, text }] : []),
          ],
          stopReason:
            result.status === "cancelled"
              ? "aborted"
              : result.status === "failed"
                ? "error"
                : "stop",
          timestamp: Date.now(),
          usage: {
            input: usage?.inputTokens ?? 0,
            output: usage?.outputTokens ?? 0,
            cacheRead: usage?.cachedReadTokens ?? 0,
            cacheWrite: usage?.cachedWriteTokens ?? 0,
            totalTokens: usage?.totalTokens ?? 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        const key = `${admission.entryId}:acp-native:assistant`;
        const written = await appendSessionTranscriptMessageByIdentityStrict({
          ...transcript,
          config: input.config,
          message: { ...assistant, idempotencyKey: key },
          prepareMessageAfterIdempotencyCheck: (message) => {
            input.hostCapabilities.assertActive();
            return message;
          },
        });
        if (written.kind !== "result") {
          throw new Error("Native ACP assistant transcript was not committed");
        }
        assistantIdempotencyKey = key;
        terminalAnchor = written.result.anchor;
        messages.push(user, assistant);
        await publishSessionTranscriptUpdateByIdentity(transcript);
      },
    );
  } catch (error) {
    failure = error;
  } finally {
    settled = true;
    clearTimeout(timer);
    try {
      if (turn) {
        const pendingTurn = turn;
        const cleanups = [
          ...(!result && !signal.aborted
            ? [() => pendingTurn.cancel({ reason: "native-attempt-ended" })]
            : []),
          () => pendingTurn.closeStream({ reason: "native-attempt-ended" }),
          () => pendingTurn.result,
        ];
        for (const cleanup of cleanups) {
          try {
            await cleanup();
          } catch (error) {
            failure ??= error;
          }
        }
      }
    } finally {
      if (params.active.get(input.sessionId) === cancel) {
        params.active.delete(input.sessionId);
      }
      clearActiveEmbeddedRun(input.sessionId, activeRun, input.sessionKey, input.sessionFile);
    }
  }
  const terminal: EmbeddedRunAttemptResult["terminal"] = timedOut
    ? { kind: "timeout", phase: "prompt", source: "runtime", aborted: true }
    : signal.aborted || result?.status === "cancelled"
      ? { kind: "aborted", source: "external" }
      : failure || result?.status === "failed"
        ? {
            kind: "failed",
            source: "prompt",
            error:
              failure ??
              new Error(
                result?.status === "failed" ? result.error.message : "Native ACP turn failed",
              ),
          }
        : { kind: "ok" };
  return {
    terminal,
    sessionIdUsed: input.sessionId,
    sessionFileUsed: input.sessionFile,
    agentHarnessId: params.harnessId,
    runtimeModelSelection: { provider: input.provider, model: input.modelId },
    messagesSnapshot: messages,
    assistantTexts: text ? [text] : [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
    ...(assistantIdempotencyKey
      ? {
          assistantTranscriptOwned: true,
          assistantTranscriptIdempotencyKey: assistantIdempotencyKey,
          contextEngineTerminalAnchor: terminalAnchor,
        }
      : {}),
    toolMetas,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: toolActivity, replaySafe: !turn },
    itemLifecycle: {
      startedCount: toolMetas.length,
      completedCount: result?.status === "completed" ? toolMetas.length : 0,
      activeCount: 0,
    },
  };
}
