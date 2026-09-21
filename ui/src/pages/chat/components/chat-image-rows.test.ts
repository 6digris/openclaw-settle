/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { renderMessageGroup, renderMessageGroupContent } from "./chat-message-group.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";

const container = document.createElement("div");
const image = (name: string) => ({
  type: "image",
  url: "https://example.com/" + name + ".png",
  alt: name,
});
const text = (value: string) => ({ type: "text", text: value });
const options = { showReasoning: false, isStreaming: false };

function drawMessage(content: unknown[]) {
  render(
    renderGroupedMessage(
      prepareChatMessageRender({ role: "assistant", content }),
      "ordered",
      options,
    ),
    container,
  );
}

function drawTranscript(
  messages: Record<string, unknown>[],
  renderGroup = renderMessageGroup,
  extra = {},
) {
  const groups = groupMessages(
    messages.map((message, index) => ({ kind: "message", key: "message-" + index, message })),
  );
  render(
    html`${groups.map((group) => (group.kind === "group" ? renderGroup(group, { ...options, ...extra }) : nothing))}`,
    container,
  );
}

function rows() {
  return [...container.querySelectorAll(".chat-message-images")].map((row) =>
    [...row.querySelectorAll("img")].map((img) => img.alt),
  );
}

afterEach(() => {
  render(nothing, container);
  container.remove();
});

describe("consecutive image sets", () => {
  it("groups only adjacent images and preserves Markdown and attachment positions", () => {
    drawMessage([
      text("1. Compare these"),
      image("a"),
      text("\n  \n"),
      image("b"),
      text("1. Next comparison"),
      image("c"),
      {
        type: "attachment",
        attachment: {
          kind: "document",
          label: "report.txt",
          url: "https://example.com/report.txt",
        },
      },
      image("d"),
      image("e"),
      text("[Reference][proof]\n\n[proof]: https://example.com/proof"),
    ]);
    expect(rows()).toEqual([["a", "b"], ["c"], ["d", "e"]]);
    expect(container.querySelectorAll("ol > li")).toHaveLength(2);
    expect(
      container.querySelector("ol > li:first-child .chat-message-images")?.querySelectorAll("img"),
    ).toHaveLength(2);
    expect(container.querySelector('a[href="https://example.com/proof"]')?.textContent).toBe(
      "Reference",
    );
    expect(
      [...container.querySelectorAll("img, .chat-assistant-attachment-card")].map((element) =>
        element instanceof HTMLImageElement ? element.alt : "file",
      ),
    ).toEqual(["a", "b", "c", "file", "d", "e"]);
  });

  it("groups MEDIA directives with adjacent structured images, but not their caption", () => {
    drawMessage([
      text("MEDIA:https://example.com/a.png\nMEDIA:https://example.com/b.png"),
      image("structured"),
      text("A caption separates the next image."),
      image("after"),
    ]);
    expect(rows()).toEqual([["a.png", "b.png", "structured"], ["after"]]);
    drawTranscript([
      { role: "assistant", content: "MEDIA:https://example.com/a.png" },
      { role: "assistant", content: "MEDIA:https://example.com/b.png" },
    ]);
    expect(rows()).toEqual([["a.png"], ["b.png"]]);
  });

  it.each([
    { type: "thinking", thinking: "Reasoning boundary" },
    { type: "image", omitted: true, bytes: 100 },
  ])("does not join images across a $type block", (boundary) => {
    drawMessage([image("a"), boundary, image("b")]);
    expect(rows()).toEqual([["a"], ["b"]]);
  });

  it.each([renderMessageGroup, renderMessageGroupContent])(
    "keeps separately delivered images in their own messages and lightboxes (%#)",
    (renderGroup) => {
      const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
      const messages = ["a", "b", "c"].map((name, index) => ({
        role: "assistant",
        content: [image(name)],
        timestamp: 1000 + index,
        __openclaw: { id: name, seq: index + 1 },
      }));
      drawTranscript(messages.slice(0, 1), renderGroup, { onOpenImage });
      const firstImage = container.querySelector("img");
      drawTranscript(messages, renderGroup, { onOpenImage });
      expect(rows()).toEqual([["a"], ["b"], ["c"]]);
      expect(container.querySelector("img")).toBe(firstImage);
      expect(
        [...container.querySelectorAll<HTMLElement>(".chat-bubble")].map(
          (bubble) => bubble.dataset.entryId,
        ),
      ).toEqual(["a", "b", "c"]);
      container.querySelectorAll<HTMLButtonElement>(".chat-message-image-button")[1]!.click();
      expect(onOpenImage).toHaveBeenCalledOnce();
      expect(onOpenImage.mock.calls[0]![0]).toMatchObject({ title: "b" });
      expect(onOpenImage.mock.calls[0]![0].gallery).toBeUndefined();
    },
  );

  it.each(["", "\n\n", " \t "])(
    "keeps forwarded images outside text disclosure with separator %j",
    (separator) => {
      const content = [image("forwarded-a"), text(separator), image("forwarded-b")];
      expect(prepareChatMessageRender({ role: "assistant", content }).displayMarkdown).toBe("");
      const draw = (isStreaming: boolean) =>
        render(
          renderGroupedMessage(
            prepareChatMessageRender({ role: "assistant", content }),
            "forwarded-images",
            {
              ...options,
              isStreaming,
              isForwarded: true,
              isUserMessageExpanded: () => false,
              onToggleUserMessageExpanded: vi.fn(),
            },
          ),
          container,
        );
      draw(true);
      const firstImage = container.querySelector("img");
      draw(false);
      expect(rows()).toEqual([["forwarded-a", "forwarded-b"]]);
      expect(container.querySelector(".chat-message-disclosure")).toBeNull();
      expect(container.querySelector("img")).toBe(firstImage);
    },
  );

  it.each([
    { name: "omitted", block: { type: "image", omitted: true, bytes: 100 } },
    { name: "expired", block: { type: "openclaw_pairing_qr", expiresAtMs: 1 } },
  ])("keeps $name notices between their image runs", ({ block }) => {
    for (const caption of ["", "Compare these images"]) {
      drawMessage([text(caption), image("a"), block, image("b")]);
      expect(rows()).toEqual([["a"], ["b"]]);
      const content = [...container.querySelectorAll("img, .chat-assistant-attachment-card")];
      expect(
        content.map((node) => (node instanceof HTMLImageElement ? node.alt : "notice")),
      ).toEqual(["a", "notice", "b"]);
    }
  });

  it("retains user grids and never mixes their lightbox gallery with assistant images", () => {
    drawTranscript([
      { role: "user", content: [image("user-a"), image("user-b")] },
      { role: "assistant", content: [image("assistant-a"), image("assistant-b")] },
    ]);
    expect(
      container
        .querySelector(".chat-group.user .chat-message-images--gallery")
        ?.querySelectorAll("img"),
    ).toHaveLength(2);
    expect(rows()).toEqual([
      ["user-a", "user-b"],
      ["assistant-a", "assistant-b"],
    ]);
  });
});
