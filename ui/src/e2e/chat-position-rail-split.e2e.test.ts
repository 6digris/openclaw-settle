import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({ name: "Split rail Escape ownership" });
suite.define(() => {
  it.each([
    { hoverPane: 0, vertical: false, entry: "existing" },
    { hoverPane: 1, vertical: false, entry: "existing" },
    { hoverPane: 0, vertical: true, entry: "existing" },
    { hoverPane: 0, vertical: false, entry: "pointer" },
    { hoverPane: 0, vertical: true, entry: "programmatic" },
  ])(
    "keeps local rails and returns Escape to pane $hoverPane (vertical: $vertical, entry: $entry)",
    async ({ hoverPane, vertical, entry }) => {
      // Each transcript must exceed the CSS 960px rail threshold after sidebar/split chrome.
      await suite.withPage(
        { viewport: { width: 2560, height: vertical ? 1600 : 1000 } },
        async ({ page }) => {
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const keys = ["agent:main:main", "agent:main:notes"];
          await page.addInitScript(
            ({ key, keys: sessionKeys, vertical }) =>
              localStorage.setItem(
                key,
                JSON.stringify({
                  chatSplitLayout: {
                    activePaneId: "p1",
                    columnWeights: vertical ? [1] : [0.5, 0.5],
                    columns: vertical
                      ? [
                          {
                            id: "c1",
                            paneWeights: [0.5, 0.5],
                            panes: sessionKeys.map((sessionKey, i) => ({
                              id: `p${i + 1}`,
                              sessionKey,
                            })),
                          },
                        ]
                      : sessionKeys.map((sessionKey, i) => ({
                          id: `c${i + 1}`,
                          paneWeights: [1],
                          panes: [{ id: `p${i + 1}`, sessionKey }],
                        })),
                  },
                }),
              ),
            { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), keys, vertical },
          );
          const gateway = await installMockGateway(page, {
            sessionKey: keys[0],
            sessions: keys.map((key) => ({ key, kind: "direct", updatedAt: 1 })),
            historyMessages: Array.from({ length: 30 }, (_, index) => ({
              __openclaw: { id: `split-rail-${index}`, seq: index + 1 },
              role: index % 2 ? "assistant" : "user",
              content: `Visible split checkpoint ${index}`,
              timestamp: 1000 + index,
            })),
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.locator(".sidebar-brand__collapse").click();
          const a = page
            .locator("openclaw-chat-pane")
            .filter({ has: page.locator(".chat-position-rail-anchor") })
            .nth(hoverPane);
          const b = page
            .locator("openclaw-chat-pane")
            .filter({ has: page.locator(".chat-position-rail-anchor") })
            .nth(1 - hoverPane);
          const railA = page.locator(
            `#${await a.locator(".chat-position-rail-anchor").getAttribute("aria-controls")}`,
          );
          const railB = page.locator(
            `#${await b.locator(".chat-position-rail-anchor").getAttribute("aria-controls")}`,
          );
          for (const rail of [railA, railB]) {
            await expect.poll(() => rail.getAttribute("data-placement")).toBe("pane");
          }
          await railA.locator(".chat-position-rail__marker").last().waitFor({ state: "visible" });
          await railB.locator(".chat-position-rail__marker").last().waitFor({ state: "visible" });
          const threadB = b.locator(".chat-thread");
          const previewA = railA.locator(".chat-position-rail__preview");
          const previewB = railB.locator(".chat-position-rail__preview");
          if (entry !== "existing") {
            const threadA = a.locator(".chat-thread");
            const cellA = a.locator(
              "xpath=ancestor::*[contains(@class,'chat-split-view__cell')][1]",
            );
            const cellB = b.locator(
              "xpath=ancestor::*[contains(@class,'chat-split-view__cell')][1]",
            );
            await threadB.focus();
            await expect.poll(() => cellB.getAttribute("aria-current")).toBe("true");
            expect(await cellA.getAttribute("aria-current")).not.toBe("true");
            const marker = railA.locator(".chat-position-rail__marker").first();
            await railA.locator(".chat-position-rail__marks").evaluate((el) => {
              el.scrollTop = 0;
            });
            await marker.waitFor({ state: "visible" });
            const originalMarker = (await marker.elementHandle())!;
            const originalRail = (await railA.elementHandle())!;
            const beforeScroll = await threadA.evaluate((el) => el.scrollTop);
            expect(beforeScroll).toBeGreaterThan(0);
            if (entry === "pointer") {
              await marker.hover();
              const before = (await marker.boundingBox())!;
              await page.mouse.down();
              await expect.poll(() => cellA.getAttribute("aria-current")).toBe("true");
              await page.evaluate(
                () =>
                  new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                  ),
              );
              const during = (await marker.boundingBox())!;
              expect(during).toEqual(before);
              expect(await threadA.evaluate((el) => el.scrollTop)).toBe(beforeScroll);
              await page.mouse.up();
            } else {
              await marker.focus();
              await expect.poll(() => cellA.getAttribute("aria-current")).toBe("true");
              await page.keyboard.press("Enter");
            }
            await expect.poll(() => cellA.getAttribute("aria-current")).toBe("true");
            await expect
              .poll(() => a.evaluate((el) => (el as HTMLElement & { active: boolean }).active))
              .toBe(true);
            await expect
              .poll(() => b.evaluate((el) => (el as HTMLElement & { active: boolean }).active))
              .toBe(false);
            await expect.poll(() => threadA.evaluate((el) => el.scrollTop)).toBe(0);
            expect(await originalMarker.evaluate((el) => el.isConnected)).toBe(true);
            expect(await originalRail.evaluate((el) => el.isConnected)).toBe(true);
            expect(await page.locator(".chat-position-rail").count()).toBe(2);
            expect(errors).toEqual([]);
            return;
          }
          // Park the real pointer on A, then enter B with the established transcript→Tab path.
          await railA.locator(".chat-position-rail__marker").last().hover();
          await previewA.waitFor({ state: "visible" });
          await threadB.focus();
          await page.keyboard.press("Tab");
          await expect
            .poll(() => railB.evaluate((el) => el.contains(document.activeElement)))
            .toBe(true);
          await previewB.waitFor({ state: "visible" });
          await expect.poll(() => previewA.isVisible()).toBe(true);
          await page.screenshot({
            path: path.join(suite.artifactDir, `pane-${hoverPane}-before-escape.png`),
          });
          await page.keyboard.press("Escape");
          await page.screenshot({
            path: path.join(suite.artifactDir, `pane-${hoverPane}-after-escape.png`),
          });
          await expect
            .poll(() => threadB.evaluate((el) => el === document.activeElement))
            .toBe(true);
          await expect.poll(() => previewB.count()).toBe(0);
          await expect.poll(() => previewA.isVisible()).toBe(true);
          // With no focused marker, Escape still dismisses the remaining hover without moving focus.
          await page.keyboard.press("Escape");
          await expect.poll(() => previewA.count()).toBe(0);
          expect(await threadB.evaluate((el) => el === document.activeElement)).toBe(true);
          expect(
            (await gateway.getRequests()).filter(({ method }) => method === "chat.send"),
          ).toEqual([]);
          expect(errors).toEqual([]);
        },
      );
    },
  );
});
