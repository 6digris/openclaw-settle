import { html, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { renderPanelLoadingSkeleton } from "./panel-loading-skeleton.ts";
import "../styles/startup-skeletons.css";

let fixture: HTMLDivElement | undefined;

afterEach(() => {
  fixture?.remove();
  fixture = undefined;
});

describe.runIf("__vitest_browser__" in globalThis)("session panel loading feedback", () => {
  async function mount(chat: boolean) {
    fixture = document.createElement("div");
    fixture.className = "shell";
    render(
      html`<main class=${chat ? "content--chat" : "content"}>
          <div style="width: 320px; height: 240px">
            ${renderPanelLoadingSkeleton("files", "Loading files")}
          </div>
        </main>
        <div style="width: 640px; height: 160px">
          ${renderPanelLoadingSkeleton("terminal", "Connecting terminal")}
        </div>`,
      fixture,
    );
    document.body.append(fixture);
    const loaders = [
      ...fixture.querySelectorAll<HTMLElement & { updateComplete: Promise<unknown> }>(
        "openclaw-panel-loading-skeleton",
      ),
    ];
    await Promise.all(loaders.map((loader) => loader.updateComplete));
    return loaders;
  }

  it("shows status text instead of panel structures throughout a conversation", async () => {
    const loaders = await mount(true);
    // A docked terminal is a sibling of the main content, not its descendant.
    for (const loader of loaders) {
      const root = loader.shadowRoot!;
      const structure = root.querySelector<HTMLElement>(".structure")!;
      const status = root.querySelector<HTMLElement>(".status")!;
      expect(structure.getBoundingClientRect().height).toBe(0);
      expect(status.getBoundingClientRect().height).toBeGreaterThan(0);
      expect(status.textContent).toBe(loader.getAttribute("aria-label"));
      expect(loader.getAttribute("role")).toBe("status");
    }
  });

  it("keeps the original structural feedback outside a conversation", async () => {
    const loaders = await mount(false);
    for (const loader of loaders) {
      const root = loader.shadowRoot!;
      expect(root.querySelector<HTMLElement>(".status")!.getBoundingClientRect().height).toBe(0);
      expect(
        root.querySelector<HTMLElement>(".skeleton")!.getBoundingClientRect().height,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps panel boxes mounted while the initial conversation is masked", async () => {
    await mount(true);
    fixture!.dataset.startupManaged = "";
    fixture!.dataset.startupStage = "pending";
    const main = fixture!.querySelector("main")!;
    const pane = document.createElement("openclaw-chat-pane");
    pane.innerHTML = `<div class="sidebar-region__right-runtime">
      <section style="width: 320px; height: 240px">Restored panel</section>
    </div>`;
    main.append(pane);
    const panel = pane.querySelector("section")!;
    const pendingBox = panel.getBoundingClientRect().toJSON();
    expect(getComputedStyle(panel).visibility).toBe("hidden");
    expect(pendingBox.width).toBe(320);
    expect(pendingBox.height).toBe(240);
    fixture!.dataset.startupStage = "content";
    expect(getComputedStyle(panel).visibility).toBe("visible");
    expect(panel.getBoundingClientRect().toJSON()).toEqual(pendingBox);
    expect(panel.textContent).toBe("Restored panel");
  });
});
