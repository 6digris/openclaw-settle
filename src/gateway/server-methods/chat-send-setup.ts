import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionGoalOperation } from "../../config/sessions/goals-operations.js";
import { readSessionSubmittedInput } from "../../config/sessions/session-accessor.js";
import { admitChatSend } from "./chat-send-admission.js";
import { runChatSendPreAdmission } from "./chat-send-pre-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import {
  prepareChatSendNativeRuntimeRestriction,
  prepareChatSendSession,
} from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Normalize, prepare, and exclusively admit one new chat.send request. */
export async function prepareAndAdmitChatSend(
  {
    params,
    respond,
    context,
    client,
    hasCurrentClientAuthority,
    sessionMutationAuthorization,
  }: Pick<
    GatewayRequestHandlerOptions,
    | "params"
    | "respond"
    | "context"
    | "client"
    | "hasCurrentClientAuthority"
    | "sessionMutationAuthorization"
  >,
  onAdmissionOwned?: () => Promise<boolean>,
  options?: {
    trustedSystemInput?: boolean;
    goalResume?: SessionGoalOperation & { action: "resume" };
  },
) {
  const assertCurrent =
    sessionMutationAuthorization || hasCurrentClientAuthority
      ? () => {
          sessionMutationAuthorization?.assertCurrent();
          if (hasCurrentClientAuthority?.() === false) {
            throw new Error("Gateway caller authority is no longer active.");
          }
        }
      : undefined;
  const normalizedRequest = normalizeChatSendRequest({
    params,
    client,
    ...(options?.trustedSystemInput ? { trustedSystemInput: true } : {}),
    ...(options?.goalResume ? { goalResume: options.goalResume } : {}),
  });
  if (!normalizedRequest.ok) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        normalizedRequest.error,
        normalizedRequest.reason ? { details: { reason: normalizedRequest.reason } } : undefined,
      ),
    );
    return undefined;
  }
  const preparedSession = prepareChatSendSession({
    request: normalizedRequest.value,
    context,
    client,
  });
  if (!preparedSession.ok) {
    respond(
      false,
      undefined,
      typeof preparedSession.error === "string"
        ? errorShape(ErrorCodes.INVALID_REQUEST, preparedSession.error)
        : preparedSession.error,
    );
    return undefined;
  }
  const shouldAdmit = await runChatSendPreAdmission({
    request: normalizedRequest.value,
    session: preparedSession.value,
    respond,
    context,
    client,
    assertCurrent,
  });
  if (!shouldAdmit) {
    return undefined;
  }
  if (normalizedRequest.value.mentions) {
    const inbox = context.mentionInbox;
    const everyone = normalizedRequest.value.mentions.some((mention) => "kind" in mention);
    const { entry, agentId, sessionKey, storePath, clientRunId } = preparedSession.value;
    // This exact-source read only avoids fresh roster selection. Pending-input admission
    // still verifies the request, sender and private audience before reclaiming custody.
    const submitted =
      everyone && entry?.sessionId
        ? readSessionSubmittedInput(
            { agentId, sessionKey, sessionId: entry.sessionId, storePath },
            `${clientRunId}:user`,
          )
        : undefined;
    if (everyone && inbox && !submitted) {
      const prepared = await inbox.prepareEveryoneRecipients();
      assertCurrent?.();
      if (!prepared.ok) {
        respond(false, undefined, prepared.error);
        return undefined;
      }
    }
    const target = preparedSession.value.entry
      ? { sessionKey: preparedSession.value.sessionKey, agentId: preparedSession.value.agentId }
      : { agentId: preparedSession.value.agentId };
    const mentions = context.mentionInbox?.validateRecipients(
      client,
      target,
      normalizedRequest.value.mentions.flatMap((mention) =>
        "profileId" in mention ? [mention.profileId] : [],
      ),
    );
    if (!mentions?.ok) {
      respond(
        false,
        undefined,
        mentions?.error ??
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "Human mentions are unavailable; reconnect and retry.",
          ),
      );
      return undefined;
    }
    if (everyone && inbox && !submitted) {
      const recipients = inbox.resolveEveryoneRecipients(client, target);
      if (!recipients.ok) {
        respond(false, undefined, recipients.error);
        return undefined;
      }
      normalizedRequest.value.everyoneRecipients = recipients.value;
    }
  }
  const nativeRestriction = await prepareChatSendNativeRuntimeRestriction({
    request: normalizedRequest.value,
    session: preparedSession.value,
    client,
    context,
    assertCurrent,
  });
  if (nativeRestriction) {
    respond(false, undefined, nativeRestriction);
    return undefined;
  }
  const admitted = await admitChatSend({
    request: normalizedRequest.value,
    session: preparedSession.value,
    respond,
    context,
    client,
    onAdmissionOwned,
    hasCurrentClientAuthority,
    assertCurrent,
  });
  if (!admitted.ok) {
    return undefined;
  }
  return { normalizedRequest, preparedSession, admitted };
}
