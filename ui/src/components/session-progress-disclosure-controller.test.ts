/* @vitest-environment jsdom */

import type { ProgressCard } from "@openclaw/gateway-protocol";
import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeChatHost } from "../pages/chat/chat-host.test-support.ts";
import { adoptStartedChatRun } from "../pages/chat/run-lifecycle.ts";
import { resolveChatProjectionRunId } from "../pages/chat/tool-stream-status.ts";
import { observeTranscript } from "./session-progress-card.test-support.ts";
import { renderSessionProgressCard } from "./session-progress-card.ts";
import type { ComposerProgressRunLifecycle } from "./session-progress-disclosure-controller.ts";

const containers: HTMLDivElement[] = [];
function createContainer() {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  return container;
}

const transcriptCleanups: Array<() => void> = [];

const NOW_MS = Date.UTC(2026, 7, 26, 13, 37);

const progressCard: ProgressCard = {
  sessionKey: "agent:main:work",
  revision: 2,
  updatedAt: NOW_MS - 2 * 60_000,
  markdown: '**Focused change**\n\n<progress value="1" max="3"></progress>',
  steps: [
    { step: "Inspect the route", status: "completed" },
    { step: "Wire the checklist", status: "in_progress" },
    { step: "Run focused tests", status: "pending" },
  ],
};

function renderTranscriptCard(
  container: HTMLElement,
  lifecycle: ComposerProgressRunLifecycle,
  showTranscript = true,
) {
  return render(
    html`<div class="chat-main">
      ${showTranscript ? html`<div class="chat-thread"></div>` : nothing}
      ${renderSessionProgressCard(progressCard, "composer", undefined, undefined, undefined, undefined, true, false, lifecycle)}
    </div>`,
    container,
  );
}

