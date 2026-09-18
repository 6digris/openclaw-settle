import type { Page } from "playwright";
import { expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sessions replacement layout" });
const mobile = { width: 390, height: 844 };
const pageQuery = { includeUnknown: false };

function sessionsResult(count = 7): SessionsListResult {
  const sessions: GatewaySessionRow[] = Array.from({ length: count }, (_, index) => ({
    key: `agent:main:layout-${index}`,
    sessionId: `layout-session-${index}`,
    kind: "direct",
    label: `Layout row ${index}`,
    displayName: `Synthetic session for replacement layout ${index}`,
    category: index % 2 === 0 ? "Planning" : "Review",
    updatedAt: 1,
    totalTokens: 100,
  }));
  return {
    ts: 1,
    path: "",
    count,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

async function geometry(page: Page) {
  return page.locator("main.content").evaluate((element) => {
    const workspace = element.querySelector("#sessions-hub-panel");
    if (!workspace) {
      throw new Error("Sessions workspace is missing");
    }
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      workspaceHeight: workspace.getBoundingClientRect().height,
    };
  });
}

async function settleLayout(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function openSessions(page: Page, result = sessionsResult(), holdInitial = false) {
  const gateway = await installMockGateway(page, {
    methodResponses: { "sessions.list": result },
    ...(holdInitial ? { heldMethods: ["sessions.list"] } : {}),
  });
  await page.goto(`${suite.server.baseUrl}sessions`);
  if (!holdInitial) {
    await expect
      .poll(() => page.locator(".session-data-row").count())
      .toBe(Math.min(25, result.count));
  }
  await page.evaluate(() => document.fonts.ready);
  return gateway;
}

async function selectLimit(page: Page) {
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  const limit = page.locator(".session-filter-input--limit");
  await limit.waitFor({ state: "visible" });
  await limit.focus();
  await limit.press("ControlOrMeta+A");
  // Keep the popover in view even for the larger inventory while reproducing
  // the browser's clamp when the replacement skeleton shortens the scroller.
  await page.locator("main.content").evaluate((element) => {
    element.scrollTop = Math.min(300, element.scrollHeight - element.clientHeight);
  });
  await settleLayout(page);
  const before = await geometry(page);
  expect(before.scrollTop).toBeGreaterThan(20);
  return before;
}

async function assertPending(page: Page, before: Awaited<ReturnType<typeof geometry>>) {
  await expect.poll(() => page.locator(".session-skeleton-row").count()).toBeGreaterThan(0);
  expect(await page.locator(".session-data-row, .session-details-row").count()).toBe(0);
  expect(
    await page
      .locator(".sessions-table tbody a, .sessions-table tbody button, .sessions-table tbody input")
      .count(),
  ).toBe(0);
  await settleLayout(page);
  const pending = await geometry(page);
  expect(Math.abs(pending.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(pending.scrollHeight - before.scrollHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(pending.workspaceHeight - before.workspaceHeight)).toBeLessThanOrEqual(1);
  expect(
    await page
      .locator(".session-filter-input--limit")
      .evaluate((element) => document.activeElement === element),
  ).toBe(true);
}

async function replaceLimit(page: Page, gateway: MockGatewayControls) {
  const before = await selectLimit(page);
  await gateway.deferNext("sessions.list", { ...pageQuery, limit: 90 });
  await page.keyboard.insertText("90");
  await gateway.waitForRequest("sessions.list", { match: { ...pageQuery, limit: 90 } });
  await assertPending(page, before);
  return before;
}

suite.define(() => {
  it.each([mobile, { width: 1440, height: 900 }])(
    "preserves scroll and native Limit editing through queued replacement at $width px",
    async (viewport) => {
      await suite.withPage({ viewport, reducedMotion: "reduce" }, async ({ page }) => {
        const result = sessionsResult();
        const gateway = await openSessions(page, result, true);
        await expect.poll(() => page.locator(".session-skeleton-row").count()).toBeGreaterThan(0);
        const initial = await geometry(page);
        await gateway.resolveDeferred("sessions.list", result);
        await expect.poll(() => page.locator(".session-data-row").count()).toBe(7);
        const before = await selectLimit(page);
        expect(initial.workspaceHeight).toBeLessThan(before.workspaceHeight - 100);
        const issued = (await gateway.getRequests("sessions.list", pageQuery)).length;
        await gateway.deferNext("sessions.list", { ...pageQuery, limit: 9 });
        await gateway.deferNext("sessions.list", { ...pageQuery, limit: 90 });
        await page.keyboard.type("9");
        await gateway.waitForRequest("sessions.list", { match: { ...pageQuery, limit: 9 } });
        await assertPending(page, before);
        await page.keyboard.type("0");
        await assertPending(page, before);
        expect(await page.locator(".session-filter-input--limit").inputValue()).toBe("90");
        expect(await gateway.getRequests("sessions.list", pageQuery)).toHaveLength(issued + 1);

        await gateway.resolveDeferred("sessions.list", sessionsResult(1));
        await gateway.waitForRequest("sessions.list", { match: { ...pageQuery, limit: 90 } });
        await assertPending(page, before);
        await gateway.resolveDeferred("sessions.list", result);
        await expect.poll(() => page.locator(".session-data-row").count()).toBe(7);
        await settleLayout(page);
        const after = await geometry(page);
        expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(1);
        expect(Math.abs(after.workspaceHeight - before.workspaceHeight)).toBeLessThanOrEqual(1);
        expect(
          await page
            .locator(".session-filter-input--limit")
            .evaluate((element) => document.activeElement === element),
        ).toBe(true);

        await page.keyboard.press("Escape");
        const refresh = page
          .locator("openclaw-sessions-page")
          .getByRole("button", { name: "Refresh", exact: true });
        await refresh.focus();
        const refreshBefore = await geometry(page);
        const refreshIssued = (await gateway.getRequests("sessions.list", pageQuery)).length;
        await gateway.deferNext("sessions.list", { ...pageQuery, limit: 90 });
        await refresh.press("Enter");
        await gateway.waitForRequest("sessions.list", { match: pageQuery, after: refreshIssued });
        await page
          .locator("openclaw-sessions-page")
          .getByRole("button", { name: "Loading…", exact: true })
          .waitFor();
        expect(await page.locator(".session-data-row").count()).toBe(7);
        expect(await page.locator(".session-skeleton-row").count()).toBe(0);
        expect((await geometry(page)).workspaceHeight).toBeCloseTo(
          refreshBefore.workspaceHeight,
          0,
        );
        await gateway.resolveDeferred("sessions.list", result);
        await expect.poll(() => refresh.isEnabled()).toBe(true);
      });
    },
  );

  it.each(["short", "empty", "error"] as const)(
    "releases the pending footprint when the current query ends with %s",
    async (outcome) => {
      await suite.withPage({ viewport: mobile, reducedMotion: "reduce" }, async ({ page }) => {
        const gateway = await openSessions(page);
        const before = await replaceLimit(page, gateway);
        if (outcome === "error") {
          await gateway.rejectDeferred("sessions.list", {
            code: "UNAVAILABLE",
            message: "Synthetic list unavailable",
          });
          await page.getByRole("alert").filter({ hasText: "Synthetic list unavailable" }).waitFor();
        } else {
          await gateway.resolveDeferred(
            "sessions.list",
            sessionsResult(outcome === "short" ? 1 : 0),
          );
          if (outcome === "empty") {
            await page.locator(".data-table-empty-state").waitFor();
          } else {
            await expect.poll(() => page.locator(".session-data-row").count()).toBe(1);
          }
        }
        await expect.poll(() => page.locator(".session-skeleton-row").count()).toBe(0);
        await expect
          .poll(async () => (await geometry(page)).workspaceHeight)
          .toBeLessThan(before.workspaceHeight - 100);
        expect((await geometry(page)).scrollTop).toBeLessThan(before.scrollTop);
        expect(await page.locator(".session-data-row").count()).toBe(outcome === "short" ? 1 : 0);
        expect(await page.locator(".session-filter-input--limit").inputValue()).toBe("90");
      });
    },
  );

  it("releases on disconnect and starts the reconnect without a retired footprint", async () => {
    await suite.withPage({ viewport: mobile, reducedMotion: "reduce" }, async ({ page }) => {
      const gateway = await openSessions(page);
      const before = await replaceLimit(page, gateway);
      await gateway.setOnline(false);
      await expect.poll(() => page.locator(".session-skeleton-row").count()).toBe(0);
      await expect
        .poll(async () => (await geometry(page)).workspaceHeight)
        .toBeLessThan(before.workspaceHeight - 100);
      await gateway.resolveDeferred("sessions.list", sessionsResult(30));
      expect(await page.locator(".session-data-row").count()).toBe(0);
      const issued = (await gateway.getRequests("sessions.list", { ...pageQuery, limit: 90 }))
        .length;
      await gateway.deferNext("sessions.list", { ...pageQuery, limit: 90 });
      await gateway.setOnline(true);
      await gateway.waitForRequest("sessions.list", {
        match: { ...pageQuery, limit: 90 },
        after: issued,
      });
      await expect.poll(() => page.locator(".session-skeleton-row").count()).toBeGreaterThan(0);
      expect((await geometry(page)).workspaceHeight).toBeLessThan(before.workspaceHeight - 100);
      await gateway.resolveDeferred("sessions.list", sessionsResult(1));
      await expect.poll(() => page.locator(".session-data-row").count()).toBe(1);
      expect((await geometry(page)).workspaceHeight).toBeLessThan(before.workspaceHeight - 100);
    });
  });

  it("ignores a response delivered after the Sessions route has detached", async () => {
    await suite.withPage({ viewport: mobile, reducedMotion: "reduce" }, async ({ page }) => {
      const gateway = await openSessions(page);
      const before = await replaceLimit(page, gateway);
      await page.keyboard.press("Escape");
      await page.getByRole("tab", { name: "Worktrees", exact: true }).click();
      await page.locator("openclaw-sessions-page").waitFor({ state: "detached" });
      await page.locator("openclaw-worktrees-page").waitFor();
      await gateway.resolveDeferred("sessions.list", sessionsResult(30));
      await gateway.setMethodResponse("sessions.list", sessionsResult(1));
      await page.getByRole("tab", { name: "Sessions", exact: true }).click();
      await expect.poll(() => page.locator(".session-data-row").count()).toBe(1);
      expect(await page.locator(".session-skeleton-row").count()).toBe(0);
      expect((await geometry(page)).workspaceHeight).toBeLessThan(before.workspaceHeight - 100);
    });
  });

  it("reserves grouped rows, selection, expanded details, and pagination as one footprint", async () => {
    await suite.withPage({ viewport: mobile, reducedMotion: "reduce" }, async ({ page }) => {
      const gateway = await openSessions(page, sessionsResult(30));
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect.poll(() => page.locator(".session-data-row").count()).toBe(5);
      await page.getByRole("combobox", { name: "Rows per page", exact: true }).selectOption("10");
      await expect.poll(() => page.locator(".session-data-row").count()).toBe(10);
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.locator(".session-groupby__select").selectOption("category");
      await page.keyboard.press("Escape");
      await expect.poll(() => page.locator(".session-group-row").count()).toBeGreaterThan(0);
      await page.getByRole("checkbox", { name: "Select all on page", exact: true }).check();
      await page.locator(".session-data-row .session-details-toggle").first().click();
      await page.locator(".session-details-row").waitFor();
      await page.locator(".data-table-bulk-bar").waitFor();
      const before = await replaceLimit(page, gateway);
      expect(
        await page
          .locator(".data-table-bulk-bar, .session-group-row, .data-table-pagination")
          .count(),
      ).toBe(0);
      const replacement = sessionsResult(1);
      replacement.sessions[0] = {
        ...replacement.sessions[0]!,
        key: "agent:main:replacement",
        sessionId: "replacement-session",
      };
      await gateway.resolveDeferred("sessions.list", replacement);
      await expect.poll(() => page.locator(".session-data-row").count()).toBe(1);
      await expect
        .poll(async () => (await geometry(page)).workspaceHeight)
        .toBeLessThan(before.workspaceHeight - 100);
      expect(await page.locator(".data-table-bulk-bar").count()).toBe(0);
      expect(
        await page.getByRole("combobox", { name: "Rows per page", exact: true }).inputValue(),
      ).toBe("10");
    });
  });
});
