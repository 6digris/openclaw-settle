import type { Page } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Session skills chooser",
});
const longName = "transcript-search-design-investigation";
function skill(name: string) {
  return {
    name,
    description: "Investigate transcript search and result attribution.",
    source: "test",
    filePath: "/mock/" + name + "/SKILL.md",
    baseDir: "/mock/" + name,
    skillKey: name,
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
    missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
  };
}
async function setup(
  page: Page,
  count = 125,
  deferredMethods: string[] = [],
  canonicalKey = longName,
) {
  return installMockGateway(page, {
    deferredMethods,
    methodResponses: {
      "config.get": {
        raw: "{}",
        hash: "skills-dialog",
        sourceConfig: {},
        runtimeConfig: {},
        config: {},
      },
      "sessions.list": {
        count: 1,
        defaults: {},
        path: "",
        sessions: [{ key: "main", kind: "direct", status: "done", updatedAt: Date.now() }],
        ts: Date.now(),
      },
      "skills.status": {
        workspaceDir: "/mock",
        managedSkillsDir: "/mock/skills",
        skills: [
          ...Array.from({ length: count - 2 }, (_, i) => skill("alpha-workflow-" + i)),
          { ...skill(longName), skillKey: canonicalKey },
          {
            ...skill("unavailable-long-skill-with-missing-dependencies"),
            missing: { anyBins: [], bins: ["missing-cli"], env: [], config: [], os: [] },
          },
        ],
      },
    },
  });
}
async function open(page: Page) {
  await page.goto(suite.server.baseUrl + "chat");
  const trigger = page.getByRole("button", { name: "Add attachment", exact: true });
  await trigger.click();
  await page.locator('[value="open-skills"]').click();
  await page.locator(".session-skills").waitFor();
  return trigger;
}
suite.define(() => {
  it("keeps dense skill labels inside their rows", async () => {
    await suite.withPage({ viewport: { width: 1200, height: 850 } }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "config.get": {
            raw: "{}",
            hash: "skills-dialog",
            sourceConfig: {},
            runtimeConfig: {},
            config: {},
          },
          "sessions.list": {
            count: 1,
            defaults: {},
            path: "",
            sessions: [{ key: "main", kind: "direct", status: "done", updatedAt: Date.now() }],
            ts: Date.now(),
          },
          "skills.status": {
            workspaceDir: "/mock",
            managedSkillsDir: "/mock/skills",
            skills: [
              ...Array.from({ length: 35 }, (_, i) => skill("alpha-workflow-" + i)),
              skill(longName),
            ],
          },
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      await page.getByRole("button", { name: "Add attachment", exact: true }).click();
      await page.locator('[value="open-skills"]').click();
      const row = page
        .locator(".agent-chat__capability-menu-item, .session-skills__row")
        .filter({ hasText: longName })
        .first();
      await row.waitFor();
      await row.scrollIntoViewIfNeeded();
      const overflow = await row.evaluate((el) => {
        const label = el.querySelector(
          ".agent-chat__capability-menu-label, .session-skills__name",
        )!;
        const r = el.getBoundingClientRect(),
          l = label.getBoundingClientRect();
        return Math.max(r.top - l.top, l.bottom - r.bottom, 0);
      });
      expect(overflow).toBeLessThanOrEqual(1);
    });
  });
  it.each([
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 640 },
    { width: 844, height: 390 },
  ])(
    "searches a dense catalog without accidental writes at $width by $height",
    async (viewport) => {
      await suite.withPage({ viewport, reducedMotion: "reduce" }, async ({ page }) => {
        const gateway = await setup(page);
        const trigger = await open(page);
        await gateway.waitForRequest("skills.library.list");
        await expect
          .poll(() => page.getByRole("button", { name: "Skill library", exact: true }).count())
          .toBe(0);
        const search = page.getByRole("searchbox", { name: "Search skills…" });
        await search.fill("transcript-search");
        const select = page.locator(".session-skills__select");
        await expect.poll(() => select.count()).toBe(1);
        await select.click();
        expect(await page.locator(".session-skills__detail").textContent()).toContain(
          "Investigate transcript search and result attribution.",
        );
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        const rect = await page.locator(".session-skills").boundingBox();
        expect(rect).not.toBeNull();
        expect(rect!.x).toBeGreaterThanOrEqual(0);
        expect(rect!.y).toBeGreaterThanOrEqual(0);
        expect(rect!.x + rect!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(viewport.height + 1);
        await search.fill("not-in-the-catalog");
        await page.getByText("No matching skills.", { exact: true }).waitFor();
        await search.fill("unavailable");
        const unavailable = page.getByRole("switch", { name: /Enable unavailable/ });
        expect(await unavailable.isDisabled()).toBe(true);
        await select.click();
        expect(await page.locator(".session-skills__detail").textContent()).toContain(
          "deps missing",
        );
        await search.fill("");
        await page.locator(".session-skills__select").first().focus();
        await page.keyboard.press("End");
        expect(await page.locator(".session-skills__select:focus").textContent()).toContain(
          "unavailable",
        );
        await page.keyboard.press("ArrowUp");
        expect(await page.locator(".session-skills__select:focus").textContent()).toContain(
          longName,
        );
        await page.locator(".session-skills__select").first().hover();
        expect(
          await page.locator('.session-skills__select[aria-pressed="true"]').textContent(),
        ).toContain(longName);
        const close = page.locator(".session-skills .exec-approval-header button");
        await search.focus();
        await page.keyboard.press("Shift+Tab");
        await expect.poll(() => close.evaluate((el) => el === document.activeElement)).toBe(true);
        await page.keyboard.press("Tab");
        await expect.poll(() => search.evaluate((el) => el === document.activeElement)).toBe(true);
        expect(
          await page
            .getByRole("dialog", { name: "Skills", exact: true })
            .evaluate((el) => el.matches(":modal")),
        ).toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(() => trigger.evaluate((el) => el === document.activeElement)).toBe(true);
      });
    },
  );

  it("keeps failed toggles authoritative, surfaces the error, and resets sparse overrides", async () => {
    await suite.withPage({ viewport: { width: 1200, height: 850 } }, async ({ page }) => {
      const canonicalKey = "canonical-transcript-search-key";
      const gateway = await setup(page, 36, [], canonicalKey);
      await open(page);
      await page.getByRole("searchbox", { name: "Search skills…" }).fill(canonicalKey);
      await page
        .locator(".session-skills__detail code")
        .getByText(canonicalKey, { exact: true })
        .waitFor();
      const toggle = page.getByRole("switch", { name: "Enable " + longName + " for this session" });
      await expect.poll(() => toggle.isEnabled()).toBe(true);
      await gateway.deferNext("sessions.patch");
      await toggle.locator("..").click();
      const first = await gateway.waitForRequest("sessions.patch");
      expect(first.params).toMatchObject({ toolOverrides: { skills: { [canonicalKey]: false } } });
      await gateway.rejectDeferred("sessions.patch", {
        code: "UNAVAILABLE",
        message: "Synthetic save failure",
      });
      await expect
        .poll(() => page.locator('.session-skills [role="alert"]').textContent())
        .toContain("Synthetic save failure");
      await expect.poll(() => toggle.isChecked()).toBe(true);
      await expect.poll(() => toggle.isEnabled()).toBe(true);
      await toggle.press("Space");
      await expect.poll(() => toggle.isChecked()).toBe(false);
      await page.getByRole("button", { name: "Use agent default", exact: true }).click();
      await expect.poll(() => toggle.isChecked()).toBe(true);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.patch")).at(-1)?.params)
        .toEqual({ key: "agent:main:main", toolOverrides: {} });
      expect(await gateway.getRequests("skills.update")).toHaveLength(0);
    });
  });
  it("retains saved overrides and reset when roster refresh fails, without retrying the write", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await setup(page, 36);
      await open(page);
      await page.getByRole("searchbox", { name: "Search skills…" }).fill(longName);
      const toggle = page.getByRole("switch", { name: "Enable " + longName + " for this session" });
      await expect.poll(() => toggle.isEnabled()).toBe(true);
      await gateway.setMethodResponse("sessions.list", {
        __mockError: { code: "UNAVAILABLE", message: "Synthetic roster refresh failure" },
      });
      await toggle.press("Space");
      const notice = page.locator(".session-skills__notice[role=status]");
      await expect
        .poll(() => notice.textContent())
        .toContain("Session settings were saved, but refreshing the session failed");
      expect(await toggle.isChecked()).toBe(false);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
      await page.getByRole("button", { name: "Use agent default", exact: true }).click();
      await expect.poll(() => toggle.isEnabled()).toBe(true);
      expect(await toggle.isChecked()).toBe(true);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(2);
      expect((await gateway.getRequests("sessions.patch")).at(-1)?.params).toEqual({
        key: "agent:main:main",
        toolOverrides: {},
      });
      expect(await page.locator(".session-skills__detail").textContent()).toContain(
        "Using the agent default.",
      );
    });
  });
  it("tabs through independent controls and navigates to Manage skills", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await setup(page, 36);
      await open(page);
      const search = page.getByRole("searchbox", { name: "Search skills…" });
      await search.fill(longName);
      const select = page.locator(".session-skills__select");
      const toggle = page.getByRole("switch", { name: "Enable " + longName + " for this session" });
      const manage = page.getByRole("button", { name: "Manage skills", exact: true });
      await search.focus();
      for (const control of [select, toggle, manage]) {
        await page.keyboard.press("Tab");
        await expect.poll(() => control.evaluate((el) => el.matches(":focus"))).toBe(true);
      }
      for (const control of [toggle, select, search]) {
        await page.keyboard.press("Shift+Tab");
        await expect.poll(() => control.evaluate((el) => el.matches(":focus"))).toBe(true);
      }
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      await manage.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/skills");
      await expect
        .poll(() => page.getByRole("dialog", { name: "Skills", exact: true }).count())
        .toBe(0);
    });
  });
  it("retires a pending write across reconnect without retrying or leaking its error", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await setup(page, 36);
      await open(page);
      await page.getByRole("searchbox", { name: "Search skills…" }).fill(longName);
      const toggle = page.getByRole("switch", { name: "Enable " + longName + " for this session" });
      await expect.poll(() => toggle.isEnabled()).toBe(true);
      await gateway.deferNext("sessions.patch");
      await toggle.press("Space");
      await gateway.waitForRequest("sessions.patch");
      await expect.poll(() => toggle.isDisabled()).toBe(true);
      await reconnectMockGateway(page, gateway);
      await page.getByRole("searchbox", { name: "Search skills…" }).fill(longName);
      await expect.poll(() => toggle.isEnabled()).toBe(true);
      expect(await toggle.isChecked()).toBe(true);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
      expect(await page.locator(".session-skills [role=alert]").count()).toBe(0);
    });
  });
  it("closes the chooser when navigating during a pending write without retrying it", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await setup(page, 36);
      await open(page);
      await page.getByRole("searchbox", { name: "Search skills…" }).fill(longName);
      const toggle = page.getByRole("switch", { name: "Enable " + longName + " for this session" });
      await expect.poll(() => toggle.isEnabled()).toBe(true);
      await gateway.deferNext("sessions.patch");
      await toggle.press("Space");
      await gateway.waitForRequest("sessions.patch");
      await page.getByRole("button", { name: "Manage skills", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/skills");
      await gateway.rejectDeferred("sessions.patch", {
        code: "UNAVAILABLE",
        message: "Delayed old-session failure",
      });
      await expect
        .poll(() => page.getByRole("dialog", { name: "Skills", exact: true }).count())
        .toBe(0);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
      expect(await page.getByText("Delayed old-session failure", { exact: true }).isVisible()).toBe(
        false,
      );
    });
  });
  it("reloads the open chooser after a Gateway reconnect", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await setup(page, 36);
      await open(page);
      await expect.poll(() => page.locator(".session-skills__row").count()).toBe(36);
      const before = (await gateway.getRequests("skills.status")).length;
      await gateway.setMethodResponse("skills.status", {
        workspaceDir: "/mock",
        managedSkillsDir: "/mock/skills",
        skills: [skill("fresh-reconnected-skill")],
      });
      await reconnectMockGateway(page, gateway);
      await gateway.waitForRequest("skills.status", { after: before });
      await expect.poll(() => page.locator(".session-skills__row").count()).toBe(1);
      await expect
        .poll(() => page.locator(".session-skills__detail").textContent())
        .toContain("fresh-reconnected-skill");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    });
  });
  it("shows catalog loading, load failure and retry without inventing availability", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      const gateway = await setup(page, 36, ["skills.status"]);
      await open(page);
      await page.locator(".session-skills").getByText("Loading skills…", { exact: true }).waitFor();
      expect(await page.locator(".session-skills__row").count()).toBe(0);
      await gateway.rejectDeferred("skills.status", {
        code: "UNAVAILABLE",
        message: "Catalog unavailable",
      });
      await page
        .locator(".session-skills")
        .getByText("Couldn’t load skills.", { exact: true })
        .waitFor();
      await page
        .locator(".session-skills")
        .getByRole("button", { name: "Retry", exact: true })
        .click();
      await expect.poll(() => page.locator(".session-skills__row").count()).toBe(36);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    });
  });
  it.each([
    { width: 320, height: 640, top: 47, bottom: 34, side: 0 },
    { width: 844, height: 390, top: 0, bottom: 21, side: 44 },
  ])(
    "keeps the native frame outside safe areas at $width by $height",
    async ({ width, height, top, bottom, side }) => {
      await suite.withPage({ viewport: { width, height } }, async ({ page }) => {
        await setup(page, 36);
        await open(page);
        await page.locator(".session-skills__row").first().waitFor();
        await page.evaluate(
          (insets) => {
            const style = document.documentElement.style;
            style.setProperty("--safe-area-top", insets.top + "px");
            style.setProperty("--safe-area-bottom", insets.bottom + "px");
            style.setProperty("--safe-area-left", insets.side + "px");
          },
          { top, bottom, side },
        );
        await waitForControlUiProofSurface(
          page.getByRole("dialog", { name: "Skills", exact: true }),
          [page.locator(".session-skills__row").first()],
        );
        const rect = await page.locator(".session-skills").boundingBox();
        expect(rect!.x).toBeGreaterThanOrEqual(side);
        expect(rect!.y).toBeGreaterThanOrEqual(top);
        expect(rect!.y + rect!.height).toBeLessThanOrEqual(height - bottom + 1);
        const hit = await page
          .locator(".session-skills__row wa-switch")
          .first()
          .locator('[part~="base"]')
          .evaluate((element) => {
            if (!(element instanceof HTMLElement)) {
              throw new Error("Expected a native switch label");
            }
            // Layout CSS pixels avoid compositor float noise after the native scale transition.
            return { width: element.offsetWidth, height: element.offsetHeight };
          });
        expect(hit!.width).toBeGreaterThanOrEqual(44);
        expect(hit!.height).toBeGreaterThanOrEqual(44);
      });
    },
  );
});
