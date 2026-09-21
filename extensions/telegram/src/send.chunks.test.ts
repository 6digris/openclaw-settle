// Telegram tests cover plain-text chunk-splitting behavior.
import { describe, expect, it } from "vitest";
import { splitTelegramPlainTextChunks } from "./rich-plain-fallback.js";

function containsLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (isLow) {
      return true;
    }
  }
  return false;
}

describe("splitTelegramPlainTextChunks", () => {
  it("does not split an astral char across the chunk boundary", () => {
    // Emoji surrogate pair straddles index 10 (limit): high at 9, low at 10.
    const input = `${"A".repeat(9)}😀${"B".repeat(20)}`;
    const chunks = splitTelegramPlainTextChunks(input, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      expect(containsLoneSurrogate(chunk)).toBe(false);
    }
  });

  it("does not hang when limit=1 and an astral char appears mid-string at a chunk boundary", () => {
    // With limit=1, the second iteration starts on the high surrogate.
    // Keep the pair whole and advance instead of looping forever.
    const input = "A😀B";
    const chunks = splitTelegramPlainTextChunks(input, 1);
    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      expect(containsLoneSurrogate(chunk)).toBe(false);
    }
  });
});
