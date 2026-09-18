import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const suite = createControlUiE2eSuite({ name: "Carapace theme", trackBrowserContexts: true });

suite.define(() => {
  it.each([
    ["dark", 1440],
    ["light", 1440],
    ["dark", 390],
    ["light", 390],
  ] as const)("selects and retains Carapace in %s at %ipx", async (mode, width) => {
    const context = await suite.newBrowserContext({
      colorScheme: mode,
      locale: "en-US",
      reducedMotion: "reduce",
      serviceWorkers: "block",
      viewport: { width, height: 1000 },
    });
    const page = await context.newPage();
    const config = { ui: { prefs: { theme: "claw", themeMode: mode } } };
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read"],
      historyMessages: [
        {
          role: "user",
          content: [{ type: "text", text: "Help me plan a calm, focused workspace." }],
          timestamp: 1789732800000,
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "## A little clarity goes a long way\n\nKeep your next step visible, give the important work room, and leave the rest for later.\n\n- Review today's priorities\n- Finish one useful task\n- Take a short break",
            },
          ],
          timestamp: 1789732801000,
        },
      ],
      methodResponses: {
        "config.get": {
          config,
          raw: JSON.stringify(config),
          valid: true,
          issues: [],
          hash: "carapace-theme-proof",
          appliedConfigHash: "carapace-theme-proof",
          configRevisionHash: "carapace-theme-proof",
        },
      },
    });
    const skin = () =>
      page.evaluate(() => {
        const root = document.documentElement;
        const styles = getComputedStyle(root);
        return {
          theme: root.dataset.theme,
          background: styles.getPropertyValue("--bg").trim(),
          accent: styles.getPropertyValue("--accent").trim(),
          primaryInk: styles.getPropertyValue("--primary-foreground").trim(),
          radius: styles.getPropertyValue("--radius-md").trim(),
        };
      });
    const capture = async (name: string) => {
      if (captureUiProof) {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: path.join(suite.artifactDir, name + "-" + mode + "-" + width + ".png"),
          animations: "disabled",
        });
      }
    };
    const openChat = async () => {
      await page.goto(suite.server.baseUrl + "chat");
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      await expect.poll(() => page.locator(".chat-text").last().textContent()).toContain("clarity");
    };
    const openAppearance = async () => {
      await page.goto(suite.server.baseUrl + "settings/appearance");
      await page.locator("#settings-appearance-theme").waitFor();
    };
    const themeSection = page.locator("#settings-appearance-theme");
    await openChat();
    const originalSkin = await skin();
    expect(originalSkin.theme).toBe(mode);
    await capture("before-claw");
    await openAppearance();
    await themeSection.locator(".settings-theme-card--carapace").click();
    const expectedSkin = {
      theme: mode === "dark" ? "carapace" : "carapace-light",
      background: mode === "dark" ? "#080808" : "#fafafa",
      accent: mode === "dark" ? "#f5654a" : "#b33a26",
      primaryInk: mode === "dark" ? "#080808" : "#ffffff",
      radius: "8px",
    };
    await expect.poll(skin).toEqual(expectedSkin);
    await themeSection.scrollIntoViewIfNeeded();
    await capture("carapace-appearance");
    await page.reload();
    await themeSection.waitFor();
    await expect.poll(skin).toEqual(expectedSkin);
    expect(
      await themeSection.locator(".settings-theme-card--carapace").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    await openChat();
    await expect.poll(skin).toEqual(expectedSkin);
    await capture("after-carapace");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);

    // Returning to an existing theme must not retain Carapace tokens or geometry.
    await openAppearance();
    await themeSection.locator(".settings-theme-card--claw").click();
    await expect.poll(skin).toEqual(originalSkin);
    await themeSection.locator(".settings-theme-card--carapace").click();
    await themeSection.locator('wa-radio[value="system"]').click();
    const otherMode = mode === "dark" ? "light" : "dark";
    await page.emulateMedia({ colorScheme: otherMode });
    await expect
      .poll(() => page.locator("html").getAttribute("data-theme"))
      .toBe(otherMode === "light" ? "carapace-light" : "carapace");
  });
});
