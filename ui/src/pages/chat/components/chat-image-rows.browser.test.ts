import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import "../../../test-helpers/load-styles.ts";

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

function draw(content: typeof images, width: number) {
  document.body.append(container);
  container.style.width = width + "px";
  render(
    html`<div class="chat-group assistant" style=${"--chat-message-max-width: " + width + "px"}>
      <div class="chat-group-messages">
        ${renderGroupedMessage(prepareChatMessageRender({ role: "assistant", content }), "images", { isStreaming: false, showReasoning: false })}
      </div>
    </div>`,
    container,
  );
}

afterEach(() => {
  render(nothing, container);
  container.remove();
});

describe("wrapping assistant image rows", () => {
  it.each([320, 390, 1000])(
    "keeps fifty normal-size images in the vertical flow at %i px",
    (width) => {
      draw(images, width);
      const frames = [...container.querySelectorAll<HTMLElement>(".chat-image-frame")];
      const boxes = frames.map((frame) => frame.getBoundingClientRect());
      const row = container.querySelector<HTMLElement>(".chat-message-images")!;
      expect(frames).toHaveLength(50);
      expect(boxes[0]!.height).toBeCloseTo(360, 1);
      if (width === 1000) {
        expect(boxes[1]!.top).toBeCloseTo(boxes[0]!.top, 1);
        expect(boxes[1]!.width).toBeCloseTo(400, 1);
      } else {
        expect(boxes[1]!.top).toBeGreaterThanOrEqual(boxes[0]!.bottom);
      }
      for (const [index, box] of boxes.entries()) {
        expect(box.width / box.height).toBeCloseTo(images[index]!.width / images[index]!.height, 2);
        expect(box.right).toBeLessThanOrEqual(row.getBoundingClientRect().right + 1);
      }
      expect(new Set(boxes.map((box) => box.top)).size).toBeGreaterThan(1);
      expect(boxes.at(-1)!.bottom).toBeLessThanOrEqual(row.getBoundingClientRect().bottom + 1);
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      expect(container.scrollWidth).toBeLessThanOrEqual(width + 1);
    },
  );

  it("wraps instead of shrinking two 400px previews when their normal sizes do not fit", () => {
    const pair = [images[1]!, images[3]!];
    draw(pair, 900);
    const frames = [...container.querySelectorAll<HTMLElement>(".chat-image-frame")];
    const before = frames.map((frame) => frame.getBoundingClientRect());
    expect(before[0]!.width).toBe(400);
    expect(before[1]!.width).toBe(400);
    expect(before[0]!.top).toBe(before[1]!.top);
    container.style.width = "800px";
    const after = frames.map((frame) => frame.getBoundingClientRect());
    expect(after[0]!.width).toBe(400);
    expect(after[1]!.width).toBe(400);
    expect(after[1]!.top).toBeGreaterThanOrEqual(after[0]!.bottom);
  });

  it("retains decoded images and normal preview geometry while the row grows and wraps", async () => {
    draw(images.slice(0, 1), 1000);
    const first = container.querySelector("img")!;
    await first.decode();
    const before = first.getBoundingClientRect();
    draw(images.slice(0, 3), 1000);
    expect(container.querySelector("img")).toBe(first);
    expect(first.getBoundingClientRect().width).toBe(before.width);
    expect(first.getBoundingClientRect().height).toBe(before.height);
    container.style.width = "390px";
    await vi.waitFor(() => {
      const frames = container.querySelectorAll<HTMLElement>(".chat-image-frame");
      expect(frames[1]!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        frames[0]!.getBoundingClientRect().bottom,
      );
      expect(container.scrollWidth).toBeLessThanOrEqual(390);
    });
  });
});
