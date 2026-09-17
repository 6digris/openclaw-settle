import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "External link affordances",
  browserLaunchOptions: {
    channel: "chromium",
    args: ["--font-render-hinting=none", "--force-color-profile=srgb"],
  },
});

async function expectInlineIndicator(link: Locator) {
  await link.scrollIntoViewIfNeeded();
  await link.getByRole("img", { name: "opens in a new tab", exact: true }).waitFor();
  expect(await link.getByRole("img", { name: "opens in a new tab", exact: true }).count()).toBe(1);
  const geometry = await link.evaluate(async (element) => {
    await document.fonts.ready;
    const indicator = element.querySelector("openclaw-external-link");
    const arrow = indicator?.shadowRoot?.querySelector("svg");
    if (!arrow || !indicator) {
      throw new Error("External destination has no visible arrow");
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let lastText: Text | undefined;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim()) {
        lastText = node as Text;
      }
    }
    if (!lastText) {
      throw new Error("External destination has no label");
    }
    const end = lastText.data.trimEnd().length;
    const range = document.createRange();
    range.setStart(lastText, end - 1);
    range.setEnd(lastText, end);
    return {
      text: range.getBoundingClientRect().toJSON(),
      arrow: arrow.getBoundingClientRect().toJSON(),
    };
  });
  expect(geometry.arrow.width).toBeGreaterThan(0);
  expect(geometry.arrow.left).toBeGreaterThanOrEqual(geometry.text.right - 1);
  expect(geometry.arrow.top).toBeLessThan(geometry.text.bottom);
  expect(geometry.arrow.bottom).toBeGreaterThan(geometry.text.top);
}

async function expectLabelPositionPreserved(link: Locator) {
  const boxes = await link.evaluate(async (element) => {
    const indicator = element.querySelector("openclaw-external-link");
    const label = indicator?.parentElement;
    if (!indicator || !label) {
      throw new Error("External destination has no indicator beside its label");
    }
    const range = document.createRange();
    range.setStart(label, 0);
    range.setEndBefore(indicator);
    const measure = () => {
      const text = range.getBoundingClientRect();
      const anchor = element.getBoundingClientRect();
      return {
        left: text.left - anchor.left,
        top: text.top,
        width: text.width,
        height: text.height,
      };
    };
    const nextSibling = indicator.nextSibling;
    indicator.remove();
    const withoutIndicator = measure();
    try {
      label.insertBefore(indicator, nextSibling);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { withoutIndicator, withIndicator: measure() };
    } finally {
      if (!indicator.isConnected) {
        label.insertBefore(indicator, nextSibling);
      }
    }
  });
  // A right-aligned link may grow to the left; its text must keep its position
  // within the link, vertical axis, and size when the indicator is inserted.
  expect(boxes.withIndicator).toEqual(boxes.withoutIndicator);
}

suite.define(() => {
  it.each([1280, 390])(
    "keeps external indicators inline across chat, menus, and buttons at %i px",
    async (width) => {
      await suite.withPage(
        {
          ...createControlUiE2eContextOptions(),
          deviceScaleFactor: 2,
          viewport: { width, height: 900 },
        },
        async ({ page }) => {
          const longLabel =
            "Read the complete documentation for configuring permissions and reviewing external destinations";
          await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: `[${longLabel}](https://example.test/guide)\n\n[Settings](/settings/about) and [Current session](/chat/main/cafebabe).`,
                  },
                ],
                timestamp: 1_700_000_000_000,
              },
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          const markdown = page.locator(".chat-group.assistant .chat-text");
          const external = markdown.locator('a[href="https://example.test/guide"]');
          await expectInlineIndicator(external);
          expect(
            await page
              .getByRole("link", {
                name: `${longLabel} opens in a new tab`,
                exact: true,
              })
              .count(),
          ).toBe(1);
          const selected = await external.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            const text = selection?.toString();
            selection?.removeAllRanges();
            return text;
          });
          expect(selected).toBe(longLabel);
          expect(await markdown.locator('a[href="/settings/about"]').count()).toBe(1);
          expect(await markdown.locator('a[data-session-href="/chat/main/cafebabe"]').count()).toBe(
            1,
          );
          expect(
            await markdown.locator('a[href="/settings/about"] openclaw-external-link').count(),
          ).toBe(0);
          expect(
            await markdown.locator('a[href="/chat/main/cafebabe"] openclaw-external-link').count(),
          ).toBe(0);
          await page.locator('[data-chat-permission-select="true"]').click();
          await expectInlineIndicator(page.locator(".chat-controls__permission-learn-more"));
          await expectLabelPositionPreserved(page.locator(".chat-controls__permission-learn-more"));
          expect(
            await page.locator("[data-chat-permission-option] openclaw-external-link").count(),
          ).toBe(0);
          await page.keyboard.press("Escape");

          if (width > 768) {
            const sidebar = page.locator("openclaw-app-sidebar");
            await sidebar.locator(".sidebar-identity-card").click();
            const help = sidebar.locator(".sidebar-identity-menu__help");
            await help.hover();
            const docs = help.locator('a[href="https://docs.openclaw.ai"]');
            await expectInlineIndicator(docs);
            expect(
              await sidebar.locator('[value="command:settings"] openclaw-external-link').count(),
            ).toBe(0);
            await page.keyboard.press("Escape");
          }

          await page.goto(`${suite.server.baseUrl}apps`);
          await expectInlineIndicator(page.locator("a.apps-card__cta").first());
          expect(await page.locator("button.apps-card__cta openclaw-external-link").count()).toBe(
            0,
          );
          await expectInlineIndicator(page.locator('.apps-pill[href="https://docs.openclaw.ai"]'));
        },
      );
    },
  );
});
