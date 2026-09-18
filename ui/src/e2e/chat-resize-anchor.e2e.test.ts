// Regression: resizing the chat pane must not jump the transcript. The reader's
// anchor row (topmost visible row) should stay in place while rows re-wrap.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let controlUi: ControlUiE2eServer;
const contexts = new Set<BrowserContext>();

const MESSAGE_COUNT = 120;
const filler =
  "The quick brown fox jumps over the lazy dog while the virtualized transcript keeps every " +
  "row height honest across pane widths. ";

function messageContent(index: number): string {
  // Vary paragraph counts so re-wrapping changes heights non-uniformly.
  return `Message number ${index}: ${filler.repeat((index % 4) + 1)}`;
}

type AnchorSample = {
  key: string | null;
  topDelta: number;
  scrollTop: number;
  visibleKeys: string[];
  contentVisible: boolean;
};

async function sampleAnchor(page: Page, anchorKey: string | null): Promise<AnchorSample> {
  return await page.evaluate((key) => {
    const inner = document.querySelector<HTMLElement>(".chat-thread-inner--virtual");
    const scroller = inner?.parentElement;
    if (!inner || !scroller) {
      return {
        key: null,
        topDelta: Number.NaN,
        scrollTop: Number.NaN,
        visibleKeys: [],
        contentVisible: false,
      };
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const rows = [...inner.querySelectorAll<HTMLElement>(".chat-virtual-row")]
      .map((row) => ({
        key: row.dataset.virtualRowKey ?? "",
        rect: row.getBoundingClientRect(),
        contentRect: row.querySelector(".chat-group-messages")?.getBoundingClientRect(),
      }))
      .filter(({ rect }) => rect.bottom > scrollerRect.top && rect.top < scrollerRect.bottom)
      .toSorted((left, right) => left.rect.top - right.rect.top);
    const anchor = key === null ? rows[0] : rows.find((row) => row.key === key);
    return {
      key: anchor?.key ?? null,
      topDelta: anchor ? anchor.rect.top - scrollerRect.top : Number.NaN,
      scrollTop: scroller.scrollTop,
      visibleKeys: rows.map((row) => row.key),
      contentVisible:
        anchor?.contentRect !== undefined &&
        anchor.contentRect.bottom > scrollerRect.top &&
        anchor.contentRect.top < scrollerRect.bottom,
    };
  }, anchorKey);
}

async function settleFrames(page: Page, frames: number): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const step = (remaining: number) => {
          if (remaining <= 0) {
            resolve();
            return;
          }
          requestAnimationFrame(() => step(remaining - 1));
        };
        step(count);
      }),
    frames,
  );
}

