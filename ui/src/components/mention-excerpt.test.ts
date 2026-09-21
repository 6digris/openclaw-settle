import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderMentionExcerpt } from "./mention-excerpt.ts";

describe("mention excerpt rendering", () => {
  it("highlights the supplied middle-of-text span without changing the text or creating a link", () => {
    const text = "Before the release, @Alex Chen please review the spacing.";
    const start = text.indexOf("@Alex Chen");
    const root = document.createElement("div");
    render(renderMentionExcerpt(text, { start, end: start + 10 }), root);
    expect(root.textContent).toBe(text);
    expect(root.querySelector(".mention-excerpt__highlight")?.textContent).toBe("@Alex Chen");
    expect(root.querySelector("a, button, openclaw-person-reference")).toBeNull();
  });

  it("escapes both highlighted text and surrounding markup", () => {
    const text = "<img src=x> @<Taylor> & after";
    const start = text.indexOf("@");
    const root = document.createElement("div");
    render(renderMentionExcerpt(text, { start, end: start + 9 }), root);
    expect(root.textContent).toBe(text);
    expect(root.querySelector("img, taylor")).toBeNull();
    expect(root.querySelector(".mention-excerpt__highlight")?.textContent).toBe("@<Taylor>");
  });

  it.each([
    undefined,
    { start: -1, end: 4 },
    { start: 0, end: 99 },
    { start: 3, end: 2 },
    { start: 0.5, end: 4 },
  ])("leaves text without a valid span unstyled", (span) => {
    const root = document.createElement("div");
    render(renderMentionExcerpt("@Taylor review this", span), root);
    expect(root.textContent).toBe("@Taylor review this");
    expect(root.querySelector(".mention-excerpt__highlight")).toBeNull();
  });
});
