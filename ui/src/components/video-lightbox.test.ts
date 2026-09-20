/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderChatImageLightbox } from "../pages/chat/components/chat-image-lightbox.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";

let pause: ReturnType<typeof vi.spyOn>;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  render(nothing, container);
  container.remove();
  vi.restoreAllMocks();
});

async function mount() {
  const release = [vi.fn(), vi.fn()];
  const connect = release.map((end, index) =>
    vi.fn((media: HTMLVideoElement) => {
      media.src = "https://example.com/" + index + ".mp4";
      return end;
    }),
  );
  const items: ImageLightboxItem[] = connect.map((connectVideo, index) => ({
    kind: "video",
    src: "https://example.com/" + index + ".mp4",
    title: "Clip " + index,
    connectVideo,
  }));
  render(
    renderChatImageLightbox(
      { ...items[0]!, gallery: { index: 0, items: items.map((item) => async () => item) } },
      () => render(nothing, container),
    ),
    container,
  );
  const viewer = container.querySelector("openclaw-image-lightbox")!;
  await viewer.updateComplete;
  const root = viewer.shadowRoot!;
  const media = root.querySelector("video")!;
  return { viewer, root, media, release, connect };
}

it("uses one selected player, releases on navigation and close, and preserves native keyboard controls", async () => {
  const { viewer, root, media, release, connect } = await mount();
  expect(connect[0]).toHaveBeenCalledOnce();
  expect(connect[1]).not.toHaveBeenCalled();
  const nativeArrow = new KeyboardEvent("keydown", {
    key: "ArrowRight",
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  media.dispatchEvent(nativeArrow);
  expect(nativeArrow.defaultPrevented).toBe(false);
  expect(connect[1]).not.toHaveBeenCalled();
  const next = root.querySelector<HTMLButtonElement>(".next")!;
  next.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
  await vi.waitFor(() => expect(media.src).toContain("/1.mp4"));
  expect(root.querySelectorAll("video")).toHaveLength(1);
  expect(root.querySelector("video")).toBe(media);
  expect(release[0]).toHaveBeenCalledOnce();
  expect(pause).toHaveBeenCalled();
  expect(media.controls).toBe(true);
  expect(root.querySelector(".gallery-counter")?.textContent).toContain("2 / 2");
  root.querySelector<HTMLButtonElement>(".previous")!.click();
  await vi.waitFor(() => expect(media.src).toContain("/0.mp4"));
  expect(release[1]).toHaveBeenCalledOnce();
  root.querySelector<HTMLButtonElement>(".close")!.click();
  expect(container.querySelector("openclaw-image-lightbox")).toBeNull();
  expect(release[0]).toHaveBeenCalledTimes(2);
  expect(media.hasAttribute("src")).toBe(false);
  await viewer.updateComplete;
  expect(connect[0]).toHaveBeenCalledTimes(2);
});

it("swipes the picture in both directions without capturing the native control strip", async () => {
  const { root, media, connect } = await mount();
  const stage = root.querySelector<HTMLElement>(".stage")!;
  const capture = vi.fn();
  stage.setPointerCapture = capture;
  vi.spyOn(media, "getBoundingClientRect").mockReturnValue({
    top: 100,
    bottom: 400,
    left: 0,
    right: 400,
    width: 400,
    height: 300,
    x: 0,
    y: 100,
    toJSON() {},
  });
  const pointer = (target: Element, type: string, x: number, y: number) =>
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        pointerType: "touch",
        button: 0,
        isPrimary: true,
        clientX: x,
        clientY: y,
        bubbles: true,
        composed: true,
      }),
    );
  pointer(media, "pointerdown", 300, 380);
  pointer(media, "pointermove", 100, 380);
  pointer(media, "pointerup", 100, 380);
  expect(capture).not.toHaveBeenCalled();
  expect(connect[1]).not.toHaveBeenCalled();
  pointer(media, "pointerdown", 300, 200);
  expect(capture).not.toHaveBeenCalled();
  pointer(media, "pointermove", 100, 200);
  pointer(stage, "pointerup", 100, 200);
  await vi.waitFor(() => expect(media.src).toContain("/1.mp4"));
  pointer(media, "pointerdown", 100, 200);
  pointer(media, "pointermove", 300, 200);
  pointer(stage, "pointerup", 300, 200);
  await vi.waitFor(() => expect(media.src).toContain("/0.mp4"));
});
