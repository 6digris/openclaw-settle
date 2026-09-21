import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentToolResult } from "../../../packages/agent-core/src/types.js";
import {
  HEARTBEAT_RESPONSE_TOOL_NAME,
  normalizeHeartbeatToolResponse,
  type HeartbeatToolResponse,
} from "../../auto-reply/heartbeat-tool-response.js";
import { isDeliveredMessagingToolResult } from "../embedded-agent-message-tool-source-reply.js";
import { isMessagingTool, isMessagingToolSendAction } from "../embedded-agent-messaging.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../embedded-agent-messaging.types.js";
import {
  extractToolResultMediaArtifact,
  filterToolResultMediaUrls,
} from "../embedded-agent-tool-media.js";
import {
  isToolResultError,
  resolveToolResultFailureKind,
  type ToolResultFailureKind,
} from "../tool-result-error.js";

export function recordAgentHarnessToolResultTelemetry(params: {
  toolName: string;
  args: Record<string, unknown>;
  result: AgentToolResult<unknown> | undefined;
  mediaTrustResult?: unknown;
  telemetry: AgentHarnessToolResultTelemetry;
  extractSourceReplyPayload: (
    result: AgentToolResult<unknown> | undefined,
  ) => MessagingToolSourceReplyPayload | undefined;
  isError: boolean;
  signal: AbortSignal;
  autoDeliveryTtsMediaUrls?: readonly string[];
  coreTtsToolResult?: object;
  messagingTarget?: MessagingToolSend;
  sourceReplyFinal?: boolean;
  trustedLocalMediaToolNames?: ReadonlySet<string>;
}): MessagingToolSend | MessagingToolSourceReplyPayload | undefined {
  if (params.isError) {
    return undefined;
  }
  if (!params.isError && params.toolName === "cron" && isCronAddAction(params.args)) {
    params.telemetry.successfulCronAdds = (params.telemetry.successfulCronAdds ?? 0) + 1;
  }
  if (!params.isError && params.toolName === HEARTBEAT_RESPONSE_TOOL_NAME) {
    const response = normalizeHeartbeatToolResponse(params.result?.details);
    if (response) {
      params.telemetry.heartbeatToolResponse = response;
    }
  }
  // Only a live invocation may accept new media; committed effects remain evidence.
  if (params.result && !params.signal.aborted) {
    const media = recordAgentHarnessToolResultMedia({
      facts: params.telemetry,
      toolName: params.toolName,
      result: params.result,
      mediaTrustResult: params.coreTtsToolResult ?? params.mediaTrustResult,
      trustedLocalMediaToolNames: params.trustedLocalMediaToolNames,
    });
    if (media) {
      const mediaUrls = media.mediaUrls;
      const autoDeliveryMediaUrls = new Set(params.telemetry.toolAutoDeliveryMediaUrls);
      const rawAutoDeliveryMediaUrls = new Set(params.autoDeliveryTtsMediaUrls);
      let retainsCoreTtsMedia = false;
      for (const mediaUrl of mediaUrls) {
        if (rawAutoDeliveryMediaUrls.has(mediaUrl)) {
          autoDeliveryMediaUrls.add(mediaUrl);
          retainsCoreTtsMedia = true;
        } else {
          autoDeliveryMediaUrls.delete(mediaUrl);
        }
      }
      params.telemetry.toolAutoDeliveryMediaUrls = [...autoDeliveryMediaUrls];
      if (
        retainsCoreTtsMedia &&
        params.coreTtsToolResult &&
        !params.telemetry.coreTtsToolResults.includes(params.coreTtsToolResult)
      ) {
        params.telemetry.coreTtsToolResults.push(params.coreTtsToolResult);
      }
    }
  }
  if (!isMessagingTool(params.toolName)) {
    return undefined;
  }
  const isMessagingSendAction = isMessagingToolSendAction(params.toolName, params.args);
  if (!isMessagingSendAction && !params.messagingTarget) {
    return undefined;
  }
  if (
    !isMessagingSendAction &&
    !isDeliveredMessagingToolResult({
      toolName: params.toolName,
      args: params.args,
      result: params.result,
      hookResult: params.mediaTrustResult,
      isError: params.isError,
    })
  ) {
    return undefined;
  }
  const sourceReplyPayload = params.extractSourceReplyPayload(params.result);
  if (sourceReplyPayload) {
    return recordAgentHarnessMessagingDelivery({
      facts: params.telemetry,
      sourceReplyPayload,
      sourceReplyFinal: params.sourceReplyFinal,
    });
  }
  return recordAgentHarnessMessagingDelivery({
    facts: params.telemetry,
    target: params.messagingTarget ?? {
      tool: params.toolName,
      provider: readFirstString(params.args, ["provider", "channel"]) ?? params.toolName,
      accountId: readFirstString(params.args, ["accountId", "account_id"]),
      to: readFirstString(params.args, ["to", "target", "recipient"]),
      threadId: readFirstString(params.args, ["threadId", "thread_id", "messageThreadId"]),
    },
    text: readFirstString(params.args, ["text", "message", "body", "content"]),
    mediaUrls: collectAgentHarnessMessagingMediaUrls(params.args),
    sourceReplyFinal: params.sourceReplyFinal,
  });
}

