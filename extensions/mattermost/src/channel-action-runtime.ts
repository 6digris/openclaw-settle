import {
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
  withNormalizedTimestamp,
} from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import * as runtime from "./channel.runtime.js";
import {
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
} from "./mattermost/accounts.js";
import { normalizeMattermostEmojiName } from "./mattermost/emoji.js";
import { normalizeMattermostMessagingTarget } from "./normalize.js";
import type { MattermostConfig } from "./types.js";

export const handleMattermostAction: NonNullable<
  ChannelMessageActionAdapter["handleAction"]
> = async ({
  action,
  params,
  cfg,
  accountId,
  conversationReadOrigin,
  requesterAccountId,
  toolContext,
  progressSnapshot,
  assertDirectAdapterHandoff,
}) => {
  if (action === "edit" && progressSnapshot) {
    assertDirectAdapterHandoff?.();
    const result = await runtime.editMattermostProgressMessage({
      cfg,
      accountId: accountId ?? undefined,
      to: readStringParam(params, "to", { required: true }),
      messageId: readStringParam(params, "messageId", { required: true }),
      threadId: readStringParam(params, "threadId"),
      snapshot: progressSnapshot,
      assertCurrent: assertDirectAdapterHandoff,
    });
    return jsonResult({ ok: true, result });
  }
  if (action === "read") {
    const resolvedAccountId = accountId ?? resolveDefaultMattermostAccountId(cfg);
    // SAFETY: Gateway config loading validated this plugin's schema; the SDK keeps channel types generic.
    const mattermostConfig = cfg.channels?.mattermost as MattermostConfig | undefined;
    const account = resolveMattermostAccount({ cfg, accountId: resolvedAccountId });
    if (!account.enabled) {
      throw new Error(`Mattermost account "${resolvedAccountId}" is disabled`);
    }
    const messagesEnabled =
      account.config.actions?.messages ?? mattermostConfig?.actions?.messages ?? false;
    if (!messagesEnabled) {
      throw new Error("Mattermost message reads are disabled in config");
    }

    const rawTarget =
      readStringParam(params, "to") ??
      readStringParam(params, "channelId") ??
      readStringParam(params, "target");
    if (!rawTarget) {
      throw new Error("Mattermost read requires target, to, or channelId.");
    }
    const normalizedTarget = normalizeMattermostMessagingTarget(rawTarget);
    const channelId = normalizedTarget?.startsWith("channel:")
      ? normalizedTarget.slice("channel:".length).trim()
      : !rawTarget.includes(":")
        ? rawTarget
        : "";
    if (!channelId) {
      throw new Error("Mattermost read requires a channel target.");
    }

    const before = readStringParam(params, "before");
    const after = readStringParam(params, "after");
    if (before && after) {
      throw new Error("Mattermost read accepts either before or after, not both.");
    }
    const result = await runtime.readMattermostMessages({
      cfg,
      channelId,
      limit: readPositiveIntegerParam(params, "limit", {
        message: "limit must be a positive integer.",
      }),
      before,
      after,
      accountId: resolvedAccountId,
      context: {
        conversationReadOrigin,
        requesterAccountId,
        toolContext,
      },
    });
    return jsonResult({
      ok: true,
      channelId,
      messages: result.messages.map((message) =>
        withNormalizedTimestamp(message, message.create_at),
      ),
      hasMore: result.hasMore,
    });
  }

  if (action === "react") {
    const resolvedAccountId = accountId ?? resolveDefaultMattermostAccountId(cfg);
    // SAFETY: Gateway config loading validated this plugin's schema; the SDK keeps channel types generic.
    const mattermostConfig = cfg.channels?.mattermost as MattermostConfig | undefined;
    const account = resolveMattermostAccount({ cfg, accountId: resolvedAccountId });
    if (!account.enabled) {
      throw new Error(`Mattermost account "${resolvedAccountId}" is disabled`);
    }
    const reactionsEnabled =
      account.config.actions?.reactions ?? mattermostConfig?.actions?.reactions ?? true;
    if (!reactionsEnabled) {
      throw new Error("Mattermost reactions are disabled in config");
    }

    const { postId, emojiName, remove } = parseMattermostReactActionParams(params);
    // The runner preserves the caller's spelling in `target` and puts the
    // directory-resolved provider destination in `to` before dispatch.
    const authorizedTarget = normalizeOptionalString(params.to);
    const mutateReaction = remove
      ? runtime.removeMattermostReaction
      : runtime.addMattermostReaction;
    const result = await mutateReaction({
      cfg,
      postId,
      emojiName,
      accountId: resolvedAccountId,
      authorizedTarget,
      conversationReadOrigin,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: remove
            ? `Removed reaction :${emojiName}: from ${postId}`
            : `Reacted with :${emojiName}: on ${postId}`,
        },
      ],
      details: {},
    };
  }

  throw new Error(`Unsupported Mattermost action: ${action}`);
};

function parseMattermostReactActionParams(params: Record<string, unknown>): {
  postId: string;
  emojiName: string;
  remove: boolean;
} {
  const postId =
    normalizeOptionalString(params.messageId) ?? normalizeOptionalString(params.postId);
  if (!postId) {
    throw new Error("Mattermost react requires messageId (post id)");
  }

  const emojiName = normalizeMattermostEmojiName(normalizeOptionalString(params.emoji));
  if (!emojiName) {
    throw new Error("Mattermost react requires emoji");
  }

  return {
    postId,
    emojiName,
    remove: params.remove === true,
  };
}
