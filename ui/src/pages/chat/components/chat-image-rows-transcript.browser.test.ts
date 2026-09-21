import { LitElement, html, nothing } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import "../../../test-helpers/load-styles.ts";
import { ChatStateController } from "../chat-state-controller.ts";
import {
  cancelChatScroll,
  handleChatScroll,
  handleChatScrollTakeover,
  scheduleCommittedChatScroll,
  type ChatScrollHost,
} from "../scroll.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import { ChatTranscriptController } from "./chat-transcript-controller.ts";
import type { TranscriptRow } from "./chat-transcript-layout.ts";
import { subscribeTranscriptScroll } from "./chat-transcript-scroll-events.ts";
import { CHAT_TRANSCRIPT_OVERSCAN } from "./chat-transcript-session.ts";

const images = Array.from({ length: 5 }, (_, index) => {
  const width = index % 2 ? 640 : 320;
  const height = index % 2 ? 360 : 480;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><title>Transcript image ${index}</title><rect width="100%" height="100%" fill="teal"/></svg>`;
  return {
    type: "image",
    url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    alt: `Transcript image ${index}`,
    width,
    height,
  };
});
function landscapeImages() {
  return Array.from({ length: 50 }, (_, index) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><title>Gallery image ${index + 1}</title><rect width="100%" height="100%" fill="teal"/></svg>`;
    return {
      type: "image",
      url: `data:image/svg+xml,${encodeURIComponent(svg)}`,
      alt: `Gallery image ${index + 1}`,
      width: 640,
      height: 360,
    };
  });
}

const text = (value: string) => ({ type: "text", text: value });
type Message = { key: string; content: unknown[]; streaming?: boolean; forwarded?: boolean };

function history(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `history-${index}`,
    content: [text(`Turn ${index}.\n\nThe reader can return to this conversation.`)],
  }));
}

// Match the existing end-follow browser fixture, but keep real messages, image
// resources, ResizeObserver measurements, and the pane-owned follow policy.
class ImageRowsTranscriptFixture extends LitElement {
  messages: Message[] = [];
  viewportHeight = 520;
  private readonly paneId = `image-rows-${crypto.randomUUID()}`;
  private readonly chatState = new ChatStateController(this);
  readonly policy: ChatScrollHost = {
    renderLifecycle: this.chatState.createRenderLifecycle(),
    chatLastScrollTop: 0,
    chatHasAutoScrolled: true,
    chatUserNearBottom: true,
    chatFollowLocked: false,
    chatReadingHistory: false,
    chatNewMessagesBelow: false,
    chatScrollElement: () => this.transcript.scrollElement,
    chatScrollToEnd: (options) => this.transcript.scrollToEnd(options),
    chatIsProgrammaticScroll: () => this.transcript.isProgrammaticScroll,
    chatIsMaintenanceScroll: () => this.transcript.isMaintenanceScroll,
  };
  readonly transcript = new ChatTranscriptController(this, {
    canFollowEnd: () => !this.policy.chatFollowLocked,
    onReaderScroll: (towardEnd) => handleChatScrollTakeover(this.policy, towardEnd),
    onViewportResize: () =>
      scheduleCommittedChatScroll(this.policy, false, false, { source: "resize" }),
  });

  override connectedCallback() {
    super.connectedCallback();
    this.policy.renderLifecycle = this.chatState.createRenderLifecycle();
  }

