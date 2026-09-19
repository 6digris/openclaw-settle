import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
} from "../test-helpers/control-ui-e2e.ts";
import {
  chatThreadDistanceFromBottom,
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { captureTopVisibleVirtualRow } from "./virtual-row-anchor.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:main";
const stackScene = { name: "stack", progress: true, goal: true, queue: 1 };
const scenes = [
  stackScene,
  { name: "composer only", progress: false, goal: false, queue: 0 },
  { name: "without queue", progress: true, goal: true, queue: 0 },
  { name: "without goal", progress: true, goal: false, queue: 1 },
  { name: "queue only", progress: false, goal: false, queue: 1 },
  { name: "multiple queued messages", progress: true, goal: true, queue: 4 },
];
const displays = ["dark", "light"].flatMap((theme) =>
  [1440, 390].map((width) => ({ theme, width })),
);
const selectors = {
  progress: ".session-progress-card--composer",
  queue: ".chat-queue",
  goal: ".agent-chat__goal",
  input: ".agent-chat__input",
};

async function openScene(page: Page, scene: (typeof scenes)[number], theme: string) {
  const startedAt = Date.now() - 60_000;
  const row = {
    key: sessionKey,
    kind: "direct",
    displayName: "Garden planning",
    hasActiveRun: true,
    activeRunIds: ["garden-run"],
    ...(scene.goal
      ? {
          goal: {
            schemaVersion: 1,
            id: "garden-goal",
            objective: "Prepare a seasonal garden guide with planting and watering notes.",
            status: "active",
            createdAt: startedAt,
            updatedAt: startedAt,
            tokenStart: 0,
            tokensUsed: 1200,
            continuationTurns: 0,
          },
        }
      : {}),
  };
  await installMockGateway(page, {
    sessionKey,
    sessionInfo: row,
    sessions: [row],
    inFlightRun: { runId: "garden-run", startedAt },
    historyMessages: Array.from({ length: 24 }, (_, index) => ({
      id: `garden-${index}`,
      role: index % 2 ? "assistant" : "user",
      content: [
        {
          type: "text",
          text: `Garden entry ${index}. ${"Compare the planting beds and watering schedules. ".repeat(8)}`,
        },
      ],
      timestamp: startedAt + index,
    })),
    methodResponses: {
      "progressCard.get": {
        card: scene.progress
          ? {
              sessionKey,
              revision: 1,
              updatedAt: startedAt,
              steps: [
                { step: "Gather planting notes", status: "completed" },
                { step: "Compare the layouts", status: "in_progress" },
                { step: "Write the guide", status: "pending" },
              ],
            }
          : null,
      },
    },
  });
  await page.addInitScript(
    ({ owner, settingsKey, themeMode, queueCount, key }) => {
      const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}");
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          ...settings,
          theme: "claw",
          themeMode,
          sidebarCollapsed: true,
          chatCollapseTaskProgress: true,
        }),
      );
      sessionStorage.setItem(
        `openclaw.control.chatComposer.v4:${encodeURIComponent(owner)}`,
        JSON.stringify({
          version: 4,
          gatewayOwner: owner,
          sessions: {
            [`${key}\u0000agent:main`]: {
              updatedAt: Date.now(),
              queue: Array.from({ length: queueCount }, (_, index) => ({
                id: `garden-queue-${index}`,
                text: `Add watering schedule ${index + 1}`,
                createdAt: Date.now() + index,
                sessionKey: key,
                agentId: "main",
                sendState: "waiting-idle",
                sendAttempts: 0,
              })),
            },
          },
          recovery: {},
        }),
      );
    },
    {
      owner: controlUiBundledGatewayUrl(suite.server.baseUrl),
      settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
      themeMode: theme,
      queueCount: scene.queue,
      key: sessionKey,
    },
  );
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.locator(".agent-chat__composer-combobox textarea").waitFor();
  await expect.poll(() => page.locator(".chat-queue__item").count()).toBe(scene.queue);
  for (const [selector, present] of [
    [selectors.progress, scene.progress],
    [selectors.goal, scene.goal],
  ] as const) {
    await expect.poll(() => page.locator(selector).count()).toBe(present ? 1 : 0);
  }
  await waitForChatScrollIdle(page);
}

