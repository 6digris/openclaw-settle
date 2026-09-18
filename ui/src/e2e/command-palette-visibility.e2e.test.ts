import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette visibility" });
const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const emptySessions = { ts: 1, path: "", count: 0, defaults: {}, sessions: [] };
const agents = {
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name: "Assistant" },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: `search-${index}`,
      name: `Se Agent ${index}`,
    })),
  ],
};

async function openPalette(page: Page) {
  await page.goto(`${suite.server.baseUrl}new`);
  await page.locator(".shell").waitFor({ state: "visible" });
  await page.keyboard.press("ControlOrMeta+K");
  const input = page.locator(".cmd-palette__input:not([disabled])");
  await input.waitFor({ state: "visible" });
  await input.focus();
  await page.mouse.move(0, 0);
  return input;
}

async function readSelection(page: Page) {
  return page.locator(".cmd-palette__results").evaluate((results) => {
    const active = results.querySelector('[aria-selected="true"]');
    const input = document.querySelector(".cmd-palette__input");
    if (!active || !input) {
      throw new Error("Expected an active palette option and its input");
    }
    const bounds = results.getBoundingClientRect();
    const option = active.getBoundingClientRect();
    return {
      visible:
        option.top >= Math.max(0, bounds.top) - 1 &&
        option.bottom <= Math.min(innerHeight, bounds.bottom) + 1,
      focused: document.activeElement === input,
      bound: input.getAttribute("aria-activedescendant") === active.id,
      label: active.textContent?.replace(/\s+/gu, " ").trim(),
      scrollTop: results.scrollTop,
      documentScroll: document.documentElement.scrollTop,
    };
  });
}

async function expectVisibleSelection(page: Page, documentScroll: number) {
  await expect.poll(async () => (await readSelection(page)).visible).toBe(true);
  expect(await readSelection(page)).toMatchObject({
    focused: true,
    bound: true,
    documentScroll,
  });
}

async function settleFrames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

