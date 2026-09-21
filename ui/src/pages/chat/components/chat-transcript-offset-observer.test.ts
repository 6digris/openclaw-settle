/* @vitest-environment jsdom */
import { VirtualizerController } from "@tanstack/lit-virtual";
import { afterEach, expect, it, vi } from "vitest";
import {
  createTranscriptOffsetState,
  isTranscriptProgrammaticScroll,
  observeTranscriptOffset,
  scrollTranscriptOffset,
} from "./chat-transcript-offset-observer.ts";
import { TranscriptPrependAnchor } from "./chat-transcript-prepend-anchor.ts";

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

it.each([false, true])(
  "preserves above-reader compensation unless native input takes over=%s",
  (readerMovesBackward) => {
    vi.useFakeTimers();
    const scroller = document.body.appendChild(document.createElement("div"));
    Object.defineProperties(scroller, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 2000 },
    });
    scroller.scrollTop = 1000;
    scroller.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
      // At DPR1 the browser rounds the fractional layout correction to its
      // physical scroll offset; TanStack retains the unrounded target first.
      scroller.scrollTop = Math.round(typeof options === "number" ? (y ?? 0) : (options?.top ?? 0));
    };
    const state = createTranscriptOffsetState();
    const owner = {
      state,
      getScrollElement: () => scroller,
      prependAnchor: new TranscriptPrependAnchor(),
      isProgrammaticScroll: () => isTranscriptProgrammaticScroll(state, scroller),
      cancelScroll: vi.fn(),
      requestUpdate: vi.fn(),
      onReaderScroll: vi.fn(),
    };
    const controller = new VirtualizerController<HTMLDivElement, HTMLElement>(
      {
        addController: vi.fn(),
        removeController: vi.fn(),
        requestUpdate: vi.fn(),
        updateComplete: Promise.resolve(true),
      },
      {
        count: 4,
        estimateSize: () => 500,
        initialOffset: 1000,
        getScrollElement: () => scroller,
        observeElementRect: (_, callback) => {
          callback({ width: 800, height: 400 });
        },
        observeElementOffset: (instance, callback) =>
          observeTranscriptOffset(owner, instance, callback),
        scrollToFn: (offset, options, instance) =>
          scrollTranscriptOffset(state, offset, options, instance),
      },
    );
    controller.hostConnected();
    controller.hostUpdated();
    const instance = controller.getVirtualizer();
    try {
      instance.getVirtualItems();
      // Prime a measured row, then let a resize move the reader backward.
      instance.resizeItem(0, 501.875);
      scroller.dispatchEvent(new Event("scroll"));
      instance.resizeItem(0, 401);
      scroller.dispatchEvent(new Event("scroll"));
      expect(scroller.scrollTop).toBe(901);
      if (readerMovesBackward) {
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
        scroller.scrollTop -= 40;
        scroller.dispatchEvent(new Event("scroll"));
      }
      // No idle timer has elapsed: maintenance must not suppress this resize,
      // while a real backward gesture still owns its native position.
      instance.resizeItem(0, 301);
      expect(scroller.scrollTop).toBe(readerMovesBackward ? 861 : 801);
    } finally {
      controller.hostDisconnected();
    }
  },
);
