import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  submitInputDialog,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const agents = {
  agents: [
    { id: "main", name: "Main" },
    { id: "research", name: "Research" },
  ],
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
};
const rows = [
  sessionRow("agent:main:main", "Main", 1),
  sessionRow("agent:main:work", "Main task", 2, { category: "Shared" }),
  sessionRow("agent:research:main", "Research", 1),
  sessionRow("agent:research:work", "Research task", 3, { category: "Shared" }),
];

suite.define(() => {
  it("keeps owned empty groups with Never selected, switches same-name defaults, and leaves the other owner unchanged after rename/delete", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessions: rows,
      sessionGroupsByAgent: {
        main: ["Shared", "Main empty"],
        research: ["Shared", "Research empty"],
      },
      sessionGroupDefaultsByAgent: {
        main: { Shared: { cwd: "/workspace/main", worktree: false } },
        research: { Shared: { cwd: "/workspace/research", worktree: true } },
      },
      methodResponses: {
        "agents.list": agents,
        "sessions.list": sessionsListResponse(rows),
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          repositoryStatus: "git",
        },
      },
    });
    const sidebar = page.locator("openclaw-app-sidebar");
    const group = (name: string) =>
      sidebar.locator('[data-session-section="category:' + name + '"]');
    const selectAgent = async (name: string) => {
      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
      await sidebar
        .locator(".sidebar-agent-menu")
        .getByRole("menuitemradio", { name, exact: true })
        .click();
    };
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await expectBrowser(group("Main empty")).toBeVisible();
      await sidebar.getByRole("button", { name: "Filter & sort" }).click();
      const menu = sidebar.locator(".sidebar-session-sort-menu");
      await menu.locator(".sidebar-session-empty-groups-submenu").hover();
      await menu.locator('[value="empty-groups:never"]').click();
      await expectBrowser(group("Main empty")).toBeVisible();
      await expectBrowser(group("Research empty")).toHaveCount(0);
      await captureUiProof(suite, page, "owned-groups-main-never.png");
      await selectAgent("Research");
      await expectBrowser(
        sidebar.locator('[data-session-key="agent:research:work"]'),
      ).toBeVisible();
      // Capture before the ownership assertion so the trusted baseline retains
      // a fresh image of its wrong-agent catalog rather than only a failure log.
      await captureUiProof(suite, page, "owned-groups-research-never.png");
      await expectBrowser(group("Research empty")).toBeVisible();
      await expectBrowser(group("Main empty")).toHaveCount(0);
      await group("Shared").locator(".sidebar-recent-sessions__head").hover();
      await group("Shared").getByRole("link", { name: "New session in Shared" }).click();
      await expectBrowser(page.locator(".new-session-page__message")).toBeVisible();
      expect(new URL(page.url()).searchParams.get("agent")).toBe("research");
      await expectBrowser(page.locator("#new-session-project-trigger")).toContainText("research");
      await expectBrowser(page.locator("#new-session-checkout-trigger")).toHaveAttribute(
        "data-worktree",
        "true",
      );
      await captureUiProof(suite, page, "owned-groups-research-defaults.png");
      await group("Shared").locator(".sidebar-recent-sessions__head").hover();
      await group("Shared").getByRole("button", { name: "Group options for Shared" }).click();
      await page.getByRole("menuitem", { name: "Rename group" }).click();
      await submitInputDialog(page, "Research renamed");
      expect((await gateway.waitForRequest("sessions.groups.rename")).params).toEqual({
        agentId: "research",
        name: "Shared",
        to: "Research renamed",
      });
      await expectBrowser(group("Research renamed")).toBeVisible();
      await selectAgent("Main");
      await expectBrowser(group("Shared")).toBeVisible();
      await expectBrowser(group("Research renamed")).toHaveCount(0);
      await group("Main empty").locator(".sidebar-recent-sessions__head").hover();
      await group("Main empty")
        .getByRole("button", { name: "Group options for Main empty" })
        .click();
      await page.getByRole("menuitem", { name: "Delete group" }).click();
      await page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      expect((await gateway.waitForRequest("sessions.groups.delete")).params).toEqual({
        agentId: "main",
        name: "Main empty",
      });
      await expectBrowser(group("Main empty")).toHaveCount(0);
      await selectAgent("Research");
      await expectBrowser(group("Research empty")).toBeVisible();
      await expectBrowser(group("Research renamed")).toBeVisible();
      await captureUiProof(suite, page, "owned-groups-independent-mutations.png");
    } finally {
      await context.close();
    }
  });

  it("loads only the clicked roster row's catalog and creates its group without retargeting to the foreground", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessions: rows,
      sessionGroupsByAgent: { main: ["Main only"], research: ["Research only"] },
      methodResponses: { "agents.list": agents, "sessions.list": sessionsListResponse(rows) },
    });
    const sidebar = page.locator("openclaw-app-sidebar");
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      await sidebar.locator(".sidebar-agent-card__main").click();
      await sidebar.locator('wa-dropdown-item[value="command:sidebar-agents"]').click();
      const research = sidebar.locator(
        '.sidebar-recent-session[data-session-key="agent:research:work"]',
      );
      await expectBrowser(research).toBeVisible();
      expect(
        await gateway.getRequests("sessions.groups.list", { agentId: "research" }),
      ).toHaveLength(0);
      await research.click({ button: "right" });
      await gateway.waitForRequest("sessions.groups.list", { match: { agentId: "research" } });
      const rowMenu = page.locator("openclaw-session-menu");
      await rowMenu.getByRole("menuitem", { name: /Move to group/ }).hover();
      await expectBrowser(
        rowMenu.getByRole("menuitem", { name: "Research only", exact: true }),
      ).toBeVisible();
      await expectBrowser(
        rowMenu.getByRole("menuitem", { name: "Main only", exact: true }),
      ).toHaveCount(0);
      await rowMenu.getByRole("menuitem", { name: "New group", exact: true }).click();
      await submitInputDialog(page, "Research created");
      expect((await gateway.waitForRequest("sessions.groups.put")).params).toEqual({
        agentId: "research",
        names: ["Research created"],
        append: true,
      });
      expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
        agentId: "research",
        key: "agent:research:work",
        category: "Research created",
      });
      await expectBrowser(sidebar.locator(".sidebar-agent-roster__row")).toHaveCount(2);
      await captureUiProof(suite, page, "owned-groups-roster-row.png");
    } finally {
      await context.close();
    }
  });
});