/** Presentation can add a failure, but cannot erase a failure from execution. */
export function resolveAgentHarnessToolResultPresentation(params: {
  result: AgentToolResult<unknown>;
  executionIsError: boolean;
  executionFailureKind?: ToolResultFailureKind;
}) {
  const presentationFailureKind = resolveToolResultFailureKind(params.result);
  const failureKind = params.executionFailureKind ?? presentationFailureKind;
  const result =
    params.executionFailureKind && params.executionFailureKind !== presentationFailureKind
      ? {
          ...params.result,
          details: {
            ...(isRecord(params.result.details) ? params.result.details : {}),
            status: params.executionFailureKind,
          },
        }
      : params.result;
  return {
    result,
    isError: params.executionIsError || isToolResultError(params.result),
    failureKind,
  };
}

/** Records a delivery already established by the caller's messaging receipt. */
export function recordAgentHarnessMessagingDelivery(params: {
  facts: AgentHarnessMessagingDeliveryFacts;
  sourceReplyPayload?: MessagingToolSourceReplyPayload;
  target?: MessagingToolSend;
  text?: string;
  mediaUrls?: string[];
  sourceReplyFinal?: boolean;
}): MessagingToolSend | MessagingToolSourceReplyPayload | undefined {
  const { facts, sourceReplyPayload, target, text, mediaUrls = [], sourceReplyFinal } = params;
  facts.didSendViaMessagingTool = true;
  const finality = sourceReplyFinal !== undefined ? { sourceReplyFinal } : {};
  if (sourceReplyPayload) {
    const record = { ...sourceReplyPayload, ...finality };
    facts.messagingToolSourceReplyPayloads.push(record);
    return record;
  }
  if (text) {
    facts.messagingToolSentTexts.push(text);
  }
  facts.messagingToolSentMediaUrls.push(...mediaUrls);
  if (!target) {
    return undefined;
  }
  const record = {
    ...target,
    ...(text ? { text } : {}),
    ...(mediaUrls.length ? { mediaUrls } : {}),
    ...finality,
  };
  facts.messagingToolSentTargets.push(record);
  return record;
}

/** Result presentation supplies artifacts; the concrete tool supplies path trust. */
export function recordAgentHarnessToolResultMedia(params: {
  facts: AgentHarnessToolMediaFacts;
  toolName?: string;
  result: unknown;
  mediaTrustResult?: unknown;
  trustedLocalMediaToolNames?: ReadonlySet<string>;
}) {
  const media = extractToolResultMediaArtifact(params.result);
  if (!media) {
    return undefined;
  }
  const mediaUrls = filterToolResultMediaUrls(
    params.toolName,
    media.mediaUrls,
    params.mediaTrustResult ?? params.result,
    params.trustedLocalMediaToolNames,
  );
  const seen = new Set(params.facts.toolMediaUrls);
  for (const url of mediaUrls) {
    if (!seen.has(url)) {
      seen.add(url);
      params.facts.toolMediaUrls.push(url);
    }
  }
  if (media.audioAsVoice) {
    params.facts.toolAudioAsVoice = true;
  }
  return { ...media, mediaUrls };
}

export type AgentHarnessMessagingDeliveryFacts = {
  didSendViaMessagingTool: boolean;
  messagingToolSentTexts: string[];
  messagingToolSentMediaUrls: string[];
  messagingToolSentTargets: MessagingToolSend[];
  messagingToolSourceReplyPayloads: MessagingToolSourceReplyPayload[];
};

export type AgentHarnessToolMediaFacts = {
  toolMediaUrls: string[];
  toolAudioAsVoice?: boolean;
};

export type AgentHarnessToolResultTelemetry = AgentHarnessMessagingDeliveryFacts &
  AgentHarnessToolMediaFacts & {
    toolAudioAsVoice: boolean;
    toolAutoDeliveryMediaUrls: string[];
    coreTtsToolResults: object[];
    successfulCronAdds?: number;
    heartbeatToolResponse?: HeartbeatToolResponse;
  };

function readFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

export function collectAgentHarnessMessagingMediaUrls(record: Record<string, unknown>): string[] {
  const urls: string[] = [];
  const pushMediaUrl = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      urls.push(value.trim());
    }
  };
  const pushAttachment = (value: unknown) => {
    if (!isRecord(value)) {
      return;
    }
    for (const key of ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"]) {
      pushMediaUrl(value[key]);
    }
  };
  for (const key of [
    "media",
    "mediaUrl",
    "media_url",
    "path",
    "filePath",
    "fileUrl",
    "imageUrl",
    "image_url",
  ]) {
    const value = record[key];
    pushMediaUrl(value);
  }
  for (const key of ["mediaUrls", "media_urls", "imageUrls", "image_urls"]) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const entry of value) {
      pushMediaUrl(entry);
    }
  }
  const attachments = record.attachments;
  if (Array.isArray(attachments)) {
    for (const attachment of attachments) {
      pushAttachment(attachment);
    }
  }
  return urls;
}
function isCronAddAction(args: Record<string, unknown>): boolean {
  const action = args.action;
  return typeof action === "string" && action.trim().toLowerCase() === "add";
}
