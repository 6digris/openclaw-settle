import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI filtered command visibility" });
const viewports = [
  { width: 1440, height: 844 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
];
const scenarios = ["chat", "new"].flatMap((route) =>
  viewports.map(({ width, height }) => ({ route, width, height })),
);

suite.define(() => {
  it.each(scenarios)(
    "keeps the filtered active result visible in $route at $width x $height",
    async ({ route, width, height }) => {
      await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
        const choices = Array.from({ length: 24 }, (_, index) => `choice-${index}`);
        const commands = Array.from({ length: 28 }, (_, index) => ({
          acceptsArgs: true,
          args: [{ name: "choice", choices }],
          category: "tools",
          description: "Synthetic helper command.",
          name: `helper-${String(index).padStart(2, "0")}`,
          scope: "both",
          source: "plugin",
          textAliases: [`/helper-${String(index).padStart(2, "0")}`],
        }));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "commands.list": { commands },
            "chat.metadata": { commands, models: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}${route}`);
        const composer = page.locator(".agent-chat__composer-combobox textarea:visible").last();
        await composer.waitFor();
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await composer.fill("/");
        await page.mouse.move(0, 0);
        const menu = page.locator(".slash-menu[role=listbox]");
        const scroll = menu.locator(".slash-menu__scroll");
        const options = menu.getByRole("option");
        await menu
          .getByRole("option")
          .filter({ hasText: "/helper-27" })
          .waitFor({ state: "attached" });
        const originalViewport = await scroll.elementHandle();
        const outerScroll = () =>
          composer.evaluate((element) => {
            const positions = [window.scrollX, window.scrollY];
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              positions.push(parent.scrollLeft, parent.scrollTop);
            }
            const transcript = document.querySelector(".chat-thread");
            positions.push(transcript?.scrollTop ?? 0);
            return positions;
          });
        const assertActiveVisible = async () => {
          await expect
            .poll(() =>
              composer.evaluate((element) => {
                const id = element.getAttribute("aria-activedescendant");
                const active = id ? document.getElementById(id) : null;
                const region = active?.closest(".slash-menu__scroll");
                const optionBounds = active?.getBoundingClientRect();
                const menuBounds = region?.getBoundingClientRect();
                return Boolean(
                  active?.getAttribute("aria-selected") === "true" &&
                  optionBounds &&
                  menuBounds &&
                  optionBounds.top >= menuBounds.top &&
                  optionBounds.bottom <= menuBounds.bottom,
                );
              }),
            )
            .toBe(true);
          expect(await menu.locator('[aria-selected="true"]').count()).toBe(1);
          expect(await composer.evaluate((element) => document.activeElement === element)).toBe(
            true,
          );
        };
        const outsideBefore = await outerScroll();
        for (let index = 0; index < 18; index += 1) {
          await composer.press("ArrowDown");
        }
        await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        await composer.pressSequentially("he");
        await expect.poll(() => options.first().getAttribute("aria-selected")).toBe("true");
        await assertActiveVisible();
        expect(
          await scroll.evaluate((element, original) => element === original, originalViewport),
        ).toBe(true);
        expect(await outerScroll()).toEqual(outsideBefore);

        // An unchanged input rerenders the menu without taking back a user's scroll.
        await scroll.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const manualScroll = await scroll.evaluate((element) => element.scrollTop);
        await composer.dispatchEvent("input");
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        });
        expect(await scroll.evaluate((element) => element.scrollTop)).toBe(manualScroll);

        await composer.press("Backspace");
        await assertActiveVisible();
        await composer.press("Backspace");
        await assertActiveVisible();
        await composer.fill("/helper-");
        await assertActiveVisible();
        for (let index = 0; index < 18; index += 1) {
          await composer.press("ArrowDown");
        }
        await assertActiveVisible();
        // Both events precede the next frame, so the arrow scroll is still pending.
        await composer.evaluate((element) => {
          if (!(element instanceof HTMLTextAreaElement)) {
            throw new Error("Expected composer textarea");
          }
          element.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
          );
          element.value += "1";
          element.dispatchEvent(
            new InputEvent("input", { bubbles: true, data: "1", inputType: "insertText" }),
          );
        });
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
        });
        await assertActiveVisible();
        await composer.fill("/helper-");
        await assertActiveVisible();
        await composer.press("ArrowUp");
        await expect.poll(() => options.last().getAttribute("aria-selected")).toBe("true");
        await assertActiveVisible();
        await composer.press("ArrowDown");
        await expect.poll(() => options.first().getAttribute("aria-selected")).toBe("true");
        await assertActiveVisible();

        await composer.press("Tab");
        await expect.poll(() => composer.inputValue()).toBe("/helper-00 ");
        await expect.poll(() => options.count()).toBe(choices.length);
        await assertActiveVisible();
        for (let index = 0; index < 18; index += 1) {
          await composer.press("ArrowDown");
        }
        await assertActiveVisible();
        await composer.fill("/no-such-command-150615");
        await expect.poll(() => menu.count()).toBe(0);
        await composer.fill("/helper-");
        await assertActiveVisible();
        await composer.press("Escape");
        await expect.poll(() => menu.count()).toBe(0);
        expect(await composer.inputValue()).toBe("/helper-");
        expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
        await composer.fill("");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );
});
