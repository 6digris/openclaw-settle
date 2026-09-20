import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsMentionableParams,
  validateSessionsMentionParams,
  type SessionsMentionableParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveControlUiSessionUrl } from "../../config/control-ui-link-base.js";
import { resolveSessionWorkStartError } from "../../config/sessions.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { extractTextFromChatContent } from "../../shared/chat-content.js";
import type { MentionRecordResult } from "../mention-inbox.types.js";
import { resolvePluginSessionOwnershipError } from "../session-plugin-ownership.js";
import { resolveSessionSharingTarget } from "../session-sharing.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/** A host-owned live caller may mention only from its own session, never impersonate an operator. */
function prepareMention(options: GatewayRequestHandlerOptions, input: SessionsMentionableParams) {
  const { client, context } = options;
  const caller = client?.internal?.syntheticClient ? client.internal.agentToolCaller : undefined;
  if (
    !caller?.assertCurrent ||
    caller.agentId !== input.agentId ||
    caller.sessionKey !== input.sessionKey
  ) {
    throw new Error("Mentions require the current session's active Gateway-hosted agent run.");
  }
  const inbox = context.mentionInbox;
  if (!inbox) {
    throw new Error("The mention Inbox is unavailable.");
  }
  const resolve = () =>
    resolveSessionSharingTarget({
      cfg: context.getRuntimeConfig(),
      sessionKey: input.sessionKey,
      agentId: input.agentId,
    });
  caller.assertCurrent();
  const target = resolve();
  if (!target) {
    throw new Error("Session is unavailable for mentions.");
  }
  const assertCurrent = () => {
    caller.assertCurrent?.();
    options.sessionMutationCommitGuard?.();
    options.sessionMutationAuthorization?.assertCurrent();
    options.signal?.throwIfAborted();
    const current = resolve();
    if (
      client?.invalidated ||
      !current ||
      current.agentId !== target.agentId ||
      current.storePath !== target.storePath ||
      current.storeKey !== target.storeKey ||
      current.entry.sessionId !== target.entry.sessionId ||
      current.entry.lifecycleRevision !== target.entry.lifecycleRevision ||
      current.entry.incognito ||
      isIncognitoSessionKey(current.canonicalKey)
    ) {
      throw new Error("Session changed or is unavailable for mentions.");
    }
    const workError = resolveSessionWorkStartError(current.canonicalKey, current.entry);
    const ownershipError = resolvePluginSessionOwnershipError({
      action: "patch",
      entry: current.entry,
      key: current.canonicalKey,
      pluginOwnerId: client?.internal?.pluginRuntimeOwnerId,
    });
    if (workError || ownershipError) {
      throw new Error(workError ?? ownershipError?.message);
    }
  };
  assertCurrent();
  return { inbox, target, assertCurrent, caller };
}

export const sessionMentionHandlers: GatewayRequestHandlers = {
  "sessions.mentionable": async (options) => {
    const { params, respond } = options;
    if (
      !assertValidParams(params, validateSessionsMentionableParams, "sessions.mentionable", respond)
    ) {
      return;
    }
    try {
      const { inbox, assertCurrent } = prepareMention(options, params);
      await inbox.agentMentionable(params, assertCurrent, (result) => {
        respond(
          result.ok,
          result.ok ? result.value : undefined,
          result.ok ? undefined : result.error,
        );
      });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          error instanceof Error ? error.message : "Mention discovery is unavailable.",
        ),
      );
    }
  },
  "sessions.mention": async (options) => {
    const { params, respond, context } = options;
    if (!assertValidParams(params, validateSessionsMentionParams, "sessions.mention", respond)) {
      return;
    }
    try {
      const { inbox, target, assertCurrent, caller } = prepareMention(options, params);
      if (!params.message.trim()) {
        throw new Error("A mention requires a nonempty assistant note.");
      }
      const recipients = inbox.validateAgentRecipients(params, params.recipientProfileIds);
      if (!recipients.ok) {
        respond(false, undefined, recipients.error);
        return;
      }
      const assertCommitCurrent = () => {
        assertCurrent();
        const current = inbox.validateAgentRecipients(params, recipients.value);
        if (!current.ok) {
          throw new Error(current.error.message);
        }
      };
      const requestHash = createHash("sha256")
        .update(JSON.stringify([caller.agentId, recipients.value.toSorted(), params.message]))
        .digest("hex");
      let outcome: MentionRecordResult = { status: "skipped", reason: "unavailable" };
      const admission = await beginSessionWorkAdmission({
        scope: target.storePath,
        identities: [target.storeKey, target.entry.sessionId],
        assertAllowed: assertCommitCurrent,
      });
      let appended: Awaited<ReturnType<typeof appendInjectedAssistantMessageToTranscript>>;
      try {
        assertCommitCurrent();
        appended = await admission.run(() =>
          appendInjectedAssistantMessageToTranscript({
            sessionKey: target.storeKey,
            sessionId: target.entry.sessionId,
            expectedSessionId: target.entry.sessionId,
            expectedLifecycleRevision: target.entry.lifecycleRevision ?? null,
            storePath: target.storePath,
            agentId: target.agentId,
            config: context.getRuntimeConfig(),
            message: params.message,
            idempotencyKey:
              "agent-mention:" +
              createHash("sha256")
                .update(JSON.stringify([caller.agentId, params.idempotencyKey]))
                .digest("hex"),
            agentMention: {
              senderAgentId: caller.agentId,
              recipientProfileIds: recipients.value,
              requestHash,
            },
            beforeFreshMessageCommit: assertCommitCurrent,
            onMessageCommitted: (committed) => {
              // The transcript owner supplies canonical replay bytes and an immutable committed cursor.
              // Do not manufacture an Inbox source from the request or notify after cancellation.
              assertCurrent();
              const message = isRecord(committed.message) ? committed.message : undefined;
              const metadata = isRecord(message?.openclawAgentMention)
                ? message.openclawAgentMention
                : undefined;
              if (
                !metadata ||
                metadata.requestHash !== requestHash ||
                !committed.anchor ||
                typeof message?.timestamp !== "number"
              ) {
                return;
              }
              outcome = inbox.recordCommittedInput({
                sourceId: "agent-mention:" + committed.messageId,
                committedSource: {
                  generation: committed.anchor.generation,
                  sequence: committed.anchor.rawSeq,
                  timestamp: message.timestamp,
                },
                sessionKey: target.canonicalKey,
                agentId: target.agentId,
                sessionId: target.entry.sessionId,
                messageId: committed.messageId,
                sender: { type: "agent", id: caller.agentId },
                recipientProfileIds: recipients.value,
                excerpt: extractTextFromChatContent(message.content) ?? undefined,
                assertCurrent,
              });
            },
          }),
        );
      } finally {
        admission.release();
      }
      if (!appended.ok || !appended.messageId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            appended.error ?? "The assistant note could not be saved.",
          ),
        );
        return;
      }
      const sessionUrl = resolveControlUiSessionUrl(context.getRuntimeConfig(), {
        sessionKey: target.canonicalKey,
        fallbackAgentId: target.agentId,
        exactKey: true,
      });
      const messageUrl = sessionUrl ? new URL(sessionUrl) : undefined;
      messageUrl?.searchParams.set("messageId", appended.messageId);
      respond(true, {
        ...outcome,
        ...(messageUrl ? { messageUrl: messageUrl.toString() } : {}),
        sessionKey: target.canonicalKey,
        agentId: target.agentId,
        messageId: appended.messageId,
      });
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          error instanceof Error ? error.message : "Mention request is unavailable.",
        ),
      );
    }
  },
};
