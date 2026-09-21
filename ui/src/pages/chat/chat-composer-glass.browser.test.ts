import { nothing, render } from "lit";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { renderChatQueue } from "./components/chat-composer-queue.ts";
import baseStyles from "../../styles/base.css?inline";
import overlayStyles from "../../styles/chat/composer-overlay.css?inline";
import queueStyles from "../../styles/chat/composer-queue.css?inline";

let container: HTMLDivElement | undefined;
let styles: HTMLStyleElement | undefined;
const previousTheme = document.documentElement.dataset.themeMode;
afterEach(() => {
  if (container) {
    render(nothing, container);
    container.remove();
  }
  styles?.remove();
  if (previousTheme === undefined) {
    delete document.documentElement.dataset.themeMode;
  } else {
    document.documentElement.dataset.themeMode = previousTheme;
  }
});

it.each(["dark", "light"])("keeps unavailable Steer muted on row hover in %s", async (theme) => {
  document.documentElement.dataset.themeMode = theme;
  styles = document.createElement("style");
  styles.textContent = [baseStyles, queueStyles, overlayStyles].join("\n");
  document.head.append(styles);
  container = document.createElement("div");
  container.className = "agent-chat__composer-shell";
  document.body.append(container);
  render(
    renderChatQueue({
      canAbort: true,
      queue: [
        { id: "waiting", text: "Add watering notes", createdAt: 1, sendState: "waiting-model" },
      ],
      onQueueSteer: () => {},
      onQueueRemove: () => {},
    }),
    container,
  );
  const steer = container.querySelector<HTMLButtonElement>(".chat-queue__steer")!;
  expect(steer.disabled).toBe(true);
  const probe = document.createElement("span");
  probe.style.color = "color-mix(in srgb, var(--muted) 48%, transparent)";
  container.append(probe);
  const expected = getComputedStyle(probe).color;
  expect(getComputedStyle(steer).color).toBe(expected);
  await page.getByText("Add watering notes", { exact: true }).hover();
  expect(getComputedStyle(steer).color).toBe(expected);
});
