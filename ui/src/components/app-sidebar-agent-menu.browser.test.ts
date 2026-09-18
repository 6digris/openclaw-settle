import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../test-helpers/load-styles.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("sidebar agent menu layout", () => {
  it("centers short and wrapped names under active and inactive avatars", async () => {
    await import("./app-sidebar.ts");
    const { createGatewayHarness, createSessions, mountSidebar } =
      await import("../test-helpers/app-sidebar.ts");
    const { sidebar } = await mountSidebar(
      createGatewayHarness({ instanceId: "self-instance" } as GatewayBrowserClient).gateway,
      createSessions("main", ["agent:main:main"]),
      "panel",
      {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Molty" },
          { id: "release", name: "Release reviewer" },
          { id: "research", name: "Research planning and documentation assistant" },
          { id: "scout", name: "Scout" },
        ],
      },
    );
    sidebar.connected = true;
    await sidebar.updateComplete;
    sidebar.querySelector<HTMLButtonElement>(".sidebar-agent-card__main")?.click();
    await sidebar.updateComplete;

    const tiles = Array.from(
      sidebar.querySelectorAll<HTMLElement>(".sidebar-agent-menu__agent-switch"),
    );
    expect(tiles).toHaveLength(5);
    await expect
      .poll(() =>
        tiles.map((tile) => tile.classList.contains("sidebar-agent-menu__agent-switch--active")),
      )
      .toEqual([false, true, false, false, false]);
    await document.fonts.ready;
    for (const tile of tiles) {
      const avatar = tile.querySelector<HTMLElement>(".sidebar-agent-menu__agent-avatar")!;
      const label = tile.querySelector<HTMLElement>(".agent-select__option-label")!;
      await expect.poll(() => avatar.getBoundingClientRect().width).toBeGreaterThan(0);
      const avatarBox = avatar.getBoundingClientRect();
      const labelBox = label.getBoundingClientRect();
      expect(
        Math.abs(labelBox.x + labelBox.width / 2 - (avatarBox.x + avatarBox.width / 2)),
        label.textContent ?? "agent name",
      ).toBeLessThanOrEqual(1);
    }
  });

  it.each([
    { theme: "light", width: 1440 },
    { theme: "dark", width: 1440 },
    { theme: "light", width: 390 },
    { theme: "dark", width: 390 },
  ])(
    "matches identity header geometry with an inset static workspace mark ($theme, $width px)",
    async ({ theme, width }) => {
      const { page } = await import("vitest/browser");
      const originalTheme = document.documentElement.getAttribute("data-theme-mode");
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      onTestFinished(async () => {
        if (originalTheme === null) {
          document.documentElement.removeAttribute("data-theme-mode");
        } else {
          document.documentElement.setAttribute("data-theme-mode", originalTheme);
        }
        await page.viewport(viewport.width, viewport.height);
      });
      document.documentElement.setAttribute("data-theme-mode", theme);
      await page.viewport(width, 900);
      await import("./app-sidebar.ts");
      await import("./sidebar-agent-roster.ts");
      const { createGatewayHarness, createSessions, mountSidebar } =
        await import("../test-helpers/app-sidebar.ts");
      const { sidebar } = await mountSidebar(
        createGatewayHarness({} as GatewayBrowserClient).gateway,
        createSessions("main", ["agent:main:main"]),
        "panel",
        {
          defaultId: "main",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "main", name: "OpenClaw" },
            { id: "research", name: "Research" },
          ],
        },
      );
      await document.fonts.ready;
      const measure = (header: HTMLElement, avatarSelector: string) => {
        const avatar = header.querySelector<HTMLElement>(avatarSelector)!.getBoundingClientRect();
        const name = header
          .querySelector<HTMLElement>(".sidebar-agent-card__name-text")!
          .getBoundingClientRect();
        const chevron = header
          .querySelector<HTMLElement>(".sidebar-agent-card__chevron")!
          .getBoundingClientRect();
        return [
          avatar.width,
          avatar.height,
          name.x - avatar.right,
          chevron.x - name.right,
          name.y + name.height / 2 - (avatar.y + avatar.height / 2),
          chevron.y + chevron.height / 2 - (avatar.y + avatar.height / 2),
        ];
      };
      const agent = measure(
        sidebar.querySelector<HTMLElement>(".sidebar-agent-card__main")!,
        ".sidebar-agent-card__avatar",
      );
      sidebar.sidebarAgentsMode = "roster";
      await sidebar.updateComplete;
      const workspaceHeader = sidebar.querySelector<HTMLElement>(
        ".sidebar-workspace-header__main",
      )!;
      const workspace = measure(workspaceHeader, ".sidebar-workspace-header__mark");
      for (const [index, dimension] of agent.entries()) {
        expect(Math.abs(workspace[index]! - dimension)).toBeLessThanOrEqual(1);
      }
      const mark = workspaceHeader.querySelector(".sidebar-workspace-header__mark")!;
      const markBox = mark.getBoundingClientRect();
      const glyphBox = mark.querySelector("svg")!.getBoundingClientRect();
      expect(glyphBox.width).toBeGreaterThan(0);
      expect(glyphBox.width).toBeLessThan(markBox.width);
      expect(glyphBox.height).toBeLessThan(markBox.height);
      expect(glyphBox.width).toBe(glyphBox.height);
      expect(
        Math.abs(glyphBox.x + glyphBox.width / 2 - (markBox.x + markBox.width / 2)),
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(glyphBox.y + glyphBox.height / 2 - (markBox.y + markBox.height / 2)),
      ).toBeLessThanOrEqual(1);
      expect(mark.querySelector("animate, animateTransform")).toBeNull();
      expect(mark.getAnimations({ subtree: true })).toHaveLength(0);
    },
  );
});
