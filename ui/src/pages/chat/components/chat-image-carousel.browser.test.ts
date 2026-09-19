import { Virtualizer } from "@tanstack/virtual-core";
import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupMessages } from "../chat-thread-grouping.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { ChatMessageReveal } from "./chat-message-reveal.ts";
import baseCss from "../../../styles/base.css?inline";
import groupedCss from "../../../styles/chat/grouped.css?inline";
import messageCss from "../../../styles/chat/message-layout.css?inline";
import startupCss from "../../../styles/chat/startup-layout.css?inline";
import textCss from "../../../styles/chat/text.css?inline";

const container = document.createElement("section");
const images = Array.from({ length: 50 }, (_, index) => {
  const width = index % 2 ? 640 : 320;
  const height = index % 2 ? 360 : 480;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><title>Image ${index}</title><rect width="100%" height="100%" fill="teal"/></svg>`;
  return {
    type: "image",
    url: "data:image/svg+xml," + encodeURIComponent(svg),
    alt: "Image " + index,
    width,
    height,
  };
});

function draw(count: number, width: number, direction = "ltr") {
  document.body.append(container);
  container.style.width = width + "px";
  return render(
    html`<style>
        ${baseCss}${startupCss}${messageCss}${textCss}
      </style>
      <div class="chat-group assistant" dir=${direction}>
        <div class="chat-group-messages">
          ${renderGroupedMessage(prepareChatMessageRender({ role: "assistant", content: images.slice(0, count) }), "gallery", { isStreaming: false, showReasoning: false })}
        </div>
      </div>`,
    container,
  );
}

function gallery() {
  const root = container.querySelector<HTMLElement>(".chat-image-carousel")!;
  return {
    root,
    viewport: root.querySelector<HTMLElement>(".chat-image-carousel__viewport")!,
  };
}

async function expectEdges(left: boolean, right: boolean) {
  await vi.waitFor(() => {
    const { root, viewport } = gallery();
    expect(root.hasAttribute("data-scroll-left")).toBe(left);
    expect(root.hasAttribute("data-scroll-right")).toBe(right);
    expect(getComputedStyle(viewport).maskImage === "none").toBe(!left && !right);
    expect(getComputedStyle(viewport).scrollbarWidth).not.toBe("none");
  });
}

afterEach(() => {
  render(nothing, container);
  container.remove();
});

describe("image carousel layout and navigation", () => {
  it.each([320, 390, 1000])(
    "keeps fifty images in one locally scrolling row at %i px",
    async (width) => {
      draw(50, width);
      await expectEdges(false, true);
      const { root, viewport } = gallery();
      const frames = [...root.querySelectorAll<HTMLElement>(".chat-image-frame")];
      const bounds = frames.map((frame) => frame.getBoundingClientRect());
      expect(frames).toHaveLength(50);
      expect(
        Math.max(...bounds.map((rect) => rect.top)) - Math.min(...bounds.map((rect) => rect.top)),
      ).toBeLessThan(1);
      expect(container.scrollWidth).toBeLessThanOrEqual(width);
      expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);
      expect(bounds.every((rect) => rect.width > 100 && rect.height > 100)).toBe(true);
      for (const [index, rect] of bounds.entries()) {
        expect(rect.width / rect.height).toBeCloseTo(
          images[index]!.width / images[index]!.height,
          2,
        );
      }
      viewport.focus();
      viewport.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
      );
      await expectEdges(true, true);
      viewport.focus();
      viewport.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
      );
      await expectEdges(true, false);
      const last = frames.at(-1)!.getBoundingClientRect();
      expect(last.right).toBeLessThanOrEqual(viewport.getBoundingClientRect().right + 1);
      viewport.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
      );
      await expectEdges(false, true);
      expect(document.activeElement).toBe(viewport);
    },
  );

  it("recomputes edges on append, resize, and retained-part reconnection", async () => {
    const part = draw(1, 1000);
    await expectEdges(false, false);
    const first = container.querySelector("img");
    draw(3, 390);
    await expectEdges(false, true);
    expect(container.querySelector("img")).toBe(first);
    container.style.width = "1600px";
    await expectEdges(false, false);
    expect(gallery().viewport.tabIndex).toBe(-1);
    part.setConnected(false);
    container.style.width = "320px";
    part.setConnected(true);
    await expectEdges(false, true);
    expect(container.scrollWidth).toBeLessThanOrEqual(320);
  });

  it("keeps separate message targets reachable when a reply reveals an offscreen image", async () => {
    document.body.append(container);
    container.style.width = "390px";
    const groups = groupMessages(
      images.slice(0, 5).map((image, index) => ({
        kind: "message",
        key: "message-" + index,
        message: {
          role: "assistant",
          content: [image],
          __openclaw: { id: "image-" + index, seq: index + 1 },
        },
      })),
    );
    render(
      html`<style>
          ${baseCss}${startupCss}${messageCss}${textCss}${groupedCss}
        </style>
        <div class="chat-thread">
          ${groups.map((group) => (group.kind === "group" ? renderMessageGroup(group, { showReasoning: false }) : nothing))}
        </div>`,
      container,
    );
    await expectEdges(false, true);
    const { root, viewport } = gallery();
    const bubbles = [...root.querySelectorAll<HTMLElement>(".chat-bubble")];
    expect(bubbles).toHaveLength(5);
    expect(new Set(bubbles.map((bubble) => bubble.getBoundingClientRect().top)).size).toBe(1);
    expect(container.scrollWidth).toBeLessThanOrEqual(390);
    const scroller = container.querySelector<HTMLDivElement>(".chat-thread")!;
    const virtualizer = new Virtualizer<HTMLDivElement, HTMLElement>({
      count: 1,
      getScrollElement: () => scroller,
      estimateSize: () => 220,
      scrollToFn: vi.fn(),
      observeElementRect: () => {},
      observeElementOffset: () => {},
    });
    virtualizer.scrollElement = scroller;
    const reveal = new ChatMessageReveal();
    try {
      expect(
        reveal.reveal(container, { messageId: "image-4", behavior: "auto" }, virtualizer),
      ).toBe(true);
      await expectEdges(true, false);
      const last = bubbles.at(-1)!;
      expect(last.getBoundingClientRect().right).toBeLessThanOrEqual(
        viewport.getBoundingClientRect().right + 1,
      );
      expect(last.classList.contains("chat-bubble--reply-target")).toBe(true);
    } finally {
      reveal.clear();
    }
  });

  it("keeps physical edge fades correct in right-to-left content", async () => {
    draw(6, 390, "rtl");
    // The pure-media Markdown owner detects no RTL caption, so its default is LTR.
    const { viewport } = gallery();
    viewport.dir = "rtl";
    viewport.scrollLeft = 0;
    viewport.dispatchEvent(new Event("scroll"));
    await expectEdges(true, false);
    viewport.focus();
    viewport.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    );
    await expectEdges(false, true);
    viewport.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
    );
    await expectEdges(true, false);
  });
});