async function expectFullStackGlass(page: Page) {
  const measured = await page
    .locator(".agent-chat__composer-shell")
    .evaluate((shell, surfaceSelectors) => {
      const thread = shell
        .closest(".chat-main__conversation")
        ?.querySelector<HTMLElement>(".chat-thread");
      if (!thread) throw new Error("Missing transcript beside the composer");
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Missing color measurement context");
      const surfaces = Object.entries(surfaceSelectors).flatMap(([name, selector]) => {
        const surface = shell.querySelector(selector);
        if (!surface) return [];
        const style = getComputedStyle(surface);
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = style.backgroundColor;
        context.fillRect(0, 0, 1, 1);
        return [
          {
            name,
            alpha: context.getImageData(0, 0, 1, 1).data[3] / 255,
            filter: style.backdropFilter,
            top: surface.getBoundingClientRect().top,
          },
        ];
      });
      return {
        surfaces,
        stackHeight: shell.getBoundingClientRect().height,
        stackBottom: shell.getBoundingClientRect().bottom,
        transcriptBottom: thread.getBoundingClientRect().bottom,
        bottomPadding: Number.parseFloat(getComputedStyle(thread).paddingBottom),
      };
    }, selectors);
  expect(measured.surfaces.length).toBeGreaterThan(0);
  for (const surface of measured.surfaces) {
    expect(surface.filter, surface.name).toContain("blur(");
    expect(surface.alpha, surface.name).toBeGreaterThan(0);
    expect(surface.alpha, surface.name).toBeLessThan(1);
  }
  expect(new Set(measured.surfaces.map((surface) => surface.filter)).size).toBe(1);
  expect(measured.surfaces.map((surface) => surface.top)).toEqual(
    measured.surfaces.map((surface) => surface.top).toSorted((a, b) => a - b),
  );
  expect(measured.transcriptBottom).toBeGreaterThanOrEqual(measured.stackBottom - 1);
  expect(measured.bottomPadding).toBeGreaterThanOrEqual(measured.stackHeight - 1);
}

suite.define(() => {
  it.each(displays.flatMap((display) => scenes.map((scene) => ({ ...display, ...scene }))))(
    "extends translucent composer surfaces over the transcript: $name, $theme, $width",
    async ({ theme, width, ...scene }) => {
      await suite.withPage(
        { viewport: { width, height: 1000 }, reducedMotion: "reduce" },
        async ({ page }) => {
          await openScene(page, scene, theme);
          await expectFullStackGlass(page);
        },
      );
    },
  );

  it.each(displays)(
    "keeps end and reader positions through stack disclosure: $theme, $width",
    async ({ theme, width }) => {
      await suite.withPage(
        { viewport: { width, height: 1000 }, reducedMotion: "reduce" },
        async ({ page }) => {
          await openScene(page, stackScene, theme);
          const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
          const progress = page.locator(".session-progress-card__summary");
          const goal = page.locator(".agent-chat__goal-expand");
          await expect.poll(() => chatThreadDistanceFromBottom(page)).toBeLessThanOrEqual(2);
          for (const disclosure of [progress, goal, goal, progress]) {
            await disclosure.click();
            await waitForChatScrollIdle(page);
            await expectFullStackGlass(page);
            expect(await chatThreadDistanceFromBottom(page)).toBeLessThanOrEqual(2);
          }
          await thread.hover({ position: { x: 80, y: 80 } });
          await page.mouse.wheel(0, -600);
          await waitForChatScrollIdle(page);
          const anchor = await captureTopVisibleVirtualRow(thread);
          for (const disclosure of [progress, goal, goal, progress]) {
            await disclosure.click();
            await waitForChatScrollIdle(page);
            await expectFullStackGlass(page);
            const after = await captureTopVisibleVirtualRow(thread);
            expect(after.key).toBe(anchor.key);
            expect(Math.abs(after.viewportTop - anchor.viewportTop)).toBeLessThanOrEqual(2);
          }
          await page.locator(".chat-scroll-to-bottom").click();
          await expect.poll(() => chatThreadDistanceFromBottom(page)).toBeLessThanOrEqual(2);
        },
      );
    },
  );
});