  protected override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    cancelChatScroll(this.policy);
    super.disconnectedCallback();
  }

  protected override render() {
    const rows: TranscriptRow<Message>[] = this.messages.map((message) => ({
      kind: "item",
      key: message.key,
      item: message,
    }));
    const messageKeys = new Map(this.messages.map(({ key }) => [key, key]));
    return html`
      <div class="chat" style="--chat-thread-max-width: 1000px">
        <div
          class="chat-thread chat-thread--direct"
          style=${`height: ${this.viewportHeight}px; flex: none`}
          @scroll=${(event: Event) => handleChatScroll(this.policy, event)}
        >
          ${this.transcript.renderSession(this.paneId, `agent:main:${this.paneId}`, (session) => {
            session.setContentReady(true);
            session.syncMessageRows(messageKeys, messageKeys);
            return session.render(
              rows,
              (entry) =>
                entry.kind === "item"
                  ? html`<div class="chat-group assistant">
                      <div class="chat-group-messages">
                        ${renderGroupedMessage(
                          prepareChatMessageRender({
                            role: "assistant",
                            content: entry.item.content,
                          }),
                          entry.key,
                          {
                            isStreaming: entry.item.streaming ?? false,
                            showReasoning: false,
                            isForwarded: entry.item.forwarded,
                            onToggleUserMessageExpanded: entry.item.forwarded
                              ? () => {}
                              : undefined,
                          },
                        )}
                      </div>
                    </div>`
                  : nothing,
              null,
              false,
            );
          })}
        </div>
      </div>
    `;
  }
}
customElements.define("test-image-rows-transcript", ImageRowsTranscriptFixture);

let fixture: ImageRowsTranscriptFixture | undefined;
afterEach(() => {
  fixture?.remove();
  fixture = undefined;
});

async function settleFrames() {
  // Real frames are the contract: CSS reflow -> ResizeObserver -> Lit/sizer
  // commit -> scroll compensation. Three pairs cross those stages without
  // polling geometry or replacing Chromium layout with mocked measurements.
  for (let index = 0; index < 3; index += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }
}

async function mount(messages: Message[], width = 1000) {
  await page.viewport(width, 900);
  const host = new ImageRowsTranscriptFixture();
  fixture = host;
  host.messages = messages;
  host.style.cssText = "display: block; width: 100%";
  document.body.append(host);
  await host.updateComplete;
  expect(host.transcript.scrollElement).toBe(thread(host));
  // The pane explicitly schedules initial content follow; the virtualizer does
  // not infer application-level follow from the first real image measurement.
  scheduleCommittedChatScroll(host.policy, false, false, { contentChanged: true });
  await settleFrames();
  expect(distanceFromEnd(host)).toBeLessThanOrEqual(1);
  return host;
}

function thread(host: ImageRowsTranscriptFixture) {
  return host.querySelector<HTMLElement>(".chat-thread")!;
}

function row(host: ImageRowsTranscriptFixture, key: string) {
  const element = host.querySelector<HTMLElement>(`[data-virtual-row-key="${key}"]`);
  expect(element, `mounted row ${key}`).not.toBeNull();
  return element!;
}

function distanceFromEnd(host: ImageRowsTranscriptFixture) {
  const element = thread(host);
  return element.scrollHeight - element.clientHeight - element.scrollTop;
}

function relativeTop(host: ImageRowsTranscriptFixture, element: HTMLElement) {
  return element.getBoundingClientRect().top - thread(host).getBoundingClientRect().top;
}

async function update(
  host: ImageRowsTranscriptFixture,
  change: () => void,
  contentChanged = false,
) {
  // Message delivery is a native task, like streaming input, not a timer or a
  // ResizeObserver microtask. Await Lit's owned commit before measuring layout.
  await new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.addEventListener(
      "message",
      () => {
        channel.port1.close();
        channel.port2.close();
        try {
          change();
          host.requestUpdate();
          resolve();
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      { once: true },
    );
    channel.port1.start();
    channel.port2.postMessage(null);
  });
  await host.updateComplete;
  if (contentChanged) {
    scheduleCommittedChatScroll(host.policy, false, false, { contentChanged: true });
  }
  await settleFrames();
}

