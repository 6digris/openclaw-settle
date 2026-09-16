/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { renderLazyViewError } from "../../components/lazy-view-error.ts";
import { setChatHistoryLoad } from "./chat-history-state.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import { renderSidebarRegion } from "./chat-pane-sidebar-layout.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import { stubAnimationFrames } from "./chat-view.test-helpers.ts";
import "./components/chat-sidebar-region.runtime.ts";
import type { ChatTranscriptController } from "./components/chat-transcript-controller.ts";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
  transcriptDomState,
} from "./components/chat-transcript.test-support.ts";
import { openSlot, type SidebarLayout } from "./sidebar-layout.ts";
import { renderPendingSidebarRegion, renderSidebarRegionFrame } from "./sidebar-region-frame.ts";

// Exercise the pane's real transcript callbacks and the region's real commit.
// The application router and panel services are outside this composition boundary.
async function mountComposition(layout: SidebarLayout, failed = false) {
  const flushFrames = stubAnimationFrames();
  const client = createGatewayBrowserClientFixture();
  const { pane: owner, state } = createTestChatPane({
    client,
    sessions: createSessionCapabilityFixture(),
  });
  const pane = owner as typeof owner & {
    renderedSidebarLayout: SidebarLayout;
    transcript: ChatTranscriptController;
    transcriptPresentationReady: boolean;
    render(): typeof nothing;
    updated(): void;
  };
  pane.render = () => nothing;
  pane.updated = () => {};
  setChatHistoryLoad(state, {
    phase: "committed",
    sessions: state.sessions,
    client,
    connectionEpoch: state.connectionEpoch,
    sessionKey: state.sessionKey,
    requestAgentId: undefined,
    sessionInfo: undefined,
  });
  ChatPaneBase.prototype.connectedCallback.call(pane);
  await pane.updateComplete;
  pane.renderedSidebarLayout = layout;
  const frame = pane.appendChild(document.createElement("div"));
  render(
    failed
      ? renderSidebarRegionFrame({
          layout,
          collapsed: false,
          primary: html`<main>Conversation</main>`,
          runtime: renderPendingSidebarRegion(
            layout,
            false,
            renderLazyViewError({
              error: new Error("Panel module unavailable"),
              onRetry: () => {},
            }),
            true,
          ),
        })
      : renderSidebarRegion({
          layout,
          availableWidth: 1400,
          availableSlots: ["detail"],
          narrow: false,
          primary: html`<main>Conversation</main>`,
          panelTemplates: { detail: html`<aside>Details</aside>` },
          panelActions: {},
          callbacks: {
            activatePanel: () => {},
            togglePanelExpanded: () => {},
            closeSlot: () => {},
            openSlot: () => {},
            reorderPanel: () => {},
            resizePanel: () => {},
            setOpen: () => {},
          },
          requestUpdate: () => {},
        }),
    frame,
  );
  transcriptDomState.measuredRowHeight = 120;
  const mounted = await mountTestTranscript("composition", [], pane.transcript);
  Object.defineProperties(mounted.container, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, value: 600 },
  });
  mounted.session.setContentReady(true);
  mounted.renderRows([{ kind: "content", key: "answer", content: "Ready conversation" }]);
  flushFrames();
  await flushDeferredRowPrune();
  return { pane, frame, flushFrames };
}

describe("chat pane composition readiness", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("waits for the lateral commit and resumes from its geometry event", async () => {
    const { pane, frame, flushFrames } = await mountComposition(
      openSlot({ columns: [] }, "detail"),
    );
    const region = frame.querySelector("openclaw-chat-sidebar-region")!;
    const scheduler = region as unknown as { scheduleUpdate(): void | Promise<unknown> };
    const held = createDeferred();
    const scheduleUpdate = scheduler.scheduleUpdate.bind(region);
    vi.spyOn(scheduler, "scheduleUpdate").mockImplementation(async () => {
      await held.promise;
      await scheduleUpdate();
    });
    // The lightweight pane fixture is detached; connect the real child lifecycle
    // explicitly, just as mountTestTranscript connects the transcript controller.
    region.connectedCallback();
    try {
      await Promise.resolve();
      expect(pane.transcript.initialLayoutReady).toBe(false);
      expect(pane.transcriptPresentationReady).toBe(false);
      expect(frame.querySelector(".side-panel__panel")).toBeNull();

      held.resolve();
      await region.updateComplete;
      await Promise.resolve();
      flushFrames();
      await flushDeferredRowPrune();
      expect(frame.querySelector(".side-panel__panel")?.textContent).toContain("Details");
      expect(pane.transcript.initialLayoutReady).toBe(true);
      expect(pane.transcriptPresentationReady).toBe(true);
    } finally {
      held.resolve();
      await region.updateComplete;
      region.disconnectedCallback();
    }
  });

  it("does not wait for a lateral runtime when the layout has no panels", async () => {
    const { pane } = await mountComposition({ columns: [] });
    expect(pane.transcript.initialLayoutReady).toBe(true);
    expect(pane.transcriptPresentationReady).toBe(true);
  });

  it("accepts a committed panel import error without hiding the conversation forever", async () => {
    const { pane, frame } = await mountComposition(openSlot({ columns: [] }, "detail"), true);
    expect(frame.querySelector('[role="alert"]')?.textContent).toContain(
      "Panel module unavailable",
    );
    expect(pane.transcript.initialLayoutReady).toBe(true);
    expect(pane.transcriptPresentationReady).toBe(true);
  });
});
