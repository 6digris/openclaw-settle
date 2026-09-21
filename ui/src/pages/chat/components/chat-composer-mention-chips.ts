import { html } from "lit";
import type { ComposerChip, ComposerEditor } from "../../../components/composer-editor.ts";
import type { HumanMention } from "../../../lib/chat/chat-types.ts";
import {
  readHumanMentions,
  updateHumanMentions,
  type HumanMentionInput,
} from "../../../lib/chat/human-mentions.ts";
import { renderChatAuthorAvatar } from "./chat-author-avatar.ts";
import avatarStyles from "../../../styles/chat/author-avatar.css?inline";

export function resolveComposerMentionChips(
  value: string,
  draftText: string,
  mentions: readonly HumanMention[] | undefined,
  avatarUrls: ReadonlyMap<string, string>,
  preview = false,
): readonly ComposerChip[] {
  // Ordinary edits wait for the draft owner. IME/dictation previews deliberately
  // precede that commit: project only untouched recipients, without publishing them.
  if (value !== draftText && !preview) {
    return [];
  }
  const visibleMentions = preview ? updateHumanMentions(draftText, value, mentions) : mentions;
  return (readHumanMentions(value, visibleMentions) ?? []).map((mention) => {
    const name = value.slice(mention.start + 1, mention.end);
    return {
      kind: "mention",
      profileId: mention.profileId,
      start: mention.start,
      end: mention.end,
      label: name,
      // The editor has a shadow root; reuse the avatar owner and its stylesheet there.
      icon: html`<style>
          ${avatarStyles}</style
        >${renderChatAuthorAvatar({
          id: mention.profileId,
          name,
          identity: { type: "profile", id: mention.profileId },
          profileAvatarUrl: avatarUrls.get(mention.profileId),
        })}`,
    };
  });
}

/** The same history/edit boundary serves Chat and New Session; pasted names stay unbound. */
export function composerInputMentions(
  target: Pick<ComposerEditor, "value" | "restoredChips">,
  previous: string,
  mentions: readonly HumanMention[],
  input?: HumanMentionInput,
) {
  if (target.restoredChips !== undefined) {
    return (
      readHumanMentions(
        target.value,
        target.restoredChips.flatMap((chip) =>
          chip.kind === "mention" && chip.profileId
            ? [{ profileId: chip.profileId, start: chip.start, end: chip.end }]
            : [],
        ),
      ) ?? []
    );
  }
  return mentions.length ? updateHumanMentions(previous, target.value, mentions, input) : undefined;
}