describeControlUiE2e("Chat transcript resize anchoring", () => {
  beforeAll(async () => {
    controlUi = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  }, 120_000);

  afterAll(async () => {
    for (const context of contexts) {
      await context.close();
    }
    await browser?.close();
    await controlUi?.close();
  });

  it("keeps the anchor row stable across pane width changes", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    contexts.add(context);
    const page = await context.newPage();
    const now = Date.now();
    await installMockGateway(page, {
      sessionKey: "agent:main:main",
      historyMessages: Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: messageContent(index),
        timestamp: now - (MESSAGE_COUNT - index) * 60_000,
      })),
    });

    await page.goto(`${controlUi.baseUrl}chat`);
    await page
      .getByText(`Message number ${MESSAGE_COUNT - 1}:`)
      .first()
      .waitFor({
        timeout: 15_000,
      });

    const scroller = page.locator(".chat-thread");
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(2);

    // Native reader input interrupts initial end anchoring; assigning scrollTop
    // alone can race that owner and leave this case pinned to the latest message.
    const readingDelta = await scroller.evaluate((element) =>
      Math.floor((element.scrollHeight - element.clientHeight) / 2),
    );
    await scroller.hover();
    await page.mouse.wheel(0, -readingDelta);
    await settleFrames(page, 30);
    const readingPosition = await scroller.evaluate((element) => ({
      top: element.scrollTop,
      endDistance: element.scrollHeight - element.clientHeight - element.scrollTop,
      height: element.clientHeight,
    }));
    expect(readingPosition.top).toBeGreaterThan(readingPosition.height);
    expect(readingPosition.endDistance).toBeGreaterThan(readingPosition.height);

    const before = await sampleAnchor(page, null);
    expect(before.key).not.toBeNull();
    expect(before.contentVisible, "reader anchor contains visible message content").toBe(true);

    const widths = [1000, 820, 1280];
    const observations: { width: number; sample: AnchorSample }[] = [];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      await settleFrames(page, 30);
      const sample = await sampleAnchor(page, before.key);
      observations.push({ width, sample });
      console.log(
        `[resize-anchor] width=${width} anchor=${before.key} topDelta=${sample.topDelta} ` +
          `(was ${before.topDelta}) scrollTop=${sample.scrollTop} (was ${before.scrollTop}) ` +
          `visible=${sample.visibleKeys.length ? sample.visibleKeys.join(",") : "<none>"}`,
      );
    }

    for (const { width, sample } of observations) {
      // The anchor row must remain visible after every width change...
      expect(sample.key, `anchor visible at width ${width}`).toBe(before.key);
      // ...and roughly hold its viewport position while its own text re-wraps.
      // The fold-spanning anchor row's own re-wrap moves its top by a font-
      // metric-dependent amount (42px on macOS, 63px on Linux CI at 820px);
      // the pre-fix failure mode is the anchor leaving the viewport entirely
      // with 250px+ scroll drift, so 120px keeps a wide detection margin.
      expect(
        Math.abs(sample.topDelta - before.topDelta),
        `anchor drift at width ${width}`,
      ).toBeLessThanOrEqual(120);
    }
  }, 120_000);

  it("keeps an end-pinned transcript pinned across width-only resizes", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    contexts.add(context);
    const page = await context.newPage();
    const now = Date.now();
    await installMockGateway(page, {
      sessionKey: "agent:main:main",
      historyMessages: Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: messageContent(index),
        timestamp: now - (MESSAGE_COUNT - index) * 60_000,
      })),
    });

    // Fresh sessions open pinned to the end; leave the scroll untouched.
    await page.goto(`${controlUi.baseUrl}chat`);
    await page
      .getByText(`Message number ${MESSAGE_COUNT - 1}:`)
      .first()
      .waitFor({
        timeout: 15_000,
      });
    await settleFrames(page, 30);

    const distanceFromEnd = () =>
      page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(
          ".chat-thread-inner--virtual",
        )?.parentElement;
        return scroller
          ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop
          : Number.NaN;
      });
    expect(await distanceFromEnd()).toBeLessThanOrEqual(2);

    // Width-only changes re-wrap every row; the end anchor must follow the
    // new total size (virtualizer wasAtEnd compensation), not drift upward.
    for (const width of [1000, 820, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await settleFrames(page, 30);
      expect(await distanceFromEnd(), `distance from end at width ${width}`).toBeLessThanOrEqual(2);
      await page
        .getByText(`Message number ${MESSAGE_COUNT - 1}:`)
        .first()
        .waitFor({ state: "visible", timeout: 2_000 });
    }
  }, 120_000);

  it("preserves the reading position and draft through repeated split round trips", async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    contexts.add(context);
    const page = await context.newPage();
    const messageCount = 24;
    await installMockGateway(page, {
      sessionKey: "agent:main:main",
      historyMessages: Array.from({ length: messageCount }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: messageContent(index),
        timestamp: 1_750_000_000_000 + index * 60_000,
      })),
    });
    await page.goto(`${controlUi.baseUrl}chat`);
    const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible").first();
    const composer = pane.locator(".agent-chat__composer-combobox textarea");
    const draft = "Synthetic unsent draft for split reading proof.";
    await composer.fill(draft);
    await page
      .getByText(`Message number ${messageCount - 1}:`)
      .first()
      .waitFor();
    const scroller = pane.locator(".chat-thread");
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
    await settleFrames(page, 30);
    await scroller.click({ position: { x: 10, y: 150 } });
    await page.keyboard.press("PageUp");
    await page.keyboard.press("PageUp");
    await settleFrames(page, 30);
    const key = await scroller.evaluate((element) => {
      const viewport = element.getBoundingClientRect();
      return (
        [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")].find((row) => {
          const rect = row.getBoundingClientRect();
          return rect.top >= viewport.top && rect.top < viewport.bottom;
        })?.dataset.virtualRowKey ?? null
      );
    });
    expect(key).not.toBeNull();
    const before = await sampleAnchor(page, key);
    expect(before.contentVisible).toBe(true);
    expect(before.scrollTop).toBeGreaterThan(0);
    for (let cycle = 0; cycle < 3; cycle++) {
      await pane.getByRole("button", { name: "Open split view", exact: true }).click();
      const right = page.locator(".chat-split-view__cell").nth(1);
      await right.getByRole("button", { name: "Close pane", exact: true }).waitFor();
      await settleFrames(page, 30);
      await right.getByRole("button", { name: "Close pane", exact: true }).click();
      await expect.poll(() => page.locator(".chat-split-view__cell").count()).toBe(1);
      await settleFrames(page, 30);
      const after = await sampleAnchor(page, key);
      expect(after.key).toBe(key);
      expect(
        Math.abs(after.topDelta - before.topDelta),
        `split round trip ${cycle + 1}`,
      ).toBeLessThanOrEqual(1);
      expect(after.scrollTop).toBe(before.scrollTop);
      expect(await composer.inputValue()).toBe(draft);
    }
  }, 120_000);
});
