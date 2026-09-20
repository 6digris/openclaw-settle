import { nothing, render } from "lit";
import { afterEach, beforeEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { renderChatImageLightbox } from "../pages/chat/components/chat-image-lightbox.ts";

let host: HTMLDivElement;
beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
});
afterEach(async () => {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  }
  render(nothing, host);
  host.remove();
});

it("keeps the viewer when Escape exits native video fullscreen", async () => {
  render(
    renderChatImageLightbox(
      {
        kind: "video",
        src: new URL("../e2e/fixtures/video-poster.mp4", import.meta.url).href,
        title: "Synthetic clip",
      },
      () => render(nothing, host),
    ),
    host,
  );
  const viewer = host.querySelector("openclaw-image-lightbox")!;
  await viewer.updateComplete;
  const modal = viewer.shadowRoot!.querySelector("openclaw-modal-dialog")!;
  await modal.updateComplete;
  const wa = modal.shadowRoot!.querySelector("wa-dialog")!;
  await wa.updateComplete;
  const dialog = wa.shadowRoot!.querySelector("dialog")!;
  await expect.poll(() => dialog.open).toBe(true);
  await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  const video = viewer.shadowRoot!.querySelector("video")!;
  const button = document.createElement("button");
  button.textContent = "Native fullscreen";
  button.addEventListener("click", () => {
    video.focus();
    void video.requestFullscreen();
  });
  viewer.shadowRoot!.querySelector(".actions")!.append(button);
  await userEvent.click(button);
  await expect.poll(() => video.matches(":fullscreen")).toBe(true);
  await userEvent.keyboard("{Escape}");
  await expect.poll(() => video.matches(":fullscreen")).toBe(false);
  expect(viewer.isConnected).toBe(true);
});