async function positionReader(host: ImageRowsTranscriptFixture, element: HTMLElement, top = 80) {
  const viewport = thread(host);
  // Input cancels an outstanding reveal before subscribing, so its cancellation
  // cannot masquerade as completion of the reader's subsequent movement.
  viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
  const idle = Promise.withResolvers<void>();
  let readerScrolled = false;
  const unsubscribe = subscribeTranscriptScroll(viewport, (observation) => {
    if (observation.type !== "offset") {
      return;
    }
    // A prior maintenance scroll can publish idle before this native scroll
    // arrives. Only the reader's scrolling -> idle transition completes it.
    if (observation.scrolling && !observation.programmatic) {
      readerScrolled = true;
    } else if (readerScrolled && !observation.scrolling) {
      idle.resolve();
    }
  });
  try {
    await update(host, () => {
      const delta = relativeTop(host, element) - top;
      const before = viewport.scrollTop;
      viewport.scrollTop += delta;
      expect(viewport.scrollTop, "fixture must move before awaiting scroll idle").not.toBe(before);
    });
    // TanStack owns idle (including its browser fallback debounce). Its signal,
    // not a test sleep/poll or synthetic scrollend, releases backward scrolling.
    await idle.promise;
    await host.updateComplete;
    // Idle queues the owner's image-anchor capture in its next render frame.
    // A pair crosses that complete frame; a continuation inside its first rAF
    // could still precede another callback's capture (and ResizeObserver).
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  } finally {
    unsubscribe();
  }
  expect(Math.abs(relativeTop(host, element) - top)).toBeLessThanOrEqual(1);
}

async function readAt(host: ImageRowsTranscriptFixture, key: string) {
  expect(host.transcript.revealMessage(key)).toBe(true);
  await host.updateComplete;
  await settleFrames();
  await positionReader(host, row(host, key));
  expect(host.policy.chatFollowLocked).toBe(true);
}

async function decodeImages(root: ParentNode) {
  const elements = [...root.querySelectorAll<HTMLImageElement>("img.chat-message-image")];
  expect(elements.length).toBeGreaterThan(0);
  await Promise.all(elements.map((image) => image.decode()));
  for (const image of elements) {
    expect(image.complete).toBe(true);
    expect(image.naturalWidth).toBeGreaterThan(0);
  }
  return elements;
}

function expectRetainedImages(root: ParentNode, retained: HTMLImageElement[]) {
  const current = [...root.querySelectorAll<HTMLImageElement>("img.chat-message-image")];
  expect(current).toHaveLength(retained.length);
  for (const [index, image] of retained.entries()) {
    expect(current[index]).toBe(image);
    expect(image.complete).toBe(true);
    expect(image.naturalWidth).toBeGreaterThan(0);
  }
}

function expectAboveViewport(host: ImageRowsTranscriptFixture, element: HTMLElement) {
  // The virtualizer deliberately does not compensate a row that spans the fold:
  // bottom growth in that row must not move the content currently being read.
  expect(element.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    thread(host).getBoundingClientRect().top,
  );
}

function expectNoOverlap(host: ImageRowsTranscriptFixture) {
  const rows = [...host.querySelectorAll<HTMLElement>(".chat-virtual-row")];
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!;
    const current = rows[index]!;
    expect(Number(current.dataset.index)).toBeGreaterThan(Number(previous.dataset.index));
    expect(
      current.getBoundingClientRect().top,
      `${previous.dataset.virtualRowKey} precedes ${current.dataset.virtualRowKey}`,
    ).toBeGreaterThanOrEqual(previous.getBoundingClientRect().bottom - 1);
  }
  const viewport = thread(host).getBoundingClientRect();
  const visibleRows = rows.filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > viewport.top && rect.top < viewport.bottom;
  });
  expect(rows.length).toBeLessThanOrEqual(visibleRows.length + 2 * CHAT_TRANSCRIPT_OVERSCAN);
  expect(rows.length).toBeLessThan(host.messages.length);
  expect(thread(host).scrollWidth).toBeLessThanOrEqual(thread(host).clientWidth);
}

function expectImageFlow(element: HTMLElement, count: number, width: number) {
  const frames = [...element.querySelectorAll<HTMLElement>(".chat-image-frame")];
  expect(frames).toHaveLength(count);
  const rects = frames.map((frame) => frame.getBoundingClientRect());
  const first = rects[0]!;
  const second = rects[1]!;
  if (width === 1000) {
    expect(second.top).toBeCloseTo(first.top, 1);
    expect(second.left).toBeGreaterThanOrEqual(first.right);
  } else {
    expect(second.top).toBeGreaterThanOrEqual(first.bottom);
  }
  const bounds = element.getBoundingClientRect();
  for (const rect of rects) {
    expect(rect.right).toBeLessThanOrEqual(bounds.right + 1);
    expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
  }
}