describe("elastic progress disclosure controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    for (const cleanup of transcriptCleanups.splice(0)) {
      cleanup();
    }
    for (const container of containers.splice(0)) {
      render(nothing, container);
      container.remove();
    }
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([true, false])(
    "closes a late mount synchronously without saving a choice (default collapsed=%s)",
    (collapseByDefault) => {
      const container = createContainer();
      const gatewayScope = {};
      const show = (initiallyCollapsed?: boolean) =>
        render(
          renderSessionProgressCard(
            progressCard,
            "composer",
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            collapseByDefault,
            { gatewayScope, initiallyCollapsed },
          ),
          container,
        );
      show(true);
      // No timer or microtask may be needed to hide the expanded body.
      expect(container.querySelector("details")!.open).toBe(false);
      render(nothing, container);
      show();
      expect(container.querySelector("details")!.open).toBe(!collapseByDefault);
    },
  );

  it.each([true, false])(
    "preserves the user's expanded=%s choice across late and cached remounts",
    (manualOpen) => {
      const container = createContainer();
      const gatewayScope = {};
      const show = (initiallyCollapsed?: boolean) =>
        render(
          renderSessionProgressCard(
            progressCard,
            "composer",
            undefined,
            undefined,
            undefined,
            undefined,
            true,
            false,
            { gatewayScope, initiallyCollapsed },
          ),
          container,
        );
      show(true);
      const summary = container.querySelector("summary")!;
      summary.click();
      if (!manualOpen) {
        summary.click();
      }
      expect(container.querySelector("details")!.open).toBe(manualOpen);
      for (const initiallyCollapsed of [true, undefined]) {
        render(nothing, container);
        show(initiallyCollapsed);
        expect(container.querySelector("details")!.open).toBe(manualOpen);
      }
    },
  );

  it.each([
    [null, "run-1", null],
    [null, null, "run-1"],
    ["run-1", null, "run-1"],
  ] as const)(
    "keeps a late first card closed through initial metadata (%s → %s/%s)",
    async (initialRun, activeRun, completedRun) => {
      const container = createContainer();
      const gatewayScope = {};
      const show = (activeRunId: string | null, completedRunId: string | null = null) =>
        renderTranscriptCard(container, {
          gatewayScope,
          initiallyCollapsed: true,
          recoveredRunId: "run-1",
          activeRunId,
          completedRunId,
        });
      const writes = vi.spyOn(HTMLDetailsElement.prototype, "open", "set");
      show(initialRun);
      const card = container.querySelector("details")!;
      expect(card.open).toBe(false);
      await Promise.resolve();
      expect(card.open).toBe(false);
      show(activeRun, completedRun);
      expect(card.open).toBe(false);
      await Promise.resolve();
      expect(card.open).toBe(false);
      expect(writes.mock.calls.every(([open]) => !open)).toBe(true);
      writes.mockRestore();
      // A genuinely different task resumes the ordinary run default.
      show("run-2");
      expect(card.open).toBe(true);
    },
  );

  it("opens the ordinary default for a newly adopted local send after a late idle card", () => {
    const container = createContainer();
    const host = makeChatHost({ sessionKey: progressCard.sessionKey });
    const show = () =>
      renderTranscriptCard(container, {
        initiallyCollapsed: true,
        activeRunId: resolveChatProjectionRunId({
          localRunId: host.chatRunId,
          queue: host.chatQueue,
        }),
      });
    show();
    expect(container.querySelector("details")!.open).toBe(false);
    // chat-send-delivery calls this owner for the new chat.send started ACK;
    // history recovery calls the same owner, which currently records no provenance.
    adoptStartedChatRun(host, "new-local-submission", NOW_MS + 1000);
    expect(host.chatRunId).toBe("new-local-submission");
    show();
    expect(container.querySelector("details")!.open).toBe(true);
  });

  it.each([
    { initialRunId: "initial", activeRunId: "initial", recoveredRunId: undefined, open: false },
    { initialRunId: null, activeRunId: "recovered", recoveredRunId: "recovered", open: false },
    { initialRunId: "initial", activeRunId: "new-local", recoveredRunId: "initial", open: true },
  ])("keeps the correct first frame after an empty refresh ($activeRunId)", async (scenario) => {
    const container = createContainer();
    const gatewayScope = {};
    renderTranscriptCard(container, {
      gatewayScope,
      initiallyCollapsed: true,
      initialRunId: scenario.initialRunId,
      activeRunId: scenario.initialRunId,
    });
    expect(container.querySelector("details")!.open).toBe(false);
    render(nothing, container);
    const writes = vi.spyOn(HTMLDetailsElement.prototype, "open", "set");
    renderTranscriptCard(container, { gatewayScope, initiallyCollapsed: true, ...scenario });
    expect(container.querySelector("details")!.open).toBe(scenario.open);
    await Promise.resolve();
    expect(writes.mock.calls.every(([open]) => open === scenario.open)).toBe(true);
    writes.mockRestore();
  });

  it.each([true, false, 48] as const)(
    "keeps a manual %s choice while the late card acquires its run identity",
    async (choice) => {
      const container = createContainer();
      const gatewayScope = {};
      const show = (activeRunId: string | null, completedRunId: string | null = null) =>
        renderTranscriptCard(container, {
          gatewayScope,
          initiallyCollapsed: true,
          recoveredRunId: "run-1",
          activeRunId,
          completedRunId,
        });
      show(null);
      const summary = container.querySelector("summary")!;
      if (typeof choice === "number") {
        summary.dispatchEvent(
          new WheelEvent("wheel", { deltaY: -choice, bubbles: true, cancelable: true }),
        );
      } else {
        summary.click();
        if (!choice) {
          summary.click();
        }
      }
      const writes = vi.spyOn(HTMLDetailsElement.prototype, "open", "set");
      show("run-1");
      await Promise.resolve();
      show(null, "run-1");
      await Promise.resolve();
      expect(writes.mock.calls.every(([open]) => open === Boolean(choice))).toBe(true);
      writes.mockRestore();
      render(nothing, container);
      show(null, "run-1");
      expect(container.querySelector("details")!.open).toBe(Boolean(choice));
      expect(
        container.querySelector<HTMLElement>(".session-progress-card__body")!.style.height,
      ).toBe(typeof choice === "number" ? "48px" : "");
    },
  );

  it.each([true, false])(
    "records endpoint wheel ownership and cancels following (collapsed=%s)",
    (collapsed) => {
      const container = createContainer();
      const onManipulate = vi.fn();
      const show = (final = false) =>
        render(
          renderSessionProgressCard(
            progressCard,
            "composer",
            undefined,
            undefined,
            undefined,
            undefined,
            !final,
            collapsed,
            {
              activeRunId: final ? null : "run-1",
              completedRunId: final ? "run-1" : null,
              onManipulate,
            },
          ),
          container,
        );
      show();
      const card = container.querySelector("details")!;
      const body = card.querySelector<HTMLElement>(".session-progress-card__body")!;
      if (!collapsed) {
        vi.spyOn(body, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 300));
      }
      card.querySelector("summary")!.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: collapsed ? 48 : -48,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(onManipulate).toHaveBeenCalledTimes(1);
      expect(body.style.height).toBe(collapsed ? "0px" : "300px");
      show(true);
      expect(card.open).toBe(!collapsed);
      expect(body.style.height).toBe(collapsed ? "0px" : "300px");
    },
  );

  it("holds a partial wheel choice across revisions and final, then resets it for a new task/session", () => {
    const container = createContainer();
    const show = (
      sessionKey: string,
      activeRunId: string | null,
      completedRunId: string | null,
      revision = 1,
    ) =>
      render(
        renderSessionProgressCard(
          { ...progressCard, sessionKey, revision },
          "composer",
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          true,
          { activeRunId, completedRunId },
        ),
        container,
      );
    show("agent:main:first", "one", null);
    const card = container.querySelector<HTMLDetailsElement>("details")!;
    const header = card.querySelector("summary")!;
    header.dispatchEvent(new WheelEvent("wheel", { deltaY: -48, bubbles: true, cancelable: true }));
    expect(card.open).toBe(true);
    expect(card.querySelector<HTMLElement>(".session-progress-card__body")!.style.height).toBe(
      "48px",
    );
    show("agent:main:first", "one", null, 2);
    show("agent:main:first", null, "one", 3);
    expect(card.querySelector<HTMLElement>(".session-progress-card__body")!.style.height).toBe(
      "48px",
    );
    show("agent:main:first", "two", null, 4);
    expect(card.open).toBe(false);
    header.dispatchEvent(new WheelEvent("wheel", { deltaY: -32, bubbles: true, cancelable: true }));
    expect(card.open).toBe(true);
    show("agent:main:second", "three", null);
    expect(card.open).toBe(false);
    expect(card.querySelector<HTMLElement>(".session-progress-card__body")!.style.height).toBe("");
  });

  it("remembers pixel choices only for the matching task, Gateway, and session identity", () => {
    const container = createContainer();
    const gateway = {};
    const show = (
      activeRunId: string | null,
      completedRunId: string | null = null,
      gatewayScope = gateway,
      sessionIdentity = "first",
    ) =>
      render(
        renderSessionProgressCard(
          progressCard,
          "composer",
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          true,
          { gatewayScope, sessionIdentity, activeRunId, completedRunId },
        ),
        container,
      );
    const body = () => container.querySelector<HTMLElement>(".session-progress-card__body")!;
    show("one");
    container
      .querySelector("summary")!
      .dispatchEvent(new WheelEvent("wheel", { deltaY: -48, bubbles: true, cancelable: true }));
    render(nothing, container);
    show("one");
    expect(body().style.height).toBe("48px");
    render(nothing, container);
    show(null, "one");
    expect(body().style.height).toBe("48px");
    show(null, "one", {}, "first");
    expect(body().style.height).toBe("");
    show(null, "one", gateway, "second");
    expect(body().style.height).toBe("");
    show(null, "one");
    expect(body().style.height).toBe("48px");
    render(nothing, container);
    show("two");
    expect(body().style.height).toBe("");
    expect(container.querySelector("details")!.open).toBe(false);
  });

  it("header takeover clears pending transcript gestures before fresh history can collapse it", async () => {
    const container = createContainer();
    renderTranscriptCard(container, { activeRunId: "run-1", readingHistory: true });
    const transcript = observeTranscript(container, transcriptCleanups);
    await Promise.resolve();
    transcript.wheel(200);
    vi.advanceTimersByTime(201);
    transcript.wheel(200);
    const card = container.querySelector("details")!;
    const body = card.querySelector<HTMLElement>(".session-progress-card__body")!;
    card
      .querySelector("summary")!
      .dispatchEvent(new WheelEvent("wheel", { deltaY: -48, bubbles: true, cancelable: true }));
    vi.advanceTimersByTime(1000);
    expect(card.open).toBe(true);
    expect(body.style.height).toBe("48px");
    transcript.wheel(200);
    vi.advanceTimersByTime(301);
    expect(card.open).toBe(true);
    transcript.wheel(200);
    vi.advanceTimersByTime(301);
    expect(card.open).toBe(false);
    expect(body.style.height).toBe("");
  });
});
