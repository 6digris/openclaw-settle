/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { html } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import {
  flushDeferredRowPrune,
  installTranscriptDomMocks,
  mountTestTranscript,
  resetTranscriptTestDom,
  resizeObservers,
  type TestContentRow,
  transcriptDomState,
  transcriptRows,
} from "./chat-transcript.test-support.ts";

function transcriptSize(container: ParentNode): number {
  const sizer = expectDefined(
    container.querySelector<HTMLElement>(".chat-virtual-sizer"),
    "transcript extent",
  );
  return Number.parseFloat(sizer.style.height);
}

function stubMcpAppLifecycle(
  container: ParentNode,
  teardown: () => Promise<void> = () => Promise.resolve(),
) {
  const app = expectDefined(
    container.querySelector<HTMLElement>("mcp-app-view"),
    "mounted MCP app",
  );
  const lifecycle = {
    restartAfterTeardown: vi.fn(),
    teardown: vi.fn(teardown),
  };
  return { app: Object.assign(app, lifecycle), ...lifecycle };
}

function mcpRangeRows(appContent: unknown): TestContentRow[] {
  return Array.from({ length: 24 }, (_, index) => ({
    kind: "content" as const,
    key: `row:${index}`,
    content: index === 17 ? appContent : html`<div>row ${index}</div>`,
  }));
}

describe("chat transcript MCP lifecycle", () => {
  beforeEach(installTranscriptDomMocks);
  afterEach(resetTranscriptTestDom);

  it("keeps retained MCP rows and the virtual row model atomic through teardown", async () => {
    const teardownPending = createDeferred();
    transcriptDomState.measuredRowHeight = 180;
    const initialRows = [
      { kind: "content" as const, key: "app", content: html`<mcp-app-view></mcp-app-view>` },
      { kind: "content" as const, key: "group:tool", content: html`<div>tool</div>` },
      { kind: "content" as const, key: "group:reply", content: html`<div>reply</div>` },
    ];
    const regroupedRows = [
      { kind: "content" as const, key: "history", content: html`<div>history</div>` },
      {
        kind: "content" as const,
        key: "group:reply",
        content: html`<div>regrouped</div>`,
      },
      { kind: "content" as const, key: "group:next", content: html`<div>next</div>` },
    ];
    const { container, renderRows } = await mountTestTranscript("pane-mcp-rows", initialRows);
    stubMcpAppLifecycle(container, () => teardownPending.promise);

    renderRows(regroupedRows);
    const retainedRows = transcriptRows(container);
    expect(retainedRows.map((row) => row.dataset.virtualRowKey)).toEqual([
      "app",
      "group:tool",
      "group:reply",
    ]);

    // Deliver an old-tree resize while teardown keeps that tree connected.
    // Its data-index values must still resolve through the old key model.
    Object.defineProperty(retainedRows[1]!, "offsetHeight", { configurable: true, value: 40 });
    for (const observer of resizeObservers) {
      observer.emitTarget(retainedRows[1]!, 800, 40);
    }
    teardownPending.resolve();
    await teardownPending.promise;
    await Promise.resolve();
    renderRows(regroupedRows);
    await flushDeferredRowPrune();
    renderRows(regroupedRows);

    const committedRows = transcriptRows(container);
    expect(committedRows.map((row) => row.dataset.virtualRowKey)).toEqual([
      "history",
      "group:reply",
      "group:next",
    ]);
    // The old tool's 40px delivery must not resize the retained reply key.
    expect(transcriptSize(container)).toBe(540);
  });

  it("does not teardown an MCP row retained by an append", async () => {
    const initialRows = [
      { kind: "content" as const, key: "app", content: html`<mcp-app-view></mcp-app-view>` },
      { kind: "content" as const, key: "reply", content: html`<div>reply</div>` },
    ];
    const { container, renderRows } = await mountTestTranscript("pane-mcp-append", initialRows);
    const { app, teardown } = stubMcpAppLifecycle(container);

    renderRows([...initialRows, { kind: "content", key: "next", content: html`<div>next</div>` }]);

    expect(teardown).not.toHaveBeenCalled();
    expect(container.querySelector("mcp-app-view")).toBe(app);
  });

  it("tears down a retained MCP key that leaves the next virtual range", async () => {
    const initialRows = mcpRangeRows(html`<mcp-app-view></mcp-app-view>`);
    const { container, renderRows } = await mountTestTranscript("pane-mcp-range", initialRows);
    const { app, teardown } = stubMcpAppLifecycle(container);

    renderRows([initialRows[17]!, ...initialRows.slice(0, 17), ...initialRows.slice(18)]);

    expect(teardown).toHaveBeenCalledOnce();
    expect(app.isConnected).toBe(true);
  });

  it("keeps a focused MCP key at its next-model index", async () => {
    const initialRows = mcpRangeRows(
      html`<mcp-app-view
        ><iframe title="Retained application"></iframe><button>focus app</button></mcp-app-view
      >`,
    );
    const { container, renderRows } = await mountTestTranscript(
      "pane-mcp-focused-range",
      initialRows,
    );
    const { app, teardown } = stubMcpAppLifecycle(container);
    const frame = expectDefined(app.querySelector("iframe"), "retained application frame");
    const rowParent = expectDefined(app.parentElement?.parentElement, "retained row parent");
    const button = expectDefined(container.querySelector("button"), "MCP app focus target");
    button.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));

    renderRows([initialRows[17]!, ...initialRows.slice(0, 17), ...initialRows.slice(18)]);

    expect(teardown).not.toHaveBeenCalled();
    expect(app.isConnected).toBe(true);
    expect(container.querySelector("mcp-app-view")).toBe(app);
    expect(app.querySelector("iframe")).toBe(frame);
    expect(app.parentElement?.parentElement).toBe(rowParent);
  });
});
