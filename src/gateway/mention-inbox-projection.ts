import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { MentionInboxItem } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CurrentUserProfileDisplay } from "./current-user-profile-display.js";
import { humanMentionDisplayLabel } from "./human-mention-policy.js";
import type { MentionStoreMessage } from "./mention-inbox-store.js";
import { projectSessionParticipant } from "./session-identity-projection.js";
import { deriveSessionTitle } from "./session-utils-core.js";

export function projectMentionInboxItem(
  item: { id: string; message: MentionStoreMessage; source: { expiresAt: number } },
  current: {
    sender?: Extract<CurrentUserProfileDisplay, { kind: "resolved" }>;
    target: { entry: SessionEntry };
  },
  cfg: OpenClawConfig,
): MentionInboxItem {
  const { content } = item.message;
  const agentSender =
    "sender" in content ? projectSessionParticipant(content.sender, new Map(), cfg) : undefined;
  const attribution =
    "sender" in content
      ? {
          sender: content.sender,
          senderLabel: humanMentionDisplayLabel(
            agentSender?.label ?? content.sender.id,
            content.sender.id,
          ),
          ...(agentSender?.avatarUrl ? { senderAvatarUrl: agentSender.avatarUrl } : {}),
        }
      : {
          senderProfileId: current.sender?.profileId ?? content.senderProfileId,
          senderLabel: humanMentionDisplayLabel(current.sender?.label, content.senderProfileId),
          ...(current.sender ? { senderAvatarUrl: current.sender.avatarUrl } : {}),
        };
  return {
    ...content,
    ...attribution,
    id: item.id,
    expiresAt: item.source.expiresAt,
    sessionTitle:
      truncateUtf16Safe(
        (deriveSessionTitle(current.target.entry) ?? "Conversation")
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim(),
        256,
      ) || "Conversation",
  };
}

export function mentionExcerpt(input: string | undefined): string | undefined {
  return input
    ? truncateUtf16Safe(
        flattenMarkdownToPlainText(truncateUtf16Safe(input, 2_048))
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim(),
        280,
      )
    : undefined;
}
