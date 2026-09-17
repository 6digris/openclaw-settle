import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { COMMUNITY_DISCORD_URL } from "../lib/product-links.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Product navigation indicators",
  browserLaunchOptions: {
    channel: "chromium",
    args: ["--font-render-hinting=none", "--force-color-profile=srgb"],
  },
});

async function expectNoIndicator(surface: Locator) {
  await surface.first().waitFor();
  expect(await surface.locator("openclaw-external-link, .external-link-indicator").count()).toBe(0);
}

async function indicatorGeometry(link: Locator) {
  await link.scrollIntoViewIfNeeded();
  const indicator = link.getByRole("img", { name: "opens in a new tab", exact: true });
  await indicator.waitFor();
  expect(await indicator.count()).toBe(1);
  return indicator.evaluate((element) => {
    const arrow = element.querySelector("svg");
    const anchor = element.closest("a");
    if (!arrow || !anchor) {
      throw new Error("Navigation indicator has no arrow or link");
    }
    const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
    let text: Node | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.trim()) {
        text = node;
      }
    }
    if (!text) {
      throw new Error("Navigation link has no label");
    }
    const range = document.createRange();
    range.selectNodeContents(text);
    const labelBox = range.getBoundingClientRect();
    const arrowBox = arrow.getBoundingClientRect();
    const labelStyle = getComputedStyle(text.parentElement!);
    const arrowStyle = getComputedStyle(arrow);
    return {
      right: arrowBox.right,
      width: arrowBox.width,
      overlap: Math.min(labelBox.bottom, arrowBox.bottom) - Math.max(labelBox.top, arrowBox.top),
      labelSize: Number.parseFloat(labelStyle.fontSize),
      labelColor: labelStyle.color,
      arrowColor: arrowStyle.color,
    };
  });
}

suite.define(() => {
  it.each([1280, 390])("limits arrows to explicit product navigation at %i px", async (width) => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        deviceScaleFactor: 2,
        viewport: { width, height: 900 },
      },
      async ({ page }) => {
        const label =
          "Read the complete documentation for configuring permissions and reviewing external destinations";
        await installMockGateway(page, {
          historyMessages: [
            {
              role: "assistant",
              timestamp: 1_700_000_000_000,
              content: [
                {
                  type: "text",
                  text: `[${label}](https://example.test/guide)\n\nhttps://example.test/printed\n\nhttps://github.com/openclaw/openclaw/issues/150454\n\n[Settings](/settings/about) and [Current session](/chat/main/cafebabe).`,
                },
              ],
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const markdown = page.locator(".chat-group.assistant .chat-text");
        const external = markdown.locator('a[href="https://example.test/guide"]');
        await external.waitFor();
        await expectNoIndicator(markdown);
        expect(await markdown.locator("a.markdown-github-item").textContent()).toBe("#150454");
        expect(await page.getByRole("link", { name: label, exact: true }).count()).toBe(1);
        expect(
          await external.evaluate((element) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            const selected = selection?.toString();
            selection?.removeAllRanges();
            return selected;
          }),
        ).toBe(label);

        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        await page.locator("[data-chat-permission-select]").click();
        const permission = await indicatorGeometry(
          page.locator(".chat-controls__permission-learn-more"),
        );
        expect(permission.width).toBeLessThan(permission.labelSize);
        expect(permission.overlap).toBeGreaterThan(0);
        await page.keyboard.press("Escape");

        if (width > 768) {
          const sidebar = page.locator("openclaw-app-sidebar");
          await sidebar.locator(".sidebar-identity-card").click();
          const help = sidebar.locator(".sidebar-identity-menu__help");
          await help.hover();
          const links = help.locator("a");
          expect(await links.count()).toBe(4);
          const boxes = [];
          for (const link of await links.all()) {
            const box = await indicatorGeometry(link);
            expect(box.width).toBeGreaterThan(0);
            expect(box.width).toBeLessThan(box.labelSize);
            expect(box.overlap).toBeGreaterThan(0);
            expect(box.arrowColor).not.toBe(box.labelColor);
            boxes.push(box);
          }
          expect(
            Math.max(...boxes.map((box) => box.right)) - Math.min(...boxes.map((box) => box.right)),
          ).toBeLessThanOrEqual(1);
          await page.keyboard.press("Escape");
        }

        await page.goto(`${suite.server.baseUrl}apps`);
        await expectNoIndicator(
          page.locator('a.apps-card__cta[href="https://github.com/openclaw/openclaw/releases"]'),
        );
        const docs = await indicatorGeometry(
          page.locator('a.apps-card__cta[href="https://docs.openclaw.ai/platforms/macos"]'),
        );
        expect(docs.overlap).toBeGreaterThan(0);
        await expectNoIndicator(page.locator(`.apps-pill[href="${COMMUNITY_DISCORD_URL}"]`));
        await page.goto(`${suite.server.baseUrl}settings/about`);
        await expectNoIndicator(page.locator(".about-hero__links"));
      },
    );
  });
});
