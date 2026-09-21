/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderHoverMarquee } from "./hover-marquee.ts";

let container: HTMLDivElement;
let resize: () => void;
let observed: Set<Element>;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"],
  });
  observed = new Set();
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resize = () => callback([], this);
      }
      observe(target: Element) {
        observed.add(target);
      }
      unobserve(target: Element) {
        observed.delete(target);
      }
      disconnect() {
        observed.clear();
      }
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  render(nothing, container);
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("avoids style resolution at zero width and resumes through the existing resize observer", () => {
  render(
    html`<a class="session-row-host" href="#session">
      ${renderHoverMarquee("A title wider than its viewport", "session-name")}
    </a>`,
    container,
  );
  const host = container.querySelector<HTMLAnchorElement>("a")!;
  const label = container.querySelector<HTMLElement>(".hover-marquee")!;
  const text = label.querySelector<HTMLElement>(".hover-marquee__text")!;
  let width = 0;
  Object.defineProperty(label, "clientWidth", { get: () => width });
  Object.defineProperty(text, "scrollWidth", { value: 220 });
  label.style.cssText =
    "white-space: nowrap; padding: 0px; direction: ltr; --hover-marquee-fade-width: 0px";
  text.style.transform = "none";
  const nativeStyle = globalThis.getComputedStyle;
  const style = vi
    .spyOn(globalThis, "getComputedStyle")
    .mockImplementation((element, pseudo) =>
      element === label
        ? label.style
        : element === text
          ? text.style
          : nativeStyle(element, pseudo),
    );
  const expectNoLabelStyleRead = () =>
    expect(style.mock.calls.filter(([element]) => element === label)).toEqual([]);
  const expectResting = () => {
    expect(label.classList.contains("hover-marquee--overflowing")).toBe(false);
    expect(label.classList.contains("hover-marquee--scrolling")).toBe(false);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).toBe("");
    expect(label.style.getPropertyValue("--hover-marquee-duration")).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  };
  host.focus();
  // Reused jsdom windows retain mouse modality from earlier files.
  host.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(document.activeElement).toBe(host);
  expect(host.matches(":focus-visible")).toBe(true);
  vi.advanceTimersToNextFrame();
  expect(observed).toEqual(new Set([label, text]));
  expectResting();
  expectNoLabelStyleRead();

  for (const revealBeforeHiding of [false, true]) {
    width = 100;
    resize();
    vi.advanceTimersToNextFrame();
    expect(label.classList.contains("hover-marquee--overflowing")).toBe(true);
    expect(label.style.getPropertyValue("--hover-marquee-shift")).not.toBe("");
    expect(label.style.getPropertyValue("--hover-marquee-duration")).not.toBe("");
    expect(vi.getTimerCount()).toBe(1);
    if (revealBeforeHiding) {
      vi.advanceTimersByTime(500);
      expect(label.classList.contains("hover-marquee--scrolling")).toBe(true);
    }
    style.mockClear();
    width = 0;
    resize();
    vi.advanceTimersToNextFrame();
    expectResting();
    vi.advanceTimersByTime(500);
    expectResting();
    expectNoLabelStyleRead();
  }
});
