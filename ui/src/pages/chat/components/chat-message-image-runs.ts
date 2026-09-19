import { html } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { extractToolCardsCached } from "../../../lib/chat/tool-cards.ts";
import { hasForwardedSource } from "../chat-turn-boundary.ts";
import { renderImageStrip } from "./chat-image-strip.ts";
import type {
  ChatMessageRenderPreparation,
  MessageActionDetails,
} from "./chat-message-markdown.ts";
import { projectMessageMedia, type ImageMessageGallery } from "./chat-message-media.ts";

type PreparedMessage = {
  item: MessageGroup["messages"][number];
  source: ChatMessageRenderPreparation;
  actions: MessageActionDetails | null;
};
type MessageEntry = { prepared: PreparedMessage; index: number };
type ImageEntry = MessageEntry & { media: ReturnType<typeof projectMessageMedia> };
type MessageRun =
  | { kind: "message"; key: string; entry: MessageEntry }
  | { kind: "images"; key: string; entries: ImageEntry[] };

// The transcript grouping owner has already separated sender, role, run, turn,
// and source identities. Only group pure images inside that boundary; keep each
// original bubble and its actions addressable for reply/reveal/context menus.
export function renderImageMessageRuns(
  group: MessageGroup,
  prepared: PreparedMessage[],
  renderItem: (message: PreparedMessage, index: number, gallery?: ImageMessageGallery) => unknown,
) {
  const runs: MessageRun[] = [];
  for (const [index, message] of prepared.entries()) {
    const { source, item, actions } = message;
    const normalized = source.normalizedMessage;
    const eligible =
      group.role === "assistant" &&
      !hasForwardedSource(group) &&
      !source.displayMarkdown.trim() &&
      !normalized.replyTarget &&
      !actions?.fullMessage &&
      (item.duplicateCount ?? 1) === 1 &&
      normalized.content.every(
        (content) =>
          content.type === "image" ||
          content.type === "attachment" ||
          (content.type === "text" && !content.text?.trim()),
      ) &&
      extractToolCardsCached(source.message).length === 0;
    const media = eligible ? projectMessageMedia(source.message, normalized.content) : undefined;
    if (
      !media?.images.length ||
      media.attachments.length ||
      media.expiredPairingQrCount ||
      media.nextPairingQrExpiresAt !== undefined
    ) {
      runs.push({ kind: "message", key: item.key, entry: { prepared: message, index } });
      continue;
    }
    const previous = runs.at(-1);
    const entry = { prepared: message, index, media };
    if (previous?.kind === "images") {
      previous.entries.push(entry);
    } else {
      runs.push({ kind: "images", key: item.key, entries: [entry] });
    }
  }
  return repeat(
    runs,
    (run) => run.key,
    (run) => {
      if (run.kind === "message") {
        return renderItem(run.entry.prepared, run.entry.index);
      }
      const images = run.entries.flatMap((entry) => entry.media.images);
      return renderImageStrip(
        repeat(
          run.entries,
          (entry) => entry.prepared.item.key,
          (entry) => html` <div class="chat-image-carousel__message">
            ${renderItem(entry.prepared, entry.index, { media: entry.media, images })}
          </div>`,
        ),
        images.length > 1,
      );
    },
  );
}
