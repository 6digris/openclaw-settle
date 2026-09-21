import { expect } from "vitest";

export function getChatThinkingValue(control: HTMLElement): string {
  return control.dataset.chatThinkingValue ?? "";
}

export function getThinkingSelect(container: Element): HTMLElement {
  const select = container.querySelector<HTMLElement>('[data-chat-thinking-select="true"]');
  expect(select).toBeInstanceOf(HTMLElement);
  if (!(select instanceof HTMLElement)) {
    throw new Error("Expected chat thinking control");
  }
  return select;
}

export function getThinkingSlider(container: Element): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>('[data-chat-thinking-slider="true"]');
}

export function getThinkingSliderValues(container: Element): string[] {
  const values = getThinkingSlider(container)?.dataset.chatThinkingValues ?? "";
  return values ? values.split(",") : [];
}

export function getThinkingReasoningValueLabel(container: Element): string {
  const preview = container.querySelector(
    "[data-chat-thinking-preview-committed]:not([hidden]), " +
      "[data-chat-thinking-preview-index]:not([hidden])",
  );
  return preview?.textContent?.trim() ?? "";
}
