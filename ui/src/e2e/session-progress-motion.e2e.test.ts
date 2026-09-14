import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
type InspectedAnimation = {
  id: string;
  name: string;
  type: string;
  source?: { duration: number; backendNodeId?: number };
};

suite.define(() => {
  it.each(["no-preference", "reduce"] as const)(
    "folds task progress smoothly without an abrupt start (%s)",
    async (reducedMotion) => {
      const proofDir = captureUiProofEnabled
        ? path.join(suite.artifactDir, "session-progress-motion", reducedMotion)
        : null;
      if (proofDir) {
        await mkdir(proofDir, { recursive: true });
      }
      const context = await suite.newBrowserContext({
        ...createControlUiE2eContextOptions(),
        reducedMotion,
        ...(proofDir ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } } : {}),
      });
      const page = await context.newPage();
      const video = page.video();
      const sessionKey = "agent:main:main";
      await installMockGateway(page, {
        sessionKey,
        featureMethods: ["chat.metadata", "chat.startup", "progressCard.get"],
        historyMessages: Array.from({ length: 40 }, (_, index) => ({
          role: index % 2 ? "assistant" : "user",
          content: [{ type: "text", text: `History ${index}\n${"Reading context.\n".repeat(3)}` }],
          timestamp: index + 1,
        })),
        methodResponses: {
          "progressCard.get": {
            card: {
              sessionKey,
              revision: 1,
              updatedAt: Date.now(),
              markdown: "Checking the task progress interaction.",
              steps: [
                { step: "Inspect the current behavior", status: "completed" },
                { step: "Make the closing motion gentle", status: "in_progress" },
                { step: "Verify the reading position stays put", status: "pending" },
              ],
            },
          },
        },
      });
      const cardSelector = '[data-progress-card-placement="composer"]';
      const card = page.locator(cardSelector);
      const cardHeight = () => card.evaluate((element) => element.getBoundingClientRect().height);
      const observed = new Map<string, InspectedAnimation>();
      let contentBackendNodeId: number | undefined;
      let phase = "setup";
      try {
        await page.goto(`${suite.server.baseUrl}chat`);
        await card.locator(".session-progress-card__body").waitFor();
        await waitForChatScrollIdle(page);
        if (proofDir) {
          await writeFile(
            path.join(proofDir, "crop.json"),
            JSON.stringify(await card.boundingBox()),
          );
          await page.waitForTimeout(400); // Recording-only pacing, not an assertion wait.
        }
        await page.locator(".chat-thread").hover();
        await page.mouse.wheel(0, -600);
        await expect.poll(() => card.getAttribute("open")).toBeNull();
        await waitForChatScrollIdle(page);
        const closed = await cardHeight();
        if (proofDir) {
          await page.waitForTimeout(400);
        }
        await page.locator('.chat-scroll-to-bottom[data-visible="true"]').click();
        await expect.poll(() => card.getAttribute("open")).toBe("");
        await waitForChatScrollIdle(page);
        const before = await cardHeight();
        expect(before - closed).toBeGreaterThan(50);
        if (proofDir) {
          await page.waitForTimeout(400);
        }

        // Native details content lives in the UA shadow tree, outside
        // Element.getAnimations(). The inspector freezes its real CSS timeline
        // so curve assertions do not depend on runner frame rate or sleeps.
        const inspector = await context.newCDPSession(page);
        const { root } = await inspector.send("DOM.getDocument", {
          depth: 1,
        });
        const { nodeIds } = await inspector.send("DOM.querySelectorAll", {
          nodeId: root.nodeId,
          selector: cardSelector,
        });
        expect(nodeIds, "composer progress card").toHaveLength(1);
        const { node } = await inspector.send("DOM.describeNode", {
          nodeId: nodeIds[0]!,
          depth: 2,
          pierce: true,
        });
        const shadowRoots =
          node.shadowRoots?.filter((root) => root.shadowRootType === "user-agent") ?? [];
        expect(shadowRoots, "progress card UA shadow root").toHaveLength(1);
        const contentSlots =
          shadowRoots[0]!.children?.filter(
            (child) =>
              child.nodeName === "SLOT" &&
              child.attributes?.some(
                (attribute, index, attributes) =>
                  index % 2 === 0 &&
                  attribute === "id" &&
                  attributes[index + 1] === "details-content",
              ),
          ) ?? [];
        expect(contentSlots, "progress card details-content slot").toHaveLength(1);
        contentBackendNodeId = contentSlots[0]!.backendNodeId;
        expect(contentBackendNodeId).toBeGreaterThan(0);

        // Summary hover transitions can disappear when its open/closed labels swap.
        // Control only this slot's latest transition for each property and gesture.
        const animationIds = () => [...observed.values()].map((animation) => animation.id);
        const waitForContentMotion = () =>
          expect
            .poll(() => [...observed.keys()])
            .toEqual(expect.arrayContaining(["height", "opacity"]));
        inspector.on(
          "Animation.animationStarted",
          ({ animation }: { animation: InspectedAnimation }) => {
            if (
              animation.type === "CSSTransition" &&
              animation.source?.backendNodeId === contentBackendNodeId
            ) {
              observed.set(animation.name, animation);
            }
          },
        );
        await inspector.send("Animation.enable");
        await inspector.send("Animation.setPlaybackRate", { playbackRate: 0 });
        phase = "closing";
        observed.clear();
        await card.locator("summary").click();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        if (reducedMotion === "no-preference") {
          await waitForContentMotion();
        }
        const duration = observed.get("height")?.source?.duration ?? 0;
        const samples: Array<{ height: number; opacity: number }> = [];
        const sample = () =>
          card.evaluate((element) => ({
            height: element.getBoundingClientRect().height,
            opacity: Number(getComputedStyle(element, "::details-content").opacity),
          }));
        if (duration) {
          for (const fraction of [0, 0.25, 0.5, 0.75]) {
            await inspector.send("Animation.seekAnimations", {
              animations: animationIds(),
              currentTime: duration * fraction,
            });
            samples.push(await sample());
          }
          await inspector.send("Animation.seekAnimations", {
            animations: animationIds(),
            currentTime: duration * 0.25,
          });
        } else {
          samples.push(await sample());
        }
        if (proofDir) {
          await writeFile(
            path.join(proofDir, "motion.json"),
            JSON.stringify({ before, closed, duration, samples }, null, 2),
          );
          await card.screenshot({
            path: path.join(proofDir, "quarter-close.png"),
            animations: "allow",
          });
        }
        if (reducedMotion === "reduce") {
          expect(duration).toBe(0);
          expect(await cardHeight()).toBe(closed);
        } else {
          expect(duration).toBeGreaterThanOrEqual(200);
          expect(duration).toBeLessThanOrEqual(300);
          expect((samples[1]!.height - closed) / (samples[0]!.height - closed)).toBeGreaterThan(
            0.6,
          );
          expect(samples[1]!.opacity).toBeGreaterThan(0.6);
          for (let index = 1; index < samples.length; index += 1) {
            expect(samples[index]!.height).toBeLessThanOrEqual(samples[index - 1]!.height);
          }
          const reversingFrom = await cardHeight();
          phase = "reopening";
          observed.clear();
          await card.locator("summary").click();
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
          await waitForContentMotion();
          expect(Math.abs((await cardHeight()) - reversingFrom)).toBeLessThanOrEqual(1);
          await inspector.send("Animation.setPaused", {
            animations: animationIds(),
            paused: false,
          });
          await inspector.send("Animation.setPlaybackRate", { playbackRate: 1 });
          await expect.poll(cardHeight).toBe(before);
        }
      } catch (error) {
        console.error("Task progress motion failed", {
          browserVersion: context.browser()?.version(),
          phase,
          contentBackendNodeId,
          animations: [...observed.values()].map(({ id, name, source }) => ({
            id,
            name,
            backendNodeId: source?.backendNodeId,
          })),
        });
        throw error;
      } finally {
        await page.close();
        if (proofDir && video) {
          await video.saveAs(path.join(proofDir, "closing-cycle.webm"));
        }
        await suite.closeBrowserContext(context);
      }
    },
  );
});
