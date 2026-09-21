import type { Page } from "playwright";
import { expect } from "vitest";
import { closeBrowserPage } from "../../test-helpers/browser-page.ts";
import { expectFiniteRect, readUiCss } from "./chat-layout.browser.test-support.ts";

export async function syncFixtureComposerPopoverAnchor(page: Page) {
  // The session companion runs the same composer surface, so the pane's own
  // composer is named by its shell rather than by the shared surface class.
  await page.locator(".agent-chat__composer-shell > .agent-chat__input").evaluate((node) => {
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const layoutViewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const composerTop = node.getBoundingClientRect().top;
    node.style.setProperty(
      "--chat-composer-popover-bottom",
      `${layoutViewportHeight - composerTop + 6}px`,
    );
    node.style.setProperty(
      "--chat-composer-popover-max-height",
      `${Math.max(0, composerTop - viewportTop - 28)}px`,
    );
  });
}

export async function openComposerLayoutFixture(page: Page, baseUrl: string, html: string) {
  try {
    const fixtureUrl = `${baseUrl}chat-responsive-fixture`;
    await page.route(fixtureUrl, (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><style>${readUiCss()}</style></head><body>${html}</body></html>`,
      }),
    );
    await page.goto(fixtureUrl);
    // Browser-owned source keeps these imports out of Vitest's SSR callback transform.
    await page.evaluate(`(async () => {
      const baseUrl = ${JSON.stringify(baseUrl)};
      await import(baseUrl + "src/components/composer-editor.ts");
      const { adjustTextareaHeight } = await import(
        baseUrl + "src/pages/chat/components/chat-composer-dom.ts"
      );
      const editor = document.querySelector("openclaw-composer-editor");
      editor.value = "Queued follow-up for the active operator session";
      editor.addEventListener("input", () => adjustTextareaHeight(editor));
      adjustTextareaHeight(editor);
    })()`);
    await syncFixtureComposerPopoverAnchor(page);
    return page;
  } catch (error) {
    await closeBrowserPage(page);
    throw error;
  }
}

export async function getTextContentRect(page: Page, selector: string) {
  const rect = await page.locator(selector).evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const bounds = range.getBoundingClientRect();
    range.detach();
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      width: bounds.width,
      height: bounds.height,
    };
  });
  expectFiniteRect({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
  return rect;
}

export async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    html: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
  }));
  expect(metrics.html).toBeLessThanOrEqual(metrics.viewport + 1);
  expect(metrics.body).toBeLessThanOrEqual(metrics.viewport + 1);
}
