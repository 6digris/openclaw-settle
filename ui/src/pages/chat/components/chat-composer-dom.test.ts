/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("keeps an empty one-row editor CSS-sized without reading conversation geometry", () => {
  const chat = document.body.appendChild(document.createElement("section"));
  chat.className = "chat";
  const thread = chat.appendChild(document.createElement("div"));
  thread.className = "chat-thread";
  const textarea = chat.appendChild(document.createElement("textarea"));
  textarea.rows = 1;
  const measure = vi.fn(() => 42);
  for (const element of [thread, textarea]) {
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, get: measure },
      clientHeight: { configurable: true, get: measure },
    });
  }
  const computedStyle = vi.spyOn(globalThis, "getComputedStyle");
  adjustTextareaHeight(textarea);
  adjustTextareaHeight(textarea);
  expect(textarea.style.height).toBe("");
  expect(measure).not.toHaveBeenCalled();
  expect(computedStyle).not.toHaveBeenCalled();
});

it.each([true, false])(
  "clears a tall draft without losing the reader's end ownership=%s",
  (atEnd) => {
    const chat = document.body.appendChild(document.createElement("section"));
    chat.className = "chat";
    const thread = chat.appendChild(document.createElement("div"));
    thread.className = "chat-thread";
    const textarea = chat.appendChild(document.createElement("textarea"));
    textarea.rows = 1;
    textarea.style.height = "150px";
    textarea.style.overflowY = "auto";
    textarea.setAttribute("data-scroll-fade-top", "");
    textarea.setAttribute("data-scroll-fade-bottom", "");
    let offset = atEnd ? 1600 : 500;
    const clientHeight = () => (textarea.style.height ? 400 : 600);
    const scroll = vi.fn((next: number) => {
      offset = Math.min(next, 2000 - clientHeight());
    });
    Object.defineProperties(thread, {
      scrollHeight: { value: 2000 },
      clientHeight: { get: clientHeight },
      scrollTop: { get: () => offset, set: scroll },
    });
    const measureEditor = vi.fn(() => 150);
    Object.defineProperty(textarea, "scrollHeight", { get: measureEditor });
    adjustTextareaHeight(textarea);
    expect(textarea.style.height).toBe("");
    expect(textarea.style.overflowY).toBe("");
    expect(textarea.hasAttribute("data-scroll-fade-top")).toBe(false);
    expect(textarea.hasAttribute("data-scroll-fade-bottom")).toBe(false);
    expect(offset).toBe(atEnd ? 1400 : 500);
    expect(scroll).toHaveBeenCalledTimes(atEnd ? 1 : 0);
    expect(measureEditor).not.toHaveBeenCalled();
  },
);

it("retains measured sizing for a populated draft and fixed sizing for compact surfaces", () => {
  const shell = document.body.appendChild(document.createElement("div"));
  const textarea = shell.appendChild(document.createElement("textarea"));
  textarea.rows = 1;
  textarea.value = "A populated draft";
  textarea.style.maxHeight = "150px";
  Object.defineProperties(textarea, {
    scrollHeight: { value: 220 },
    clientHeight: { value: 150 },
  });
  adjustTextareaHeight(textarea);
  expect(textarea.style.height).toBe("150px");
  expect(textarea.style.overflowY).toBe("auto");
  shell.setAttribute("data-composer-layout", "single-line");
  adjustTextareaHeight(textarea);
  expect(textarea.style.height).toBe("");
  expect(textarea.style.overflowY).toBe("");
});
