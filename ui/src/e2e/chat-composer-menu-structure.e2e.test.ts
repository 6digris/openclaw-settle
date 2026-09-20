import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Composer menu structure" });
const servers = ["documentation", "release-notes-and-customer-evidence"];
async function labelRail(row: Locator) {
  return row.evaluate((element) => {
    const menu = element.closest("wa-dropdown")!.shadowRoot!.querySelector('[part="menu"]')!;
    return (
      element.shadowRoot!.querySelector('[part="label"]')!.getBoundingClientRect().x -
      menu.getBoundingClientRect().x
    );
  });
}

suite.define(() => {
  it.each([
    { route: "chat", canAdmin: true },
    { route: "new", canAdmin: true },
    { route: "chat", canAdmin: false },
    { route: "new", canAdmin: false },
  ])(
    "keeps management navigation and aligned rows in $route (admin=$canAdmin)",
    async ({ route, canAdmin }) => {
      await suite.withPage(
        { viewport: { width: 1200, height: 900 }, reducedMotion: "reduce" },
        async ({ page }) => {
          const config = {
            mcp: {
              servers: Object.fromEntries(
                servers.map((name) => [
                  name,
                  { enabled: true, url: "https://fixture.example.test" },
                ]),
              ),
            },
            tools: { web: { search: { enabled: true, provider: "brave" } } },
          };
          const gateway = await installMockGateway(page, {
            operatorScopes: canAdmin
              ? ["operator.read", "operator.write", "operator.admin"]
              : ["operator.read"],
            featureMethods: ["tools.effective", "sessions.patch"],
            methodResponses: {
              "config.get": {
                raw: JSON.stringify(config),
                hash: "structure",
                sourceConfig: config,
                runtimeConfig: config,
                config,
              },
              "skills.status": { workspaceDir: "/mock", managedSkillsDir: "/mock", skills: [] },
              "tools.effective": {
                agentId: "main",
                profile: "full",
                groups: [
                  {
                    id: "mcp",
                    label: "MCP",
                    source: "mcp",
                    tools: [
                      {
                        id: "docs-inspect",
                        source: "mcp",
                        mcpServer: "documentation",
                        mcpToolName: "inspect-documentation",
                        label: "Inspect documentation",
                      },
                    ],
                  },
                ],
              },
            },
          });
          const open = async () => {
            await page.goto(suite.server.baseUrl + route);
            await page.getByRole("button", { name: "Add attachment", exact: true }).click();
            const panel = page
              .locator("wa-dropdown.agent-chat__capability-menu")
              .locator('[part="menu"]');
            await panel.waitFor();
            await panel.evaluate(async (element) => {
              await document.fonts.ready;
              await Promise.all(
                element.getAnimations().map((animation) => animation.finished.catch(() => {})),
              );
            });
          };
          await open();
          const menu = page.locator("wa-dropdown.agent-chat__capability-menu");
          const web = menu.locator('[value="toggle-web-search"]');
          await expect.poll(() => web.getAttribute("aria-checked")).toBe("true");
          await expect
            .poll(() =>
              web.evaluate((el) => {
                const check = el.shadowRoot!.querySelector<HTMLElement>('[part="checkmark"]')!;
                const style = getComputedStyle(check),
                  box = check.getBoundingClientRect();
                return (
                  style.display !== "none" &&
                  style.visibility === "visible" &&
                  Number(style.opacity) > 0 &&
                  box.width > 0 &&
                  box.height > 0
                );
              }),
            )
            .toBe(true);
          expect(await web.locator("wa-switch").count()).toBe(0);
          const rootRail = await labelRail(menu.locator('[value="open-skills"]'));
          await menu.locator('[value="open-skills"]').click();
          expect(await labelRail(menu.locator('[value="back"]'))).toBeCloseTo(rootRail, 0);
          const skillsManagement = menu.getByRole("menuitem", {
            name: "Manage skills",
            exact: true,
          });
          expect(await skillsManagement.locator('[slot="icon"] svg').count()).toBe(1);
          expect(await labelRail(skillsManagement)).toBeCloseTo(rootRail, 0);
          await skillsManagement.click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/skills");
          await open();
          await menu.locator('[value="open-connectors"]').click();
          const manage = menu.getByRole("menuitem", { name: "Manage connectors", exact: true });
          expect(await manage.locator('[slot="icon"] svg').count()).toBe(1);
          expect(await labelRail(manage)).toBeCloseTo(rootRail, 0);
          expect(await menu.locator('[value="connector:0"]').textContent()).not.toMatch(
            /Enabled|Disabled/,
          );
          if (route === "chat") {
            const first = menu.locator('[value="connector:0"]');
            const child = menu.locator('[value="tools:0"]');
            const next = menu.locator('[value="connector:1"]');
            const gap =
              (await next.boundingBox())!.y -
              ((await child.boundingBox())!.y + (await child.boundingBox())!.height);
            expect(gap).toBeGreaterThan(1);
            expect(await child.locator('[slot="details"] svg').count()).toBe(1);
            const weight = (row: Locator) =>
              row.evaluate((el) =>
                Number(
                  getComputedStyle(el.shadowRoot!.querySelector('[part="label"]')!).fontWeight,
                ),
              );
            expect(await weight(child)).toBeLessThan(await weight(first));
            expect(await menu.locator('[value="add-server"]').isDisabled()).toBe(!canAdmin);
            await (canAdmin ? first : menu.locator('[value="back"]')).focus();
            await page.keyboard.press("ArrowDown");
            expect(await child.evaluate((el) => document.activeElement === el)).toBe(true);
            await page.keyboard.press("Enter");
            await expect.poll(() => menu.getAttribute("data-view")).toBe("tools:documentation");
            const tool = menu.locator('[value="mcp-tool:0"]');
            await tool.waitFor();
            const heading = menu.locator(".agent-chat__capability-menu-state strong");
            expect(await heading.evaluate((el) => el.getBoundingClientRect().x)).toBeCloseTo(
              await tool
                .locator(".agent-chat__capability-menu-label")
                .evaluate((el) => el.getBoundingClientRect().x),
              0,
            );
            await menu.locator('[value="back"]').click();
          }
          await manage.click();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/mcp");
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
          expect(await gateway.getRequests("config.patch")).toHaveLength(0);
          expect(await gateway.getRequests("skills.update")).toHaveLength(0);
        },
      );
    },
  );
});
