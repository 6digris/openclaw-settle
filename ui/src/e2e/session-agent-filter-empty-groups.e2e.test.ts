import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each([1280, 390])(
    "filters empty headings by the selected agent at %ipx without changing group data",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:work",
          sessionGroups: ["Main projects", "Research projects", "Empty"],
          sessions: [
            sessionRow("agent:main:work", "Main project", 3, {
              category: "Main projects",
              agentId: "main",
            }),
            sessionRow("agent:research:work", "Research project", 2, {
              category: "Research projects",
              agentId: "research",
            }),
          ],
          historyMessages: [
            { role: "assistant", content: "Synthetic session group demonstration." },
          ],
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: "main", name: "Main" },
                { id: "research", name: "Research" },
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:work"));
        const sidebar = page.locator("openclaw-app-sidebar");
        const filter = page.getByRole("button", { name: "Filter & sort", exact: true });
        const revealSidebar = async () => {
          if (!(await filter.isVisible())) {
            await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
          }
        };
        await revealSidebar();
        const main = sidebar.locator('[data-session-section="category:Main projects"]');
        const research = sidebar.locator('[data-session-section="category:Research projects"]');
        const empty = sidebar.locator('[data-session-section="category:Empty"]');
        await expectBrowser(main).toContainText("Main project");
        await captureUiProof(suite, page, `main-${width}.png`);
        await expectBrowser(research).toHaveCount(0);
        await expectBrowser(empty).toHaveCount(0);

        await sidebar.getByRole("button", { name: /Switch agent/ }).click();
        await sidebar.locator('wa-dropdown-item[value="agent:research"]').click();
        await gateway.waitForRequest("sessions.list", { match: { agentId: "research" } });
        await revealSidebar();
        await expectBrowser(research).toContainText("Research project");
        await expectBrowser(main).toHaveCount(0);
        await expectBrowser(empty).toHaveCount(0);
        await captureUiProof(suite, page, `research-${width}.png`);

        // Never restores drop targets, not the other agent's session rows.
        await filter.click();
        const menu = page.locator(".sidebar-session-sort-menu");
        if (width < 560) {
          await menu.locator('[value="compact:open-empty-groups"]').click();
        } else {
          await menu.locator(".sidebar-session-empty-groups-submenu").hover();
        }
        await menu.locator('[value="empty-groups:never"]').click();
        await expectBrowser(main).toBeVisible();
        await expectBrowser(empty).toBeVisible();
        await expectBrowser(sidebar.locator('[data-session-key="agent:main:work"]')).toHaveCount(0);
        await page.reload();
        await revealSidebar();
        await expectBrowser(main).toBeVisible();
        await expectBrowser(empty).toBeVisible();
        expect(await gateway.getRequests("sessions.groups.put")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.groups.rename")).toHaveLength(0);
        expect(await gateway.getRequests("sessions.groups.delete")).toHaveLength(0);
      });
    },
  );
});
