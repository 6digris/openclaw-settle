import { createHash } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { stableStringify } from "@openclaw/normalization-core/stable-stringify";
import { runAgentHarnessBeforeMessageWriteHook } from "../../agents/harness/hook-helpers.js";
import { normalizeMessageClientSources } from "../../chat/message-client-source.js";
import { measureDiagnosticsTimelineSpan } from "../../infra/diagnostics-timeline.js";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  buildRunUserTurnIdempotencyKey,
  createUserTurnTranscriptRecorder,
  type UserTurnInput,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import type { UserTurnOriginalInputCommit } from "../../sessions/user-turn-transcript.types.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { MentionAudienceIdentity } from "../mention-inbox-audience-schema.js";
import type { MentionInbox } from "../mention-inbox.types.js";
import { loadSessionEntry } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { hasGatewayAdminScope } from "./chat-origin-routing.js";
import { buildRestartSafeChatTranscriptState } from "./chat-restart-recovery.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import {
  resolveChatSendReplyContext,
  type ChatSendReplyContextFields,
} from "./chat-send-reply-context.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import { gatewayClientSenderFields } from "./gateway-client-identity.js";
import type { GatewayClient } from "./shared-types.js";

export type GatewayChatUserTurnPersist = (options?: {
  contextFreeCommand?: true;
}) => ReturnType<UserTurnTranscriptRecorder["persistFallback"]>;

type GatewayChatUserTurnController = {
  baseInput: UserTurnInput;
  persist: (
    ...args: Parameters<GatewayChatUserTurnPersist>
  ) => ReturnType<UserTurnTranscriptRecorder["persistFallback"]>;
  persistBestEffort: GatewayChatUserTurnPersist;
  recorder: UserTurnTranscriptRecorder;
  replyContextFieldsPromise?: Promise<ChatSendReplyContextFields>;
  setInputPromise: (input: Promise<UserTurnInput>) => void;
};

