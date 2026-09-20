import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Expanded video gallery" });
const video = readFileSync(new URL("./fixtures/video-poster.mp4", import.meta.url));

suite.define(() => {
  it.each([false, true])(
    "navigates the whole turn and preserves player controls (touch=%s)",
    async (mobile) => {
      await suite.withPage(
        {
          viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
          hasTouch: mobile,
          isMobile: mobile,
        },
        async ({ page, context }) => {
          const dir = createControlUiE2eArtifactDir(
            mobile ? "video-gallery-mobile" : "video-gallery-desktop",
          );
          await page.route("**/gallery-proof/*.mp4", (route) =>
            route.fulfill({ contentType: "video/mp4", body: video }),
          );
          const gateway = await installMockGateway(page, {
            historyMessages: [
              { role: "user", content: "Compare these clips.", timestamp: 1800000000000 },
              {
                role: "assistant",
                content:
                  "**Before**\nMEDIA:https://example.com/gallery-proof/before.mp4\n\n**After**\nMEDIA:https://example.com/gallery-proof/after.mp4",
                timestamp: 1800000001000,
              },
              {
                role: "assistant",
                content: "**Alternate**\nMEDIA:https://example.com/gallery-proof/alternate.mp4",
                timestamp: 1800000002000,
              },
              { role: "user", content: "A separate turn.", timestamp: 1800000003000 },
              {
                role: "assistant",
                content: "MEDIA:https://example.com/gallery-proof/separate.mp4",
                timestamp: 1800000004000,
              },
            ],
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await gateway.waitForRequest("chat.startup");
          const expand = page.getByRole("button", {
            name: "Expand before.mp4 in the media overlay",
            exact: true,
          });
          await expand.scrollIntoViewIfNeeded();
          await expand.waitFor();
          await page.screenshot({ path: `${dir}/inline.png` });
          await expand.click();
          const viewer = page.locator("openclaw-image-lightbox");
          const player = viewer.locator("video");
          const counter = viewer.locator(".gallery-counter");
          await expect
            .poll(() => player.evaluate((media: HTMLVideoElement) => media.readyState))
            .toBeGreaterThanOrEqual(2);
          await expect.poll(async () => (await counter.textContent())?.trim()).toBe("1 / 3");
          await page.screenshot({ path: `${dir}/expanded-first.png` });
          await page.keyboard.press("ArrowRight");
          await expect.poll(() => player.getAttribute("src")).toContain("after.mp4");
          await page.keyboard.press("ArrowRight");
          await expect.poll(() => player.getAttribute("src")).toContain("alternate.mp4");
          await page.keyboard.press("ArrowRight");
          expect((await counter.textContent())?.trim()).toBe("3 / 3");
          await page.keyboard.press("ArrowLeft");
          await expect.poll(() => player.getAttribute("src")).toContain("after.mp4");
          await page.screenshot({ path: `${dir}/expanded-next.png` });

          await player.focus();
          await page.keyboard.press("ArrowRight");
          expect((await counter.textContent())?.trim()).toBe("2 / 3");
          await player.evaluate(async (media: HTMLVideoElement) => {
            media.pause();
            media.currentTime = 0.25;
            media.volume = 0.4;
            media.muted = true;
            await media.play();
          });
          expect(
            await player.evaluate(
              (media: HTMLVideoElement) => media.controls && media.volume === 0.4 && media.muted,
            ),
          ).toBe(true);
          const retained = await player.elementHandle();
          if (mobile) {
            const touch = await context.newCDPSession(page);
            const swipe = async (dx: number) => {
              const box = await player.boundingBox();
              if (!box) {
                throw new Error("Missing video geometry");
              }
              const point = { x: box.x + box.width / 2, y: box.y + box.height / 3, id: 1 };
              await touch.send("Input.dispatchTouchEvent", {
                type: "touchStart",
                touchPoints: [point],
              });
              for (let step = 1; step <= 5; step++) {
                await touch.send("Input.dispatchTouchEvent", {
                  type: "touchMove",
                  touchPoints: [{ ...point, x: point.x + (dx * step) / 5 }],
                });
              }
              await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
            };
            await swipe(-100);
            await expect.poll(() => player.getAttribute("src")).toContain("alternate.mp4");
            await swipe(100);
            await expect.poll(() => player.getAttribute("src")).toContain("after.mp4");
            await touch.detach();
          }
          await viewer.getByRole("button", { name: "Close video preview", exact: true }).focus();
          await page.keyboard.press("Escape");
          await expect.poll(() => viewer.count()).toBe(0);
          expect(
            await retained?.evaluate(
              (media: HTMLVideoElement) => media.paused && !media.hasAttribute("src"),
            ),
          ).toBe(true);
          await retained?.dispose();
          await expect
            .poll(() => expand.evaluate((element) => element.matches(":focus")))
            .toBe(true);
          await page
            .getByRole("button", { name: "Expand separate.mp4 in the media overlay", exact: true })
            .click();
          expect(await viewer.locator(".gallery-counter").count()).toBe(0);
          await page.keyboard.press("Escape");
        },
      );
    },
  );
});
