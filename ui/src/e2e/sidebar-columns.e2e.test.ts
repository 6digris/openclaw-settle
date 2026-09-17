import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  chatSessionListResponse,
  expectDefined,
  controlUiSessionUrl,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { measureSidebarColumns, sidebarColumnScenario } from "./sidebar-column.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("aligns sidebar sections and follows the real scrollbar gutter", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      reducedMotion: "reduce",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const sessions = Array.from({ length: 60 }, (_, index) => ({
      key: index === 0 ? "agent:main:alignment" : `agent:main:alignment-${index}`,
      kind: "direct",
      label: index === 0 ? "Pinned note" : `Overflow session ${index}`,
      pinned: index === 0,
      category: index % 2 === 0 ? "OpenClaw" : "Gateway",
      updatedAt: 60 - index,
      ...(index === 0 ? { icon: "book" } : {}),
      ...(index === 1 ? { icon: "🦞", color: "purple" } : {}),
      ...(index === 6 ? { color: "blue" } : {}),
      ...(index === 2 ? { unread: true } : {}),
      ...(index === 3 ? { hasActiveRun: true, status: "running" } : {}),
      ...(index === 4 || index === 5
        ? { owner: { actor: { type: "human", id: "person-a", label: "Ada" } } }
        : {}),
      ...(index === 5
        ? {
            participants: [{ identity: { type: "profile", id: "person-b" }, label: "Grace" }],
            participantCount: 3,
          }
        : {}),
    }));
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.list": chatSessionListResponse(sessions),
        "sessions.catalog.list": {
          catalogs: ["codex", "claude"].map((id) => ({
            id,
            label: id === "codex" ? "Codex" : "Claude Code",
            capabilities: { archive: true, continueSession: true },
            hosts: [
              {
                hostId: `node:${id}`,
                label: `Local ${id}`,
                kind: "node",
                connected: true,
                sessions: [
                  {
                    threadId: `thread-${id}`,
                    cwd: "/workspace/column-project",
                    name: `${id} alignment session`,
                    status: "idle",
                    archived: false,
                    canContinue: true,
                    canArchive: true,
                  },
                ],
              },
            ],
          })),
        },
      },
      presenceUsers: [
        { id: "person-a", name: "Ada", watchedSessions: [] },
        { id: "person-b", name: "Grace", watchedSessions: [] },
        { id: "person-c", name: "Linus", watchedSessions: [] },
      ],
      sessionKey: "agent:main:alignment",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:alignment"));
      await page.locator(".sidebar-online__person").first().waitFor();
      await page
        .locator('.sidebar-recent-session[data-session-key="agent:main:alignment"]')
        .waitFor();
      await page.locator('[data-session-section="catalog:codex"]').waitFor();
      await page.locator('[data-session-section="catalog:claude"]').waitFor();
      await page.locator('[data-session-section="category:Gateway"]').waitFor();
      await page.locator(".sidebar-session-toolbar").waitFor();
      await page.getByRole("button", { name: "Show more" }).first().waitFor();
      const activeRow = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:alignment"]',
      );
      await activeRow.hover();
      await activeRow.getByRole("button", { name: "Open session menu" }).waitFor();
      const layout = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(".sidebar-shell__body");
        if (!scroller) {
          throw new Error("Missing sidebar scroll container");
        }
        const scrollerBounds = scroller.getBoundingClientRect();
        const scrollerStyle = getComputedStyle(scroller);
        const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth;
        const contentEdge = scrollerBounds.right - scrollbarWidth;
        const bounds = (selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) {
            throw new Error(`Missing sidebar alignment fixture ${selector}`);
          }
          const box = element.getBoundingClientRect();
          return { left: Math.round(box.left), right: Math.round(box.right) };
        };
        return {
          contentEdge: Math.round(contentEdge),
          catalogClaude: bounds(
            '[data-session-section="catalog:claude"] .sidebar-recent-sessions__head',
          ),
          catalogCodex: bounds(
            '[data-session-section="catalog:codex"] .sidebar-recent-sessions__head',
          ),
          gateway: bounds(
            '[data-session-section="category:Gateway"] .sidebar-recent-sessions__head',
          ),
          nav: bounds(".nav-item"),
          navLabel: bounds(".nav-item__text"),
          onlineHeader: bounds(".sidebar-online .sidebar-recent-sessions__head"),
          onlineRow: bounds(".sidebar-online__person"),
          pinnedSessionLabel: bounds(
            '.sidebar-zone-entry .sidebar-recent-session[data-session-key="agent:main:alignment"] .sidebar-recent-session__name',
          ),
          regularSessionLabel: bounds(
            '.sidebar-sessions .sidebar-recent-session[data-session-key="agent:main:alignment-1"] .sidebar-recent-session__name',
          ),
          paddingInlineEnd: Number.parseFloat(scrollerStyle.paddingInlineEnd),
          sidebarPadX: Number.parseFloat(scrollerStyle.getPropertyValue("--sidebar-pad-x")),
          scrollbarGutter: scrollerStyle.scrollbarGutter,
          overflows: scroller.scrollHeight > scroller.clientHeight,
          sessionHeader: bounds(".sidebar-sessions .sidebar-recent-sessions__head"),
          sessionRow: bounds(".sidebar-sessions .sidebar-recent-session"),
          toolbar: bounds(".sidebar-session-toolbar"),
        };
      });

      expect(layout.overflows).toBe(true);
      expect(layout.scrollbarGutter).toBe("stable");
      expect(
        new Set(
          [
            layout.nav,
            layout.onlineHeader,
            layout.onlineRow,
            layout.sessionHeader,
            layout.sessionRow,
            layout.catalogCodex,
            layout.catalogClaude,
            layout.gateway,
            layout.toolbar,
          ].map(({ left }) => left),
        ),
      ).toEqual(new Set([layout.nav.left]));
      expect(layout.onlineHeader.right).toBe(layout.sessionHeader.right);
      expect(layout.onlineRow.right).toBe(layout.sessionRow.right);
      expect(layout.nav.right).toBe(layout.sessionRow.right);
      expect(layout.catalogCodex.right).toBe(layout.sessionHeader.right);
      expect(layout.catalogClaude.right).toBe(layout.sessionHeader.right);
      expect(layout.toolbar.right).toBe(layout.sessionHeader.right);
      expect(layout.pinnedSessionLabel.left).toBe(layout.navLabel.left);
      expect(layout.regularSessionLabel.left).toBe(layout.navLabel.left);
      expect(layout.paddingInlineEnd).toBe(layout.sidebarPadX);
      expect(layout.contentEdge - layout.sessionRow.right).toBeCloseTo(layout.sidebarPadX, 1);
      await page.mouse.move(900, 400);
      await page.locator(".session-owner-stack__count").waitFor();
      for (const width of [1280, 1440, 390]) {
        await page.setViewportSize({ width, height: 900 });
        if (width === 390) {
          await page
            .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
            .first()
            .click();
          await page.locator(".shell--mobile-nav").waitFor();
        }
        for (const direction of ["ltr", "rtl"]) {
          await page.evaluate((dir) => {
            document.documentElement.dir = dir;
          }, direction);
          for (const colorScheme of ["light", "dark"] as const) {
            await page.emulateMedia({ colorScheme });
            await page.waitForFunction(
              (theme) => document.documentElement.dataset.themeMode === theme,
              colorScheme,
            );
            for (const scrollbar of ["thin", "none"] as const) {
              await page.locator(".sidebar-shell__body").evaluate((element, value) => {
                element.style.scrollbarWidth = value;
              }, scrollbar);
              const columns = await measureSidebarColumns(page);
              expect(new Set(columns.glyphs.map((glyph) => glyph.kind))).toEqual(
                new Set([
                  "agent",
                  "page",
                  "section",
                  "provider",
                  "project",
                  "bar",
                  "online",
                  "footer",
                  "icon",
                  "emoji",
                  "owner",
                  "stack",
                  "unread",
                  "running",
                ]),
              );
              const agent = expectDefined(
                columns.glyphs.find((glyph) => glyph.kind === "agent"),
                "agent avatar geometry",
              );
              const firstText = expectDefined(columns.texts[0], "agent name geometry");
              for (const glyph of columns.glyphs) {
                expect(
                  Math.abs(
                    glyph.center -
                      agent.center -
                      (direction === "rtl" ? -1 : 1) *
                        (glyph.level * 20 + (glyph.secondary ? 36 : 0)),
                  ),
                  JSON.stringify({ width, direction, colorScheme, glyph, agent }),
                ).toBeLessThanOrEqual(0.5);
              }
              for (const text of columns.texts) {
                expect(
                  Math.abs(
                    text.start - firstText.start - (direction === "rtl" ? -1 : 1) * text.level * 20,
                  ),
                  JSON.stringify({ width, direction, colorScheme, text, firstText }),
                ).toBeLessThanOrEqual(0.5);
              }
              expect(columns.gutter).toBe("stable");
              await activeRow.hover();
              const hovered = await activeRow.evaluate((row) => {
                const icon = row.querySelector(".session-glyph__icon svg")!;
                const iconBox = icon.getBoundingClientRect();
                const name = row.querySelector(".sidebar-recent-session__name")!;
                const range = document.createRange();
                range.selectNodeContents(name);
                const textBox = range.getBoundingClientRect();
                const rtl = getComputedStyle(row).direction === "rtl";
                const actions = row.querySelector(".sidebar-recent-session__aside")!;
                const actionBox = actions.getBoundingClientRect();
                return {
                  iconCenter: iconBox.x + iconBox.width / 2,
                  textStart: rtl ? textBox.right : textBox.left,
                  actionGap: rtl ? iconBox.left - actionBox.right : actionBox.left - iconBox.right,
                };
              });
              expect(Math.abs(hovered.iconCenter - agent.center)).toBeLessThanOrEqual(0.5);
              expect(Math.abs(hovered.textStart - firstText.start)).toBeLessThanOrEqual(0.5);
              expect(hovered.actionGap).toBeGreaterThan(0);
              await page.mouse.move(width - 1, 0);
              expect(columns.scrollbarWidth > 0).toBe(scrollbar === "thin");
            }
          }
        }
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each(["person", "roster"] as const)(
    "aligns composite glyphs and child levels in %s mode",
    async (mode) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        reducedMotion: "reduce",
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      await page.addInitScript((groupingMode) => {
        localStorage.setItem(
          "openclaw:sidebar:sessions:grouping",
          groupingMode === "person" ? "person" : "category",
        );
      }, mode);
      await installMockGateway(page, sidebarColumnScenario);
      try {
        await page.goto(
          controlUiSessionUrl(suite.server.baseUrl, sidebarColumnScenario.sessionKey),
        );
        if (mode === "roster") {
          await page.locator(".sidebar-agent-card__main").click();
          await page.locator('wa-dropdown-item[value="command:sidebar-agents"]').click();
          await page.locator('[data-agent-collapse="forge"]').click();
        }
        await page
          .locator(
            mode === "roster"
              ? ".sidebar-agent-roster__header"
              : ".sidebar-session-group-toggle__person",
          )
          .first()
          .waitFor();
        if (mode === "person") {
          await page
            .locator(".sidebar-session-group-toggle > .sidebar-session-group-toggle__person")
            .waitFor();
          await page
            .locator(".sidebar-session-group-person > .sidebar-session-group-toggle__person")
            .waitFor();
        }
        for (const width of [1280, 1440, 390]) {
          await page.setViewportSize({ width, height: 900 });
          if (width === 390) {
            await page
              .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
              .first()
              .click();
            await page.locator(".shell--mobile-nav").waitFor();
          }
          for (const key of ["agent:main:parent", "agent:main:child"]) {
            const toggle = page.locator(`[data-child-session-toggle="${key}"]`).first();
            if ((await toggle.getAttribute("aria-expanded")) === "false") {
              await toggle.click();
            }
          }
          await page.locator('[data-session-key="agent:main:grandchild"]').waitFor();
          await page.mouse.move(width - 1, 0);
          for (const direction of ["ltr", "rtl"]) {
            await page.evaluate((dir) => {
              document.documentElement.dir = dir;
            }, direction);
            for (const colorScheme of ["light", "dark"] as const) {
              await page.emulateMedia({ colorScheme });
              await page.waitForFunction(
                (theme) => document.documentElement.dataset.themeMode === theme,
                colorScheme,
              );
              for (const scrollbar of ["thin", "none"] as const) {
                await page.locator(".sidebar-shell__body").evaluate((element, value) => {
                  element.style.scrollbarWidth = value;
                }, scrollbar);
                const columns = await measureSidebarColumns(page);
                const axis = expectDefined(
                  columns.glyphs.find((glyph) => glyph.kind === "agent"),
                  "top-level axis",
                );
                const textAxis = expectDefined(
                  columns.texts.find((text) => text.level === 0),
                  "top-level text",
                );
                const sign = direction === "rtl" ? -1 : 1;
                expect(
                  columns.glyphs.some(
                    (glyph) => glyph.kind === (mode === "roster" ? "roster" : "person"),
                  ),
                ).toBe(true);
                expect(new Set(columns.texts.map((text) => text.level))).toEqual(
                  new Set([0, 1, 2]),
                );
                expect(columns.glyphs.some((glyph) => glyph.kind === "bar")).toBe(true);
                for (const glyph of columns.glyphs) {
                  expect(
                    Math.abs(
                      glyph.center -
                        axis.center -
                        sign * (glyph.level * 20 + (glyph.secondary ? 36 : 0)),
                    ),
                    JSON.stringify({ mode, width, direction, colorScheme, scrollbar, glyph, axis }),
                  ).toBeLessThanOrEqual(0.5);
                }
                for (const text of columns.texts) {
                  expect(
                    Math.abs(text.start - textAxis.start - sign * text.level * 20),
                    JSON.stringify({
                      mode,
                      width,
                      direction,
                      colorScheme,
                      scrollbar,
                      text,
                      textAxis,
                    }),
                  ).toBeLessThanOrEqual(0.5);
                }
                expect(columns.gutter).toBe("stable");
                expect(columns.scrollbarWidth > 0).toBe(scrollbar === "thin");
              }
            }
          }
        }
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
