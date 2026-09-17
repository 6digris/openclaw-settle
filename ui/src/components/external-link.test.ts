/* @vitest-environment jsdom */
import { html, render, type LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startNativeLinkRouting } from "../app/native-link-routing.ts";
import { i18n } from "../i18n/index.ts";
import { refreshExternalLinkPresentation } from "../lib/external-link-presentation.ts";
import {
  externalLinkAriaLabel,
  renderExternalLinkAccessibleName,
  renderExternalLinkLabel,
} from "./external-link.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("external link labels", () => {
  it("updates the arrow and accessible name with the mounted routing owner while preserving explicit external actions", async () => {
    let panel = false;
    const routing = startNativeLinkRouting({ shouldOpenInControlUiBrowser: () => panel });
    const container = document.createElement("div");
    document.body.append(container);
    try {
      render(
        html`
          <a href="https://example.test/guide" aria-label=${externalLinkAriaLabel("Open guide")}>
            ${renderExternalLinkLabel("Guide", "https://example.test/guide", false)}
          </a>
          <button type="button">${renderExternalLinkLabel("Open externally")}</button>
        `,
        container,
      );
      const anchor = container.querySelector("a")!;
      const indicator = anchor.querySelector<LitElement>("openclaw-external-link")!;
      const buttonIndicator = container.querySelector<LitElement>("button openclaw-external-link")!;
      const expectPresentation = async (opensInPanel: boolean) => {
        await Promise.all([indicator.updateComplete, buttonIndicator.updateComplete]);
        expect(indicator.shadowRoot?.querySelectorAll("svg")).toHaveLength(opensInPanel ? 0 : 1);
        expect(anchor.getAttribute("aria-label")).toBe(
          opensInPanel ? "Open guide" : "Open guide (opens in a new tab)",
        );
        expect(buttonIndicator.shadowRoot?.querySelectorAll("svg")).toHaveLength(1);
        expect(
          buttonIndicator.shadowRoot?.querySelector('[role="img"]')?.getAttribute("aria-label"),
        ).toBe("opens in a new tab");
      };
      await expectPresentation(false);
      for (const next of [true, false, true]) {
        panel = next;
        refreshExternalLinkPresentation();
        await expectPresentation(next);
      }
      routing.dispose();
      await expectPresentation(false);
    } finally {
      routing.dispose();
      render(null, container);
    }
  });
  it.each([
    ["https://docs.example.test/guide", true],
    ["http://docs.example.test/guide", true],
    ["//docs.example.test/guide", true],
    [`${location.origin}/settings/about`, false],
    ["/settings/about", false],
    ["../settings/about", false],
    ["#details", false],
    ["/chat/main/research", false],
    ["mailto:help@example.test", false],
    ["javascript:alert(1)", false],
    ["data:text/plain,hello", false],
  ])("marks %s only when it leaves the platform", async (href, external) => {
    const container = document.createElement("div");
    document.body.append(container);
    render(html`<a href=${href}>${renderExternalLinkLabel("Guide", href)}</a>`, container);
    const indicator = container.querySelector<LitElement>("openclaw-external-link");
    expect(indicator !== null).toBe(external);
    if (indicator) {
      await indicator.updateComplete;
      expect(indicator.shadowRoot?.querySelectorAll("svg")).toHaveLength(1);
      expect(indicator.shadowRoot?.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(
        "opens in a new tab",
      );
    }
    expect(container.textContent).toBe("Guide");
  });

  it("retains one announcement and the original label through a rerender", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    for (const label of ["Learn more", "Read documentation"]) {
      render(html`<a href="https://example.test">${renderExternalLinkLabel(label)}</a>`, container);
      const indicators = container.querySelectorAll<LitElement>("openclaw-external-link");
      expect(indicators).toHaveLength(1);
      await indicators[0]!.updateComplete;
      expect(
        indicators[0]!.shadowRoot?.querySelectorAll('[aria-label="opens in a new tab"]'),
      ).toHaveLength(1);
      expect(container.textContent).toBe(label);
    }
  });

  it("hides the indicator announcement when the control owns its accessible name", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(
      html`<a
        href="https://example.test"
        aria-label=${renderExternalLinkAccessibleName("Open guide")}
      >
        ${renderExternalLinkLabel("Guide", "https://example.test", false)}
      </a>`,
      container,
    );
    const indicator = container.querySelector<LitElement>("openclaw-external-link");
    await indicator?.updateComplete;
    expect(container.querySelector("a")?.getAttribute("aria-label")).toBe(
      "Open guide (opens in a new tab)",
    );
    expect(indicator?.getAttribute("aria-hidden")).toBe("true");
    expect(indicator?.shadowRoot?.querySelectorAll("svg")).toHaveLength(1);
  });
});
