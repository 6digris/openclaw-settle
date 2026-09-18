import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Composer menu pointer intent" });

// Hit testing after layout can deliver boundary events on the following frame.
async function settlePointerBoundary(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

suite.define(() => {
  it.each([390, 1440])(
    "keeps the first suggestion when typing opens the menu under a stationary pointer at %spx",
    async (width) => {
      await suite.withPage(
        {
          viewport: { width, height: width === 390 ? 844 : 900 },
          deviceScaleFactor: 2,
          reducedMotion: "no-preference",
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "sessions.list": {
                count: 2,
                defaults: { contextTokens: null, model: null, modelProvider: null },
                path: "",
                sessions: ["Recent work", "Another task"].map((label, index) => ({
                  key: `agent:main:dashboard:recent${index + 1}`,
                  kind: "direct",
                  label,
                  updatedAt: Date.now() - index * 1000,
                })),
                ts: Date.now(),
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}new?agent=main`);
          const composer = page.locator(".new-session-page__message");
          const secondary = page.locator(".agent-chat__welcome-secondary");
          const waitForExpandedWelcome = async () => {
            await expect
              .poll(() =>
                secondary.evaluate(
                  (element) =>
                    element.getBoundingClientRect().height > 0 &&
                    getComputedStyle(element).opacity === "1" &&
                    element.getAnimations().length === 0,
                ),
              )
              .toBe(true);
          };
          const waitForCollapsedWelcome = async () => {
            await expect
              .poll(() => secondary.evaluate((element) => element.getBoundingClientRect().height))
              .toBe(0);
            await settlePointerBoundary(page);
          };
          await expect.poll(() => page.locator(".agent-chat__recent").count()).toBe(2);
          await waitForExpandedWelcome();
          await expect.poll(() => composer.isEnabled()).toBe(true);
          await composer.click();
          const before = await composer.boundingBox();
          expect(before).not.toBeNull();

          // The real click leaves the pointer over the input; only the keyboard opens the menu.
          await page.keyboard.type("/");
          const picker = page.locator(".slash-menu[role='listbox']");
          const options = picker.getByRole("option");
          await picker.waitFor({ state: "visible" });
          if (width === 390) {
            await expect
              .poll(async () => (await composer.boundingBox())!.y)
              .toBeGreaterThan(before!.y);
          }
          await waitForCollapsedWelcome();
          if (width === 390) {
            expect(
              await page.evaluate(
                ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[role="option"]')),
                { x: before!.x + before!.width / 2, y: before!.y + before!.height / 2 },
              ),
            ).toBe(true);
          }
          expect(await options.first().getAttribute("aria-selected")).toBe("true");
          expect(await composer.getAttribute("aria-activedescendant")).toBe(
            await options.first().getAttribute("id"),
          );
          expect(await composer.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );

          await page.keyboard.press("Escape");
          await expect.poll(() => picker.count()).toBe(0);
          expect(await composer.inputValue()).toBe("/");
          expect(await composer.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );
          await page.keyboard.press("Backspace");
          await waitForExpandedWelcome();
          await page.keyboard.type("/");
          await picker.waitFor({ state: "visible" });
          await waitForCollapsedWelcome();
          expect(await options.first().getAttribute("aria-selected")).toBe("true");
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    },
  );

  it.each(["new", "chat"])(
    "preserves keyboard selection through stationary wheel scrolling and accepts pointer intent in %s",
    async (route) => {
      await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}${route}`);
        const composer = page.locator(
          route === "new"
            ? ".new-session-page__message"
            : ".agent-chat__composer-combobox textarea",
        );
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await composer.fill("/");
        const picker = page.locator(".slash-menu[role='listbox']");
        const scroll = picker.locator(".slash-menu__scroll");
        const options = picker.getByRole("option");
        await picker.waitFor({ state: "visible" });
        const second = options.nth(1);
        await second.hover();
        await expect.poll(() => second.getAttribute("aria-selected")).toBe("true");
        const secondId = await second.getAttribute("id");
        await page.mouse.wheel(0, 180);
        await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await settlePointerBoundary(page);
        expect(await composer.getAttribute("aria-activedescendant")).toBe(secondId);
        expect(await second.getAttribute("aria-selected")).toBe("true");

        await page.keyboard.press("ArrowDown");
        await expect.poll(() => options.nth(2).getAttribute("aria-selected")).toBe("true");
        await settlePointerBoundary(page);
        expect(await composer.getAttribute("aria-activedescendant")).toBe(
          await options.nth(2).getAttribute("id"),
        );
        expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);

        // Filtering replaces rows beneath the pointer but starts at the first result.
        await composer.fill("/ski");
        await settlePointerBoundary(page);
        expect(await options.first().getAttribute("aria-selected")).toBe("true");
        await page.keyboard.press("Escape");
        await expect.poll(() => picker.count()).toBe(0);
        expect(await composer.inputValue()).toBe("/ski");

        // Pointer selection still completes a command without sending a chat turn.
        await composer.fill("/skill");
        await options.first().waitFor({ state: "visible" });
        await options.first().click();
        await expect.poll(() => composer.inputValue()).toBe("/skill ");
        await expect.poll(() => picker.count()).toBe(0);
        expect(await composer.evaluate((element) => element === document.activeElement)).toBe(true);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );
});
