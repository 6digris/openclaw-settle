import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createGateway,
  createGatewayHarness,
  createSessions,
  mountSidebar,
  TWO_AGENTS,
} from "../app-sidebar.ts";
import "../../components/app-sidebar.ts";

describe("AppSidebar agent menu scope", () => {
  it.each([0, 1])(
    "keeps agent actions without an All agents tile with %i configured agents",
    async (count) => {
      const gateway = createGateway({} as GatewayBrowserClient);
      const { sidebar } = await mountSidebar(
        gateway,
        createSessions("main", ["agent:main:main"]),
        "panel",
        {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: count === 0 ? [] : [{ id: "main", identity: { name: "Molty", emoji: "🦞" } }],
        },
      );
      sidebar.connected = true;
      await sidebar.updateComplete;

      sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector(".sidebar-agent-menu");
      expect(menu?.querySelector(".sidebar-agent-menu__filter")).toBeNull();
      expect(menu?.querySelector('[value="scope:all"]')).toBeNull();
      expect(menu?.querySelectorAll('wa-dropdown-item[value^="agent:"]')).toHaveLength(count);
      expect(
        [...(menu?.children ?? [])]
          .filter((element) => element.localName === "wa-dropdown-item")
          .map((element) => element.getAttribute("value")),
      ).toEqual([
        "command:new-agent",
        "command:agents-directory",
        "command:capabilities",
        "command:agent-settings",
      ]);
    },
  );

  it.each(["chip", "roster"] as const)(
    "opens See all agents without changing the agent, scope, or %s mode",
    async (mode) => {
      const { sidebar, context } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        createSessions("main", ["agent:main:main"]),
        "panel",
        TWO_AGENTS,
      );
      const onNavigate = vi.fn();
      sidebar.connected = true;
      sidebar.onNavigate = onNavigate;
      sidebar.activeRouteId = "skills";
      context.agentSelection.set("research");
      context.agentSelection.setScope(null);
      sidebar.sidebarAgentsMode = mode;
      await sidebar.updateComplete;

      sidebar
        .querySelector<HTMLButtonElement>(
          ".sidebar-agent-card__main, .sidebar-workspace-header__main",
        )
        ?.click();
      await sidebar.updateComplete;
      const item = sidebar.querySelector<HTMLElement>(
        '.sidebar-agent-menu [value="command:agents-directory"]',
      );
      expect(item?.textContent?.trim()).toBe("See all agents");
      expect(item?.hasAttribute("aria-checked")).toBe(false);
      item?.click();
      await sidebar.updateComplete;

      expect(onNavigate).toHaveBeenCalledExactlyOnceWith("agents-home", undefined);
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      expect(context.agentSelection.state).toEqual({ selectedId: "research", scopeId: null });
      expect(sidebar.sidebarAgentsMode).toBe(mode);
    },
  );

  it.each(["chip", "roster"] as const)(
    "opens the active agent's settings in %s mode",
    async (mode) => {
      const gateway = createGateway({} as GatewayBrowserClient);
      const { sidebar, context } = await mountSidebar(
        gateway,
        createSessions("main", ["agent:main:main"]),
        "panel",
        TWO_AGENTS,
      );
      const onNavigate = vi.fn();
      sidebar.connected = true;
      sidebar.onNavigate = onNavigate;
      sidebar.activeRouteId = "skills";
      context.agentSelection.set("research");
      context.agentSelection.setScope(null);
      sidebar.sidebarAgentsMode = mode;
      await sidebar.updateComplete;

      sidebar
        .querySelector<HTMLButtonElement>(
          ".sidebar-agent-card__main, .sidebar-workspace-header__main",
        )
        ?.click();
      await sidebar.updateComplete;
      const actionRow = sidebar.querySelector<HTMLElement>(
        '.sidebar-agent-menu [value="command:agent-settings"]',
      );
      expect(actionRow?.textContent?.trim()).toBe("research settings");
      actionRow?.click();
      await sidebar.updateComplete;
      expect(onNavigate).toHaveBeenCalledWith("agents", { pathname: "/settings/agents/research" });
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
    },
  );

  it.each(["main", "research"])(
    "chooses %s from the workspace menu and leaves roster mode",
    async (agentId) => {
      const { sidebar, context } = await mountSidebar(
        createGatewayHarness({} as GatewayBrowserClient).gateway,
        createSessions("main", ["agent:main:main", "agent:research:main"]),
        "panel",
        TWO_AGENTS,
      );
      sidebar.activeRouteId = "skills";
      sidebar.connected = true;
      sidebar.sidebarAgentsMode = "roster";
      context.agentSelection.setScope(null);
      await sidebar.updateComplete;
      sidebar.querySelector<HTMLButtonElement>(".sidebar-workspace-header__main")?.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector(".sidebar-agent-menu")!;
      expect(menu.querySelector("[aria-checked], .session-menu__check")).toBeNull();
      expect(
        menu.querySelector(".sidebar-agent-menu__agent-switch--active")?.getAttribute("value"),
      ).toBe("scope:all");
      expect(menu.querySelector('[value="command:help"], [value="command:all-agents"]')).toBeNull();
      menu.querySelector<HTMLElement>(`[value="agent:${agentId}"]`)?.click();
      await sidebar.updateComplete;
      expect(sidebar.sidebarAgentsMode).toBe("chip");
      expect(sidebar.activeRouteId).toBe("skills");
      expect(context.agentSelection.state).toEqual({ selectedId: agentId, scopeId: agentId });
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      expect(sidebar.querySelector(".sidebar-agent-card__main")).not.toBeNull();
    },
  );

  it("moves the scope ring between the active agent and All agents", async () => {
    const { sidebar, context } = await mountSidebar(
      createGatewayHarness({} as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      TWO_AGENTS,
    );
    sidebar.activeRouteId = "skills";
    context.agentSelection.set("research");
    context.agentSelection.setScope(null);
    await sidebar.updateComplete;
    for (const mode of ["chip", "roster"] as const) {
      sidebar
        .querySelector<HTMLButtonElement>(
          ".sidebar-agent-card__main, .sidebar-workspace-header__main",
        )
        ?.click();
      await sidebar.updateComplete;
      const menu = sidebar.querySelector(".sidebar-agent-menu")!;
      expect(
        menu.querySelector(".sidebar-agent-menu__agent-switch--active")?.getAttribute("value"),
      ).toBe(mode === "roster" ? "scope:all" : "agent:research");
      expect(
        menu.querySelector('[aria-checked], .session-menu__check, [value="command:all-agents"]'),
      ).toBeNull();
      expect(
        [...menu.querySelectorAll('wa-dropdown-item[value^="command:"]')].map((item) =>
          item.getAttribute("value"),
        ),
      ).toEqual([
        "command:new-agent",
        "command:agents-directory",
        "command:capabilities",
        "command:agent-settings",
      ]);
      menu
        .querySelector<HTMLElement>(
          mode === "chip" ? '[value="scope:all"]' : '[value="agent:research"]',
        )
        ?.click();
      await vi.waitFor(() =>
        expect(sidebar.sidebarAgentsMode).toBe(mode === "chip" ? "roster" : "chip"),
      );
      expect(sidebar.querySelector(".sidebar-agent-menu")).toBeNull();
      expect(context.agentSelection.state.selectedId).toBe("research");
    }
  });
});