describe("assistant image rows in the real transcript virtualizer", () => {
  it("does not anchor hidden images inside an above-reader forwarded disclosure", async () => {
    const messages = history(120);
    messages[59] = {
      key: "forwarded-gallery",
      forwarded: true,
      content: [text("A forwarded comparison."), ...landscapeImages().slice(0, 20)],
    };
    const host = await mount(messages);
    await readAt(host, "history-61");
    const forwarded = row(host, "forwarded-gallery");
    await decodeImages(forwarded);
    const content = forwarded.querySelector<HTMLElement>(".chat-message-disclosure__content")!;
    const gallery = forwarded.querySelector<HTMLElement>(".chat-message-images")!;
    expect(content).not.toBeNull();
    expect(content.getBoundingClientRect().bottom).toBeLessThan(
      thread(host).getBoundingClientRect().top,
    );
    expect(gallery.getBoundingClientRect().bottom).toBeGreaterThan(
      thread(host).getBoundingClientRect().top,
    );
    const frames = [...gallery.querySelectorAll<HTMLElement>(".chat-image-frame")];
    expect(frames).toHaveLength(20);
    expect(frames[0]!.getBoundingClientRect().top).toBe(frames[1]!.getBoundingClientRect().top);
    const reader = row(host, "history-61");
    const before = relativeTop(host, reader);
    for (const width of [600, 1000]) {
      await update(host, () => {
        host.style.width = `${width}px`;
      });
      if (width === 600) {
        expect(frames[1]!.getBoundingClientRect().top).toBeGreaterThan(
          frames[0]!.getBoundingClientRect().bottom,
        );
      } else {
        expect(frames[0]!.getBoundingClientRect().top).toBe(frames[1]!.getBoundingClientRect().top);
      }
      expect(Math.abs(relativeTop(host, reader) - before)).toBeLessThanOrEqual(1);
      expect(host.policy.chatFollowLocked).toBe(true);
    }
  });
  it.each(["append", "prepend"] as const)(
    "keeps the visible image when a message %s commits during width reflow",
    async (change) => {
      const content = Array.from({ length: 50 }, (_, index) => ({
        ...images[1]!,
        alt: `Projection image ${index}`,
      }));
      const host = await mount([{ key: "projection-gallery", content }], 1200);
      await update(host, () => {
        host.style.width = "1000px";
      });
      const gallery = row(host, "projection-gallery");
      const decoded = await decodeImages(gallery);
      const image = decoded[20]!;
      await positionReader(host, image);
      await update(host, () => {
        host.style.width = "600px";
        const message = { key: "other-message", content: [text("Another message")] };
        host.messages =
          change === "append" ? [...host.messages, message] : [message, ...host.messages];
      });
      expect(Math.abs(relativeTop(host, image) - 80)).toBeLessThanOrEqual(1);
      expectRetainedImages(gallery, decoded);
      expect(host.policy.chatFollowLocked).toBe(true);
    },
  );
  it("keeps text below an image run in the same message anchored through reflow", async () => {
    const content = [
      ...Array.from({ length: 20 }, () => images[1]!),
      text(Array.from({ length: 30 }, (_, index) => `Reader paragraph ${index}.`).join("\n\n")),
    ];
    const host = await mount([{ key: "captioned", content }], 1200);
    await update(host, () => {
      host.style.width = "1000px";
    });
    const message = row(host, "captioned");
    await decodeImages(message);
    const paragraph = [...message.querySelectorAll("p")].find(
      (element) => element.textContent === "Reader paragraph 10.",
    )!;
    const viewport = thread(host);
    await positionReader(host, paragraph);
    const before = relativeTop(host, paragraph);
    expect(Math.abs(before - 80)).toBeLessThanOrEqual(1);
    expect(
      message.querySelector(".chat-message-images")!.getBoundingClientRect().bottom,
    ).toBeLessThan(viewport.getBoundingClientRect().top);
    for (const width of [600, 1000]) {
      await update(host, () => {
        host.style.width = `${width}px`;
      });
      expect(
        Math.abs(relativeTop(host, paragraph) - before),
        `paragraph at ${width}px`,
      ).toBeLessThanOrEqual(1);
      expect(paragraph.isConnected).toBe(true);
      expect(host.policy.chatFollowLocked).toBe(true);
    }
  });
  it("keeps the mostly visible tall image instead of anchoring the following flex row", async () => {
    const content = Array.from({ length: 50 }, (_, index) => ({
      ...images[index % 2]!,
      alt: `Mixed image ${index}`,
    }));
    const host = await mount([{ key: "mixed-gallery", content }], 1200);
    await update(host, () => {
      host.style.width = "850px";
    });
    const gallery = row(host, "mixed-gallery");
    const decoded = await decodeImages(gallery);
    const image = decoded[20]!;
    const viewport = thread(host);
    await positionReader(host, image, -60);
    const before = relativeTop(host, image);
    expect(image.getBoundingClientRect().left).toBe(decoded[0]!.getBoundingClientRect().left);
    expect(Math.abs(before + 60)).toBeLessThanOrEqual(1);
    expect(image.getBoundingClientRect().bottom - viewport.getBoundingClientRect().top).toBe(300);
    for (const width of [600, 850]) {
      await update(host, () => {
        host.style.width = `${width}px`;
      });
      expect(
        Math.abs(relativeTop(host, image) - before),
        `tall image at ${width}px`,
      ).toBeLessThanOrEqual(1);
      expectRetainedImages(gallery, decoded);
      expect(host.policy.chatFollowLocked).toBe(true);
    }
  });
  it.each([
    { from: 1000, to: 600, imageNumber: 21 },
    { from: 600, to: 1000, imageNumber: 21 },
    { from: 1000, to: 600, imageNumber: 45 },
    { from: 600, to: 1000, imageNumber: 45 },
  ])(
    "keeps image $imageNumber visible when a 50-image message reflows from $from px to $to px",
    async ({ from, to, imageNumber }) => {
      const galleryImages = landscapeImages();
      const host = await mount([{ key: "long-gallery", content: galleryImages }], 1200);
      // Change the pane, not the browser viewport: this also exercises sidebar and
      // split-pane resizes while all responsive media queries stay unchanged.
      await update(host, () => {
        host.style.width = `${from}px`;
      });
      const gallery = row(host, "long-gallery");
      const decoded = await decodeImages(gallery);
      expect(decoded).toHaveLength(50);
      const frames = [...gallery.querySelectorAll<HTMLElement>(".chat-image-frame")];
      expectImageFlow(gallery, 50, from);
      for (const frame of frames) {
        expect(frame.getBoundingClientRect().width).toBe(400);
      }
      expect(frames[2]!.getBoundingClientRect().top).toBeGreaterThan(
        frames[0]!.getBoundingClientRect().bottom,
      );
      const image = decoded[imageNumber - 1]!;
      const viewport = thread(host);
      await positionReader(host, image);
      expect(host.policy.chatFollowLocked).toBe(true);
      expect(viewport.getBoundingClientRect().width).toBe(from);
      expect(gallery.getBoundingClientRect().top).toBeLessThan(
        viewport.getBoundingClientRect().top,
      );
      expect(gallery.getBoundingClientRect().bottom).toBeGreaterThan(
        viewport.getBoundingClientRect().bottom,
      );
      const before = {
        imageTop: relativeTop(host, image),
        rowTop: relativeTop(host, gallery),
        scrollTop: viewport.scrollTop,
        rowHeight: gallery.offsetHeight,
      };
      await update(host, () => {
        host.style.width = `${to}px`;
      });
      expect(viewport.getBoundingClientRect().width).toBe(to);
      expectRetainedImages(gallery, decoded);
      expect(row(host, "long-gallery")).toBe(gallery);
      expectImageFlow(gallery, 50, to);
      for (const frame of frames) {
        expect(frame.getBoundingClientRect().width).toBe(400);
      }
      const after = {
        imageTop: relativeTop(host, image),
        rowTop: relativeTop(host, gallery),
        scrollTop: viewport.scrollTop,
        rowHeight: gallery.offsetHeight,
      };
      expect(
        Math.abs(after.imageTop - before.imageTop),
        JSON.stringify({ before, after }),
      ).toBeLessThanOrEqual(1);
      expect(image.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        viewport.getBoundingClientRect().bottom,
      );
      expect(host.policy.chatFollowLocked).toBe(true);
      await update(host, () => {
        host.style.width = `${from}px`;
      });
      expectRetainedImages(gallery, decoded);
      expect(Math.abs(relativeTop(host, image) - before.imageTop)).toBeLessThanOrEqual(1);
    },
  );

  it.each(["native", "wheel", "touch"] as const)(
    "yields a cached image anchor to %s input during resize and still follows a manual end command",
    async (input) => {
      const host = await mount([{ key: "takeover-gallery", content: landscapeImages() }], 1200);
      await update(host, () => {
        host.style.width = "1000px";
      });
      const gallery = row(host, "takeover-gallery");
      const decoded = await decodeImages(gallery);
      await positionReader(host, decoded[20]!);
      const viewport = thread(host);
      const before = viewport.scrollTop;
      const touch = new Touch({ identifier: 1, target: viewport, clientX: 100, clientY: 200 });
      await update(host, () => {
        if (input === "wheel") {
          viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 64 }));
        }
        if (input === "touch") {
          viewport.dispatchEvent(
            new TouchEvent("touchstart", { touches: [touch], changedTouches: [touch] }),
          );
        }
        viewport.scrollTop += 64;
        host.style.width = "600px";
      });
      expect(viewport.scrollTop).toBe(before + 64);
      expect(host.policy.chatFollowLocked).toBe(true);
      expectRetainedImages(gallery, decoded);
      if (input === "touch") {
        viewport.dispatchEvent(
          new TouchEvent("touchend", { touches: [], changedTouches: [touch] }),
        );
      }
      scheduleCommittedChatScroll(host.policy, false, false, { source: "manual" });
      await settleFrames();
      expect(distanceFromEnd(host)).toBeLessThanOrEqual(1);
      await update(host, () => {
        host.style.width = "1000px";
      });
      expect(distanceFromEnd(host)).toBeLessThanOrEqual(1);
      expect(host.policy.chatFollowLocked).toBe(false);
    },
  );

  it("holds the reader below wrapping images through 1000/390/320px and height resizes", async () => {
    const messages = history(120);
    messages[59] = { key: "gallery", content: images.slice(0, 4) };
    const host = await mount(messages);
    await readAt(host, "history-61");
    const gallery = row(host, "gallery");
    const decoded = await decodeImages(gallery);
    const anchor = row(host, "history-61");
    const anchorTop = relativeTop(host, anchor);
    const wideHeight = gallery.offsetHeight;
    expectAboveViewport(host, gallery);
    expectNoOverlap(host);
    expectImageFlow(gallery, 4, 1000);
    for (const width of [390, 320, 1000]) {
      await page.viewport(width, 900);
      await settleFrames();
      expect(row(host, "history-61")).toBe(anchor);
      expect(
        Math.abs(relativeTop(host, anchor) - anchorTop),
        `reader anchor after width ${width}`,
      ).toBeLessThanOrEqual(1);
      expectAboveViewport(host, gallery);
      expectImageFlow(gallery, 4, width);
      if (width !== 1000) {
        expect(gallery.offsetHeight).toBeGreaterThan(wideHeight);
      }
      expectRetainedImages(gallery, decoded);
      expectNoOverlap(host);
    }
    for (const height of [360, 640, 520]) {
      await update(host, () => {
        host.viewportHeight = height;
      });
      expect(
        Math.abs(relativeTop(host, anchor) - anchorTop),
        `reader anchor after height ${height}`,
      ).toBeLessThanOrEqual(1);
      expect(host.policy.chatFollowLocked).toBe(true);
      expectNoOverlap(host);
    }
  });

  it("follows the measured end through wrapping, viewport height changes, and same-key live growth", async () => {
    const host = await mount([
      ...history(80),
      { key: "live", content: images.slice(0, 1), streaming: true },
    ]);
    const live = row(host, "live");
    const [first] = await decodeImages(live);
    for (const content of [
      images.slice(0, 4),
      [...images.slice(0, 4), text("Images above; more follow below."), images[4]!],
    ]) {
      const previousHeight = live.offsetHeight;
      await update(
        host,
        () => {
          host.messages = [
            ...host.messages.slice(0, -1),
            { key: "live", content, streaming: true },
          ];
        },
        true,
      );
      expect(row(host, "live")).toBe(live);
      expect(live.querySelector("img.chat-message-image")).toBe(first);
      expect(live.offsetHeight).toBeGreaterThan(previousHeight);
      await decodeImages(live);
      expect(distanceFromEnd(host)).toBeLessThanOrEqual(1);
      expectNoOverlap(host);
    }
    expect(live.querySelectorAll(".chat-message-images")).toHaveLength(2);
    const caption = live.querySelector<HTMLElement>(".chat-text > p")!;
    const groups = [...live.querySelectorAll<HTMLElement>(".chat-message-images")];
    expect(caption.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      groups[0]!.getBoundingClientRect().bottom,
    );
    expect(groups[1]!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      caption.getBoundingClientRect().bottom,
    );
    const decoded = await decodeImages(live);
    for (const width of [390, 320, 1000]) {
      await page.viewport(width, 900);
      await settleFrames();
      expect(distanceFromEnd(host), `end after width ${width}`).toBeLessThanOrEqual(1);
      expectRetainedImages(live, decoded);
      expectImageFlow(groups[0]!, 4, width);
      expectNoOverlap(host);
    }
    for (const height of [360, 640, 520]) {
      await update(host, () => {
        host.viewportHeight = height;
      });
      expect(distanceFromEnd(host), `end after height ${height}`).toBeLessThanOrEqual(1);
      expect(host.policy.chatFollowLocked).toBe(false);
    }
    await update(
      host,
      () => {
        host.messages = [
          ...host.messages.slice(0, -1),
          { ...host.messages.at(-1)!, streaming: false },
          { key: "successor", content: [text("The next message remains below every image.")] },
        ];
      },
      true,
    );
    expect(row(host, "successor").getBoundingClientRect().top).toBeGreaterThanOrEqual(
      live.getBoundingClientRect().bottom - 1,
    );
    expect(live.querySelector("img.chat-message-image")).toBe(first);
    expect(distanceFromEnd(host)).toBeLessThanOrEqual(1);
    expectNoOverlap(host);
  });

  it("compensates same-key image growth above a reader without following or overlapping its successor", async () => {
    const messages = history(100);
    messages[49] = { key: "growing", content: images.slice(0, 1), streaming: true };
    const host = await mount(messages, 390);
    await readAt(host, "history-51");
    const growing = row(host, "growing");
    const [first] = await decodeImages(growing);
    const anchor = row(host, "history-51");
    const before = relativeTop(host, anchor);
    const oldHeight = growing.offsetHeight;
    expectAboveViewport(host, growing);
    expectNoOverlap(host);
    await update(
      host,
      () => {
        host.messages = host.messages.map((message) =>
          message.key === "growing"
            ? {
                ...message,
                content: [...images.slice(0, 3), text("A caption between image runs."), images[3]!],
              }
            : message,
        );
      },
      true,
    );
    expectAboveViewport(host, growing);
    expect(growing.offsetHeight).toBeGreaterThan(oldHeight);
    expect(growing.querySelector("img.chat-message-image")).toBe(first);
    expect(Math.abs(relativeTop(host, anchor) - before)).toBeLessThanOrEqual(1);
    expect(host.policy.chatFollowLocked).toBe(true);
    expect(distanceFromEnd(host)).toBeGreaterThan(thread(host).clientHeight);
    await decodeImages(growing);
    expectNoOverlap(host);
  });

  it("does not move the image being read when its same-key row grows below the fold", async () => {
    const messages = history(100);
    messages[49] = { key: "reading-images", content: images.slice(0, 4), streaming: true };
    const host = await mount(messages, 390);
    await readAt(host, "reading-images");
    const reading = row(host, "reading-images");
    const decoded = await decodeImages(reading);
    const firstFrame = reading.querySelector<HTMLElement>(".chat-image-frame")!;
    // The gesture puts the first image across the fold. Unlike growth wholly
    // above it, appended images below this point must not compensate scrollTop.
    await update(host, () => {
      thread(host).scrollTop += 160;
    });
    expect(reading.getBoundingClientRect().top).toBeLessThan(
      thread(host).getBoundingClientRect().top,
    );
    expect(reading.getBoundingClientRect().bottom).toBeGreaterThan(
      thread(host).getBoundingClientRect().bottom,
    );
    const before = relativeTop(host, firstFrame);
    const previousHeight = reading.offsetHeight;
    await update(
      host,
      () => {
        host.messages = host.messages.map((message) =>
          message.key === "reading-images"
            ? {
                ...message,
                content: [
                  ...images.slice(0, 4),
                  text("This arrives below the image being read."),
                  images[4]!,
                ],
              }
            : message,
        );
      },
      true,
    );
    expect(reading.offsetHeight).toBeGreaterThan(previousHeight);
    expect(Math.abs(relativeTop(host, firstFrame) - before)).toBeLessThanOrEqual(1);
    expect(host.policy.chatFollowLocked).toBe(true);
    const imageGroups = [...reading.querySelectorAll<HTMLElement>(".chat-message-images")];
    expect(imageGroups).toHaveLength(2);
    expectRetainedImages(imageGroups[0]!, decoded);
    expectNoOverlap(host);
  });

  it("unmounts distant image rows and remeasures decoded remounts at the new width with bounded DOM", async () => {
    const messages = history(240);
    messages[119] = { key: "remount-gallery", content: images.slice(0, 4) };
    const host = await mount(messages);
    await readAt(host, "history-121");
    const original = row(host, "remount-gallery");
    const decoded = await decodeImages(original);
    const originalHeight = original.offsetHeight;
    expectAboveViewport(host, original);
    expectNoOverlap(host);
    await readAt(host, "history-10");
    expect(host.querySelector('[data-virtual-row-key="remount-gallery"]')).toBeNull();
    expect(original.isConnected).toBe(false);
    expect(decoded.every((image) => !image.isConnected)).toBe(true);
    await page.viewport(320, 900);
    await settleFrames();
    expectNoOverlap(host);
    await readAt(host, "history-121");
    const remounted = row(host, "remount-gallery");
    expect(remounted).not.toBe(original);
    const redecoded = await decodeImages(remounted);
    expect(redecoded.map((image) => image.currentSrc)).toEqual(
      decoded.map((image) => image.currentSrc),
    );
    expect(redecoded.every((image, index) => image !== decoded[index])).toBe(true);
    expect(remounted.offsetHeight).toBeGreaterThan(originalHeight);
    expectImageFlow(remounted, 4, 320);
    expectNoOverlap(host);
    const anchor = row(host, "history-121");
    const before = relativeTop(host, anchor);
    expectAboveViewport(host, remounted);
    await page.viewport(1000, 900);
    await settleFrames();
    expect(Math.abs(relativeTop(host, anchor) - before)).toBeLessThanOrEqual(1);
    expectRetainedImages(remounted, redecoded);
    expectImageFlow(remounted, 4, 1000);
    expectNoOverlap(host);
  });
});
