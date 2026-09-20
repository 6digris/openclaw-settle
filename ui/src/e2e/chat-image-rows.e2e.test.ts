import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI consecutive image rows" });

suite.define(() => {
  it.each([390, 1440])(
    "wraps fifty images at %i px without shrinking normal previews or moving text boundaries",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" },
        async ({ page }) => {
          const images = await page.evaluate(() =>
            Array.from({ length: 51 }, (_, index) => {
              const canvas = document.createElement("canvas");
              canvas.width = index % 2 ? 480 : 240;
              canvas.height = index % 2 ? 240 : 480;
              const context = canvas.getContext("2d")!;
              context.fillStyle = index % 2 ? "#435a3f" : "#155e75";
              context.fillRect(0, 0, canvas.width, canvas.height);
              context.fillStyle = "white";
              context.font = "48px sans-serif";
              context.fillText(String(index + 1), 24, 64);
              return {
                type: "image",
                url: canvas.toDataURL("image/png"),
                alt: "Volume image " + (index + 1),
                width: canvas.width,
                height: canvas.height,
              };
            }),
          );
          await installMockGateway(page, {
            historyMessages: [
              {
                role: "assistant",
                content: [
                  { type: "text", text: "The first comparison set." },
                  ...images.slice(0, 50),
                  { type: "text", text: "This paragraph starts a different set." },
                  { ...images[50], alt: "Separate image" },
                ],
                timestamp: 1_789_800_001_000,
                __openclaw: { id: "volume-images", seq: 1 },
              },
            ],
          });
          await page.goto(suite.server.baseUrl + "chat");
          const row = page.locator(".chat-group.assistant .chat-message-images").first();
          await row.waitFor({ state: "visible" });
          const frames = row.locator(".chat-image-frame");
          expect(await frames.count()).toBe(50);
          const positions = await frames.evaluateAll((elements) =>
            elements.map((element) => element.getBoundingClientRect().top),
          );
          expect(new Set(positions).size).toBeGreaterThan(1);
          if (width === 1440) {
            expect(positions[0]).toBe(positions[1]);
          } else {
            expect(positions[1]).toBeGreaterThan(positions[0]!);
          }
          expect(
            await row.evaluate((element) => element.scrollWidth - element.clientWidth),
          ).toBeLessThanOrEqual(1);
          const overflow = () =>
            page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
          expect(await overflow()).toBeLessThanOrEqual(1);
          const separate = page.getByRole("img", { name: "Separate image", exact: true });
          expect(await separate.count()).toBe(1);
          expect(await row.getByRole("img", { name: "Separate image", exact: true }).count()).toBe(
            0,
          );
          const last = row.getByRole("button", { name: "Open image Volume image 50", exact: true });
          await last.scrollIntoViewIfNeeded();
          await last.click();
          const lightbox = page.locator("openclaw-image-lightbox");
          await lightbox.getByRole("dialog").waitFor({ state: "visible" });
          expect(await lightbox.locator(".image").getAttribute("alt")).toBe("Volume image 50");
          await page.keyboard.press("Escape");
          await expect.poll(() => lightbox.getByRole("dialog").count()).toBe(0);
          expect(await overflow()).toBeLessThanOrEqual(1);
        },
      );
    },
  );
});
