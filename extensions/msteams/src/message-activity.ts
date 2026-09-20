import {
  createChannelProgressDraftCompositor,
  type ChannelProgressDraftCompositorSnapshot,
} from "openclaw/plugin-sdk/channel-outbound";
import type { MSTeamsConfig } from "../runtime-api.js";
import { parseMentions } from "./mentions.js";

const AI_GENERATED_ENTITY = {
  type: "https://schema.org/Message",
  "@type": "Message",
  "@context": "https://schema.org",
  "@id": "",
  additionalType: ["AIGeneratedContent"],
};

/** Build final transport text and its matching entities after Markdown rendering. */
export function buildMSTeamsMessageActivity(text?: string) {
  const parsed = parseMentions(text ?? "");
  return {
    type: "message" as const,
    ...(text === undefined ? {} : { text: parsed.text }),
    entities: [...parsed.entities, AI_GENERATED_ENTITY],
  };
}

/** Keep retained progress on the same plain-text surface as informative stream updates. */
export function buildMSTeamsProgressActivity(
  snapshot: ChannelProgressDraftCompositorSnapshot,
  config?: MSTeamsConfig,
) {
  const compositor = createChannelProgressDraftCompositor({
    entry: config,
    mode: "progress",
    active: true,
    seed: "msteams",
    initialSnapshot: snapshot,
    formatPlainText: (text) => text,
  });
  return {
    ...buildMSTeamsMessageActivity(),
    text: compositor.getText().replace(/^• /gmu, "- "),
    textFormat: "plain" as const,
  };
}