export function createGatewayChatUserTurnController(params: {
  admission: AdmittedChatSend;
  client: GatewayClient | null;
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  transcript?: Pick<UserTurnInput, "display" | "excludeFromContext">;
  startedAt: number;
  warn: (message: string) => void;
  mentionInbox?: MentionInbox;
  assertGoalCurrent?: () => void;
  assertOriginalInputCommit?: () => void;
}): GatewayChatUserTurnController {
  const { admission, request, session } = params;
  const sender =
    request.goalOperation?.action === "resume"
      ? undefined
      : gatewayClientSenderFields(params.client).sender;
  const senderProfileId = params.client?.authenticatedUserProfile?.profileId;
  const selectedMentions = request.mentions ? structuredClone(request.mentions) : undefined;
  const mentionInbox = params.mentionInbox;
  const sourceId = buildRunUserTurnIdempotencyKey(session.clientRunId);
  const sourceClients =
    !params.client?.internal?.syntheticClient &&
    (!request.systemInputProvenance || request.systemInputProvenance.kind === "external_user")
      ? normalizeMessageClientSources([request.clientInfo])
      : [];
  const baseInput: UserTurnInput = {
    ...params.transcript,
    ...(request.goalOperation?.action === "resume" ? { display: false } : {}),
    text: request.rawMessage,
    ...(request.workContext ? { workContext: request.workContext } : {}),
    ...(request.mentions ? { mentions: request.mentions } : {}),
    timestamp: session.now,
    idempotencyKey: sourceId,
    ...(request.p.replyToId ? { replyToId: request.p.replyToId } : {}),
    ...(sender ? { sender } : {}),
    ...(sourceClients.length ? { transport: { clients: sourceClients } } : {}),
    ...(hasGatewayAdminScope(params.client) ? { senderIsOwner: true } : {}),
    ...(request.systemInputProvenance ? { provenance: request.systemInputProvenance } : {}),
  };
  const replyContextFieldsPromise = request.p.replyToId
    ? resolveChatSendReplyContext({
        replyToId: request.p.replyToId,
        cfg: session.cfg,
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        sessionEntry: session.entry,
        storePath: session.storePath,
        userSenderLabel: request.clientInfo?.displayName,
        warn: params.warn,
      })
    : undefined;
  let inputPromise = replyContextFieldsPromise
    ? replyContextFieldsPromise.then((fields): UserTurnInput => ({
        ...baseInput,
        ...(fields.ReplyToBody
          ? {
              replyToPreview: {
                text: fields.ReplyToBody,
                ...(fields.ReplyToSender ? { senderLabel: fields.ReplyToSender } : {}),
              },
            }
          : {}),
      }))
    : Promise.resolve(baseInput);
  // Audience bytes never enter the message, hook input, pending-input JSON or transcript.
  const everyoneSelected = selectedMentions?.some((mention) => "kind" in mention);
  const audienceRecipients = request.everyoneRecipients
    ? [...request.everyoneRecipients]
    : undefined;
  const pendingInputRequestFingerprint =
    sender?.id && !request.goalOperation
      ? createHash("sha256")
          .update(
            stableStringify([
              {
                ...request.p,
                sessionId: admission.sessionBinding.sessionId,
                expectedLeafEntryId: undefined,
              },
              sender.identity ?? sender.id,
              hasGatewayAdminScope(params.client),
            ]),
          )
          .digest("hex")
      : undefined;
  let audienceIdentity: MentionAudienceIdentity | undefined;
  const bindAudience = () => {
    if (
      !audienceIdentity &&
      everyoneSelected &&
      senderProfileId &&
      pendingInputRequestFingerprint
    ) {
      admission.assertWorkAdmissionCurrent();
      const current = loadSessionEntry(session.sessionKey, {
        ...session.sessionLoadOptions,
        clone: false,
      });
      if (!current.entry || current.entry.sessionId !== admission.sessionBinding.sessionId) {
        throw new Error("Mention audience has no current admitted session");
      }
      audienceIdentity = {
        agentId: session.agentId,
        sessionKey: session.sessionKey,
        sessionId: current.entry.sessionId,
        sourceId,
        senderProfileId,
        requestFingerprint: pendingInputRequestFingerprint,
        storePath: current.storePath,
      };
    }
    return audienceIdentity;
  };
  const retainAudience = (source: { recovered: boolean }) => {
    const identity = bindAudience();
    if (!identity || !mentionInbox) {
      return;
    }
    if (!source.recovered && !audienceRecipients) {
      throw new Error("Fresh mention input requires an admitted everyone audience");
    }
    mentionInbox.retainEveryoneAudience(params.client, identity, {
      ...(audienceRecipients
        ? { recipients: audienceRecipients, recovered: source.recovered }
        : { recovered: true as const }),
      assertCurrent: () => {
        admission.assertWorkAdmissionCurrent();
        params.assertOriginalInputCommit?.();
      },
    });
  };
  let contextFreeCommand = false;
  const recorder: UserTurnTranscriptRecorder = createUserTurnTranscriptRecorder({
    ...(pendingInputRequestFingerprint ? { pendingInputRequestFingerprint } : {}),
    ...(request.goalOperation
      ? {
          sessionTurnMutation: {
            kind: "goal",
            operation: request.goalOperation,
            runId: session.clientRunId,
            assertCurrent: params.assertGoalCurrent,
          },
        }
      : {}),
    input: baseInput,
    ...(everyoneSelected ? { preparePendingInputSourceCustody: retainAudience } : {}),
    resolveInput: () => inputPromise,
    target: () => {
      // Retain only the current binding; transcript writers recheck it at commit.
      const { storePath, entry } = loadSessionEntry(session.sessionKey, {
        ...session.sessionLoadOptions,
        clone: false,
      });
      const sessionId = (entry ?? admission.initialSessionEntry)?.sessionId;
      if (!sessionId || sessionId !== admission.sessionBinding.sessionId) {
        return undefined;
      }
      return {
        sessionId,
        expectedSessionId: sessionId,
        initialSessionEntry: admission.initialSessionEntry,
        sessionKey: session.sessionKey,
        sessionEntry: undefined,
        storePath,
        agentId: session.agentId,
        config: session.cfg,
      };
    },
    ...(admission.restartSafeAdmission
      ? buildRestartSafeChatTranscriptState({
          admission: admission.restartSafeAdmission,
          clientRunId: session.clientRunId,
          startedAt: params.startedAt,
        })
      : {}),
    errorContext: "gateway chat user turn transcript",
    assertOriginalInputCommit: params.assertOriginalInputCommit,
    beforeMessageWrite: (event) => {
      const originalInput = event.message.idempotencyKey === sourceId;
      const next = runAgentHarnessBeforeMessageWriteHook(event);
      // This hook runs inside the synchronous writer after durable replay lookup.
      // Fence only fresh original input, never accepted custody or terminal notices.
      if (originalInput && next?.role === "user") {
        recorder.assertOriginalInputCommit?.();
        if (contextFreeCommand) {
          return {
            ...next,
            excludeFromContext: true,
            __openclaw: {
              ...asOptionalRecord(Reflect.get(next, "__openclaw")),
              contextFreeCommand: true,
            },
          };
        }
      }
      return next;
    },
    onPersistenceError: (error) =>
      params.warn(`gateway user transcript persistence failed: ${formatForLog(error)}`),
    ...(selectedMentions && senderProfileId && mentionInbox
      ? {
          onOriginalInputCommitted: ({ message, anchor }: UserTurnOriginalInputCommit) => {
            // New-session input has no pending queue to survive: bind once after its
            // actual SID is committed, still under the original live admission.
            if (!session.entry && audienceRecipients) {
              retainAudience({ recovered: false });
            }
            const stored = message["__openclaw"]?.humanMentions;
            const text =
              extractTextFromChatContent(message.content, {
                joinWith: "\n",
                normalizeText: (value) => value,
              }) ?? "";
            const retained = selectedMentions.filter(
              (mention) =>
                Array.isArray(stored) &&
                stored.some((value) => {
                  const span = asOptionalRecord(value);
                  return (
                    span &&
                    ("kind" in mention
                      ? span.kind === "everyone"
                      : span.profileId === mention.profileId) &&
                    span.start === mention.start &&
                    span.end === mention.end &&
                    text.slice(mention.start, mention.end) ===
                      request.rawMessage.slice(mention.start, mention.end)
                  );
                }),
            );
            if (!retained.length) {
              params.warn(
                "Human mentions skipped because the committed text no longer contains the selected tokens.",
              );
            }
            mentionInbox.recordCommittedInput({
              sourceId,
              committedSource: {
                generation: anchor.generation,
                sequence: anchor.rawSeq,
                timestamp: message.timestamp,
              },
              agentId: anchor.agentId,
              sessionKey: session.sessionKey,
              sessionId: anchor.sessionId,
              messageId: anchor.entryId,
              senderProfileId,
              recipientProfileIds: [
                ...new Set(
                  retained.flatMap((mention) =>
                    "profileId" in mention ? [mention.profileId] : [],
                  ),
                ),
              ],
              ...(audienceIdentity
                ? {
                    everyoneAudience: {
                      identity: audienceIdentity,
                      retained: retained.some((mention) => "kind" in mention),
                    },
                  }
                : {}),
              excerpt: redactSensitiveText(text),
            });
          },
        }
      : {}),
  });
  const persist: GatewayChatUserTurnController["persist"] = async (options) => {
    if (options?.contextFreeCommand === true && !recorder.hasPersisted()) {
      contextFreeCommand = true;
    }
    return await measureDiagnosticsTimelineSpan(
      "gateway.chat_send.persist_user_transcript",
      () => recorder.persistFallback(),
      {
        phase: "agent-turn",
        config: session.cfg,
        attributes: admission.chatSendTraceAttributes,
      },
    );
  };
  return {
    baseInput,
    persist,
    persistBestEffort: async (options) => {
      return await persist(options).catch(() => undefined);
    },
    recorder,
    replyContextFieldsPromise,
    setInputPromise: (input) => {
      const previousInputPromise = inputPromise;
      inputPromise = Promise.all([previousInputPromise, input]).then(([previous, next]) => ({
        ...previous,
        ...next,
      }));
    },
  };
}
