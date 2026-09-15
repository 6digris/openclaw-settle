import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  captureUiProofEnabled,
  chatThreadDistanceFromBottom,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps progress open while a downward wheel gesture returns to the end", async () => {
    const proofDir = captureUiProofEnabled
      ? createControlUiE2eArtifactDir("progress-wheel-return")
      : null;
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      reducedMotion: "no-preference",
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:main";
    const runId = "progress-wheel-run";
    await installMockGateway(page, {
      sessionKey,
      featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
      historyMessages: Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        content: [
          { type: "text", text: `Workspace review ${index}.\n${"Earlier findings.\n".repeat(3)}` },
        ],
        timestamp: index + 1,
      })),
      inFlightRun: { runId, text: "Reviewing the workspace and checking the findings." },
      sessionInfo: { key: sessionKey, activeRunIds: [runId], hasActiveRun: true },
      methodResponses: {
        "progressCard.get": {
          card: {
            sessionKey,
            revision: 1,
            updatedAt: Date.now(),
            markdown: "Review the workspace, trace the relevant behavior, then verify the result.",
            steps: [
              { step: "Inspect the workspace", status: "in_progress" },
              { step: "Trace the relevant behavior", status: "pending" },
              { step: "Verify the result", status: "pending" },
            ],
          },
        },
      },
    });
    const card = page.locator('[data-progress-card-placement="composer"]');
    const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
    const samples: Array<{ open: boolean; top: number; distance: number }> = [];
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await card.locator(".session-progress-card__body").waitFor();
      await waitForChatScrollIdle(page);
      expect(await card.getAttribute("open")).toBe("");
      await thread.hover();
      await page.mouse.wheel(0, -32);
      await expect.poll(() => card.getAttribute("open")).toBeNull();
      await waitForChatScrollIdle(page);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "01-reading-history.png") });
      }
      // Deliver the next endward input after native layout changes the viewport,
      // before the queued resize-follow can move its offset. This is the frame
      // interleaving of a high-frequency trackpad gesture, without timing luck.
      const overlappingInput = thread.evaluate(
        (element) =>
          new Promise<boolean>((resolve) => {
            const progress = document.querySelector<HTMLDetailsElement>(
              '[data-progress-card-placement="composer"]',
            )!;
            const observer = new ResizeObserver(() => {
              const distance = element.scrollHeight - element.clientHeight - element.scrollTop;
              if (progress.open && distance > 8) {
                observer.disconnect();
                clearTimeout(timeout);
                element.dispatchEvent(new WheelEvent("wheel", { deltaY: 4, bubbles: true }));
                resolve(true);
              }
            });
            const timeout = setTimeout(() => {
              observer.disconnect();
              resolve(false);
            }, 2000);
            observer.observe(element);
          }),
      );
      await page.mouse.wheel(0, 4);
      expect(await overlappingInput).toBe(true);
      await waitForChatScrollIdle(page);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "02-overlapping-input.png") });
      }
      expect(await card.getAttribute("open")).toBe("");
      for (let index = 0; index < 24; index++) {
        await page.mouse.wheel(0, 4);
        await page.waitForTimeout(16);
        const sample = await thread.evaluate((element) => ({
          top: element.scrollTop,
          distance: element.scrollHeight - element.clientHeight - element.scrollTop,
        }));
        samples.push({ ...sample, open: (await card.getAttribute("open")) !== null });
      }
      await waitForChatScrollIdle(page);
      if (proofDir) {
        await page.screenshot({ path: path.join(proofDir, "02-after-downward-gesture.png") });
      }
      const firstOpen = samples.findIndex((sample) => sample.open);
      expect(firstOpen, JSON.stringify(samples)).toBeGreaterThanOrEqual(0);
      expect(
        samples.slice(firstOpen).every((sample) => sample.open),
        JSON.stringify(samples),
      ).toBe(true);
      expect(await card.getAttribute("open")).toBe("");
      expect(await chatThreadDistanceFromBottom(page)).toBeLessThanOrEqual(8);
    } finally {
      if (proofDir) {
        writeFileSync(path.join(proofDir, "samples.json"), JSON.stringify(samples, null, 2));
      }
      await context.close();
    }
  });
});
