/* @vitest-environment jsdom */
import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  renderComposerFixture as renderComposer,
  resetComposerFixture,
} from "./chat-composer.test-support.ts";
import { renderChatComposer } from "./components/chat-composer.ts";
afterEach(() => resetComposerFixture());

describe("progress card refresh admission", () => {
  it.each([
    { connected: true, canSend: true, visible: true },
    { connected: false, canSend: true, visible: false },
    { connected: true, canSend: false, visible: false },
  ])(
    "shows refresh only for writable connected composers: %j",
    ({ connected, canSend, visible }) => {
      const onRefresh = vi.fn();
      const card = {
        sessionKey: "agent:main:work",
        revision: 1,
        updatedAt: 1,
        markdown: "Prior progress",
      };
      const view = renderComposer({
        connected,
        canSend,
        progressCard: card,
        progressCardRefresh: { onRefresh },
      });
      onTestFinished(() => {
        render(html``, view.container);
      });
      const refresh = view.container.querySelector<HTMLButtonElement>(
        ".session-progress-card__refresh",
      );
      expect(Boolean(refresh)).toBe(visible);
      refresh?.click();
      expect(onRefresh).toHaveBeenCalledTimes(visible ? 1 : 0);
      expect(view.props.onSend).not.toHaveBeenCalled();
      expect(view.props.messages).toEqual([]);
      expect(view.props.queue).toEqual([]);
    },
  );
});

it("keeps late disclosure stable through refresh states without overriding a manual choice", async () => {
  const onRefresh = vi.fn();
  const card = {
    sessionKey: "agent:main:work",
    revision: 1,
    updatedAt: 1,
    markdown: "Late progress",
  };
  const view = renderComposer({
    progressCard: card,
    progressCardInitiallyCollapsed: true,
    progressCardRefresh: { onRefresh },
  });
  onTestFinished(() => {
    render(nothing, view.container);
  });
  const details = view.container.querySelector<HTMLDetailsElement>(
    ".session-progress-card--composer",
  )!;
  expect(details.open).toBe(false);
  const writes = vi.spyOn(details, "open", "set");
  view.container.querySelector<HTMLButtonElement>(".session-progress-card__refresh")!.click();
  expect(onRefresh).toHaveBeenCalledExactlyOnceWith(card);
  for (const state of ["pending", "failed", "timeout", "updated"] as const) {
    view.props.progressCardRefresh = { onRefresh, state };
    render(renderChatComposer(view.props), view.container);
    await Promise.resolve();
    expect(details.open).toBe(false);
  }
  expect(writes.mock.calls.every(([open]) => !open)).toBe(true);
  details.querySelector("summary")!.click();
  expect(details.open).toBe(true);
  view.props.progressCardRefresh = { onRefresh, state: "pending" };
  render(renderChatComposer(view.props), view.container);
  await Promise.resolve();
  expect(details.open).toBe(true);
  expect(view.props.onSend).not.toHaveBeenCalled();
});
