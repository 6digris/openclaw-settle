// Telegram tests cover bot message dispatch.media dedup plugin behavior.
import { describe, expect, it } from "vitest";
import { deduplicateBlockSentMedia } from "./bot-message-dispatch.media-dedup.js";

describe("deduplicateBlockSentMedia", () => {
  it("returns undefined when all media already sent and no text", () => {
    const payload = { text: undefined, mediaUrls: ["/tmp/a.jpg"] };
    const sent = new Set(["/tmp/a.jpg"]);
    expect(deduplicateBlockSentMedia(payload, sent)).toBeUndefined();
  });

  it("handles partial overlap with multiple URLs", () => {
    const payload = { text: "see attached", mediaUrls: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"] };
    const sent = new Set(["/tmp/a.jpg", "/tmp/c.jpg"]);
    const result = deduplicateBlockSentMedia(payload, sent);
    expect(result).toEqual({ text: "see attached", mediaUrls: ["/tmp/b.jpg"] });
  });

  it("clears legacy mediaUrl when all mediaUrls removed but text remains", () => {
    const payload = { text: "captioned", mediaUrl: "/tmp/a.jpg", mediaUrls: ["/tmp/a.jpg"] };
    const sent = new Set(["/tmp/a.jpg"]);
    const result = deduplicateBlockSentMedia(payload, sent);
    expect(result).toEqual({ text: "captioned", mediaUrl: undefined, mediaUrls: [] });
  });

  it("preserves legacy mediaUrl when its attachment remains unsent", () => {
    const payload = {
      text: "hey",
      mediaUrl: "/tmp/b.jpg",
      mediaUrls: ["/tmp/a.jpg", "/tmp/b.jpg"],
    };
    const sent = new Set(["/tmp/a.jpg"]);
    const result = deduplicateBlockSentMedia(payload, sent);
    expect(result).toEqual({ text: "hey", mediaUrl: "/tmp/b.jpg", mediaUrls: ["/tmp/b.jpg"] });
  });

  it.each(["/tmp/dog.jpg", " /tmp/dog.jpg "])(
    "preserves unsent legacy mediaUrl outside the remaining mediaUrls (%s)",
    (mediaUrl) => {
      const payload = {
        text: "hey",
        mediaUrl,
        mediaUrls: ["/tmp/cat.jpg", "/tmp/bird.jpg"],
        attachments: [{ name: "Cat.jpg" }, { name: "Bird.jpg" }, { name: "Dog.jpg" }],
      };
      const sent = new Set(["/tmp/cat.jpg"]);
      const result = deduplicateBlockSentMedia(payload, sent);
      expect(result).toEqual({
        text: "hey",
        mediaUrl,
        mediaUrls: ["/tmp/bird.jpg"],
        attachments: [{ name: "Bird.jpg" }, { name: "Dog.jpg" }],
      });
    },
  );

  it("clears whitespace-padded legacy mediaUrl after its normalized attachment was sent", () => {
    const payload = {
      text: "hey",
      mediaUrl: " /tmp/a.jpg ",
      mediaUrls: ["/tmp/a.jpg", "/tmp/b.jpg"],
    };
    const sent = new Set(["/tmp/a.jpg"]);
    const result = deduplicateBlockSentMedia(payload, sent);
    expect(result).toEqual({ text: "hey", mediaUrl: undefined, mediaUrls: ["/tmp/b.jpg"] });
  });
});