suite.define(() => {
  it.each([
    { width: 1280, height: 480 },
    { width: 844, height: 390 },
  ])("keeps the selected result visible after shrinking to $height px", async (viewport) => {
    await suite.withPage({ viewport: viewports[0] }, async ({ page }) => {
      await installMockGateway(page);
      const input = await openPalette(page);
      await input.press("ArrowUp");
      await expectVisibleSelection(page, 0);
      const selected = await readSelection(page);
      await settleFrames(page);

      await page.setViewportSize(viewport);
      await expectVisibleSelection(page, selected.documentScroll);
      expect((await readSelection(page)).label).toBe(selected.label);

      // Closing releases the old list; reopening must observe the new one.
      await input.press("Escape");
      await expect.poll(() => input.count()).toBe(0);
      await page.setViewportSize(viewports[0]);
      await page.keyboard.press("ControlOrMeta+K");
      await input.waitFor({ state: "visible" });
      await input.focus();
      await input.press("ArrowUp");
      await expectVisibleSelection(page, 0);
      await settleFrames(page);
      await page.setViewportSize(viewport);
      await expectVisibleSelection(page, 0);
      expect((await readSelection(page)).label).toBe(selected.label);
    });
  });

  it("preserves scrolling away from the selection when the result viewport shrinks", async () => {
    await suite.withPage({ viewport: viewports[0] }, async ({ page }) => {
      await installMockGateway(page);
      const input = await openPalette(page);
      await input.press("ArrowUp");
      await expectVisibleSelection(page, 0);
      const selected = await readSelection(page);
      const results = page.locator(".cmd-palette__results");
      const bounds = await results.boundingBox();
      if (!bounds) {
        throw new Error("Expected the palette result viewport");
      }
      await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, -1000);
      await page.mouse.move(0, 0);
      await expect.poll(async () => (await readSelection(page)).scrollTop).toBe(0);
      await settleFrames(page);
      const manual = await readSelection(page);
      expect(manual.visible).toBe(false);
      expect(manual.label).toBe(selected.label);

      await page.setViewportSize({ width: 1280, height: 480 });
      await settleFrames(page);
      expect(await readSelection(page)).toEqual(manual);
      await input.press("ArrowUp");
      await expectVisibleSelection(page, 0);
    });
  });

  it.each(viewports)(
    "reveals the selected result after filtering at $width px",
    async (viewport) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "sessions.list": { cases: [{ match: { search: "se" }, response: emptySessions }] },
          },
        });
        const input = await openPalette(page);
        const { documentScroll } = await readSelection(page);
        await input.press("ArrowUp");
        await expect.poll(async () => (await readSelection(page)).scrollTop).toBeGreaterThan(0);
        await input.press("s");
        await expectVisibleSelection(page, documentScroll);
        await input.press("e");
        await expect
          .poll(() => page.locator(".cmd-palette__results").getAttribute("aria-busy"))
          .toBe("false");
        await expectVisibleSelection(page, documentScroll);
        await input.press("Backspace");
        await expectVisibleSelection(page, documentScroll);
        await input.press("Backspace");
        await expectVisibleSelection(page, documentScroll);
        await input.press("Escape");
        await expect.poll(() => input.count()).toBe(0);
      });
    },
  );

  it.each(viewports)(
    "reveals the fallback when a delayed catalog replaces results at $width px",
    async (viewport) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "cron.list"],
          methodResponses: {
            "agents.list": agents,
            "sessions.list": { cases: [{ match: { search: "se" }, response: emptySessions }] },
          },
        });
        const input = await openPalette(page);
        const { documentScroll } = await readSelection(page);
        const previousRequests = (await gateway.getRequests("cron.list")).length;
        await gateway.deferNext("cron.list");
        await input.press("s");
        await input.press("e");
        await gateway.waitForRequest("cron.list", { after: previousRequests });
        expect(
          await page.getByRole("option", { name: "Se Agent 0 search-0", exact: true }).count(),
        ).toBe(0);
        await input.press("ArrowUp");
        await expect.poll(async () => (await readSelection(page)).scrollTop).toBeGreaterThan(0);
        const previous = await readSelection(page);
        await gateway.resolveDeferred("cron.list", { jobs: [] });
        await expect
          .poll(() => page.locator(".cmd-palette__results").getAttribute("aria-busy"))
          .toBe("false");
        await expect
          .poll(() => page.locator(".cmd-palette__results").textContent())
          .toContain("Se Agent 0");
        expect((await readSelection(page)).label).not.toBe(previous.label);
        await expectVisibleSelection(page, documentScroll);
      });
    },
  );

  it.each(viewports)(
    "keeps an explicit choice visible when session results arrive at $width px",
    async (viewport) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const gateway = await installMockGateway(page);
        const input = await openPalette(page);
        await gateway.deferNext("sessions.list", { search: "se" });
        await input.press("s");
        await input.press("e");
        await gateway.waitForRequest("sessions.list", { match: { search: "se" } });
        await expect
          .poll(() => page.locator(".cmd-palette__results").getAttribute("aria-busy"))
          .toBe("true");
        await input.press("ArrowDown");
        await expectVisibleSelection(page, 0);
        const selected = await readSelection(page);
        await gateway.resolveDeferred("sessions.list", {
          ...emptySessions,
          count: 10,
          sessions: Array.from({ length: 10 }, (_, index) => ({
            key: `agent:main:search-${index}`,
            kind: "direct",
            displayName: `Se Chat ${index}`,
            updatedAt: 1,
          })),
        });
        await expect
          .poll(() => page.locator(".cmd-palette__results").getAttribute("aria-busy"))
          .toBe("false");
        await expect
          .poll(() => page.locator(".cmd-palette__results").textContent())
          .toContain("Se Chat 9");
        expect((await readSelection(page)).label).toBe(selected.label);
        await expectVisibleSelection(page, selected.documentScroll);
      });
    },
  );

  it("preserves pointer selection and manual scrolling through an unchanged catalog refresh", async () => {
    await suite.withPage({ viewport: viewports[0] }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "cron.list"],
        methodResponses: {
          "agents.list": agents,
          "sessions.list": { cases: [{ match: { search: "se" }, response: emptySessions }] },
        },
      });
      const input = await openPalette(page);
      await input.press("s");
      await input.press("e");
      const results = page.locator(".cmd-palette__results");
      await expect.poll(() => results.getAttribute("aria-busy")).toBe("false");
      const option = results.getByRole("option").nth(1);
      await option.hover();
      await expect.poll(() => option.getAttribute("aria-selected")).toBe("true");
      const pointerSelection = await readSelection(page);
      // Wheel over the scrollbar so passing rows do not change the pointer selection.
      const scrollbar = await results.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: bounds.right - 1,
          y: bounds.top + bounds.height / 2,
          distance: element.scrollHeight,
        };
      });
      await page.mouse.move(scrollbar.x, scrollbar.y);
      await page.mouse.wheel(0, scrollbar.distance);
      await page.mouse.move(0, 0);
      await expect
        .poll(async () => (await readSelection(page)).scrollTop)
        .toBeGreaterThan(pointerSelection.scrollTop);
      await settleFrames(page);
      const manual = await readSelection(page);
      expect(manual.label).toBe(pointerSelection.label);
      expect(manual.visible).toBe(false);
      const previousRequests = (await gateway.getRequests("cron.list")).length;
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await gateway.waitForRequest("cron.list", { after: previousRequests });
      await expect.poll(() => results.getAttribute("aria-busy")).toBe("false");
      await settleFrames(page);
      expect(await readSelection(page)).toEqual(manual);
    });
  });
});
