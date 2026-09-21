import { expect, it } from "vitest";
import { resolveComposerMentionChips } from "./chat-composer-mention-chips.ts";

const text = "Ask @Avery Finch now";
const mentions = [{ profileId: "avery", start: 4, end: 16 }];
const avatars = new Map<string, string>();

it("projects untouched mention spans during composition without mutating recipient authority", () => {
  for (const [value, expectedStart] of [
    [text + "確認", 4],
    ["確認 " + text, 7],
  ] as const) {
    const chips = resolveComposerMentionChips(value, text, mentions, avatars, true);
    expect(chips.map(({ start, end, label }) => ({ start, end, label }))).toEqual([
      { start: expectedStart, end: expectedStart + 12, label: "Avery Finch" },
    ]);
    expect(mentions).toEqual([{ profileId: "avery", start: 4, end: 16 }]);
    expect(resolveComposerMentionChips(value, text, mentions, avatars)).toEqual([]);
  }
});

it("does not manufacture recipients for replaced or merely typed preview text", () => {
  expect(resolveComposerMentionChips("Ask @Avery 確認 now", text, mentions, avatars, true)).toEqual(
    [],
  );
  expect(resolveComposerMentionChips(text, "", [], avatars, true)).toEqual([]);
  expect(resolveComposerMentionChips(text, text, undefined, avatars, true)).toEqual([]);
});
