import type { Page } from "playwright";
import type { ControlUiMockGatewayScenario } from "../test-helpers/control-ui-e2e.ts";
const ada = {
  type: "human",
  id: "person-ada",
  identity: { type: "profile", id: "person-ada" },
  label: "Ada",
};
const grace = {
  type: "human",
  id: "person-grace",
  identity: { type: "profile", id: "person-grace" },
  label: "Grace",
};
const rows = [
  { key: "agent:forge:review", agentId: "forge", label: "Forge review", status: "failed" },
  { key: "agent:main:icon", label: "Project notes", icon: "book", pinned: true },
  { key: "agent:main:emoji", label: "Release checklist", icon: "🦞", pinned: true },
  { key: "agent:main:owner", label: "Design review", owner: { actor: ada }, pinned: true },
  {
    key: "agent:main:pair",
    label: "Shared planning",
    owner: { actor: ada },
    participants: [{ identity: grace.identity, label: "Grace" }],
    participantCount: 1,
    pinned: true,
  },
  {
    key: "agent:main:stack",
    label: "Team discussion",
    owner: { actor: grace },
    participants: [{ identity: ada.identity, label: "Ada" }],
    participantCount: 3,
    pinned: true,
  },
  { key: "agent:main:color", label: "Operations", icon: "monitor", color: "purple", pinned: true },
  { key: "agent:main:color-owner", label: "Owner accent", owner: { actor: ada }, color: "blue" },
  { key: "agent:main:color-empty", label: "Accent only", color: "green" },
  {
    key: "agent:main:parent",
    label: "Parent plan",
    icon: "book",
    owner: { actor: ada },
    childSessions: ["agent:main:child"],
    color: "blue",
  },
  {
    key: "agent:main:child",
    label: "Child plan",
    category: "",
    icon: "book",
    owner: { actor: ada },
    parentSessionKey: "agent:main:parent",
    childSessions: ["agent:main:grandchild"],
  },
  {
    key: "agent:main:grandchild",
    label: "Nested plan",
    category: "",
    icon: "book",
    owner: { actor: ada },
    parentSessionKey: "agent:main:child",
  },
  { key: "agent:main:empty", label: "Notes without an icon", pinned: true },
  { key: "agent:main:unread", label: "Unread update", unread: true },
  { key: "agent:main:running", label: "Working session", hasActiveRun: true, status: "running" },
  { key: "agent:main:failed", label: "Review needs attention", status: "failed" },
  { key: "agent:main:grace", label: "Review with Grace", owner: { actor: grace } },
  { key: "agent:main:regular-owner", label: "Project follow-up", owner: { actor: ada } },
  ...Array.from({ length: 45 }, (_, index) => ({
    key: `agent:main:overflow-${index}`,
    label: `Project session ${index + 1}`,
  })),
].map((row, index) =>
  Object.assign({ kind: "direct", category: "Projects", updatedAt: 100 - index }, row),
);
export const sidebarColumnScenario = {
  assistantName: "OpenClaw",
  sessionKey: "agent:main:icon",
  featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
  historyMessages: [
    { role: "assistant", content: [{ type: "text", text: "Project notes are ready." }] },
  ],
  presenceUsers: [
    {
      id: "person-ada",
      name: "Ada",
      self: true,
      identity: { type: "profile", id: "person-ada" },
      watchedSessions: [],
    },
    {
      id: "person-grace",
      name: "Grace",
      identity: { type: "profile", id: "person-grace" },
      watchedSessions: [],
    },
  ],
  methodResponses: {
    "agents.list": {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", name: "OpenClaw", identity: { name: "OpenClaw" } },
        { id: "forge", name: "Forge", identity: { name: "Forge", emoji: "🔧" } },
      ],
    },
    "sessions.list": {
      count: rows.length,
      owners: [ada, grace],
      defaults: { contextTokens: null, model: null, modelProvider: null },
      path: "",
      sessions: rows,
      ts: 1,
    },
    "sessions.catalog.list": {
      catalogs: [
        {
          id: "codex",
          label: "Workspace",
          capabilities: { archive: true, continueSession: true },
          hosts: [
            {
              hostId: "node:local",
              label: "Local projects",
              kind: "node",
              connected: true,
              sessions: [
                {
                  threadId: "thread-project",
                  cwd: "/workspace/example",
                  name: "Project handoff",
                  status: "idle",
                  archived: false,
                  canContinue: true,
                  canArchive: true,
                },
              ],
            },
          ],
        },
      ],
    },
  },
} satisfies ControlUiMockGatewayScenario;

export async function measureSidebarColumns(page: Page) {
  return page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar-shell");
    const scroller = document.querySelector<HTMLElement>(".sidebar-shell__body");
    if (!sidebar || !scroller) {
      throw new Error("Missing sidebar column owners");
    }
    const rtl = getComputedStyle(sidebar).direction === "rtl";
    const glyphSelectors = {
      agent: ".sidebar-agent-card__avatar, .sidebar-workspace-header__mark",
      person: ".sidebar-session-group-toggle__person .viewer-avatar",
      roster: ".sidebar-agent-roster__header .sidebar-agent-roster__avatar",
      rosterChevron: ".sidebar-agent-roster__header .sidebar-agent-roster__chevron svg",
      childChevron: ".sidebar-recent-session--team > .sidebar-child-session-toggle svg",
      page: ".nav-item__icon svg",
      section: ".sidebar-session-group-toggle__icon svg",
      provider: ".sidebar-session-catalog-provider-icon",
      project: ".sidebar-session-catalog-project__icon svg",
      online: ".sidebar-online__person .viewer-avatar",
      footer: ".sidebar-identity-card .viewer-avatar",
      icon: ".sidebar-session-indicator .session-glyph__icon svg",
      emoji: ".sidebar-session-indicator .session-glyph__emoji",
      owner: ".sidebar-session-indicator .session-owner-chip:not(.session-owner-stack__front)",
      stack: ".sidebar-session-indicator .session-owner-stack",
      attention: ".sidebar-session-indicator .sidebar-session-attention__icon svg",
      unread: ".sidebar-session-indicator > .session-unread-dot",
      running: ".sidebar-session-indicator .session-glyph--bare",
    };
    const glyphs = Object.entries(glyphSelectors).flatMap(([kind, selector]) =>
      Array.from(sidebar.querySelectorAll(selector))
        .filter(
          (element) =>
            element.checkVisibility({ checkOpacity: true }) &&
            !element.closest(
              ".sidebar-recent-session--team .sidebar-recent-session__details-endcap",
            ),
        )
        .map((element) => {
          const box = element.getBoundingClientRect();
          let level = 0;
          for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            if (parent.matches(".sidebar-session-tree__children")) {
              level++;
            }
          }
          const secondary =
            kind === "person" ||
            kind === "roster" ||
            Boolean(element.closest(".sidebar-recent-session--colored"));
          return {
            kind,
            level,
            secondary,
            center: box.x + box.width / 2,
            width: box.width,
            height: box.height,
          };
        }),
    );
    for (const row of sidebar.querySelectorAll<HTMLElement>(".sidebar-recent-session--colored")) {
      if (!row.checkVisibility()) {
        continue;
      }
      const box = row.getBoundingClientRect();
      const bar = getComputedStyle(row, "::before");
      const width = Number.parseFloat(bar.width);
      const inset =
        Number.parseFloat(bar.insetInlineStart) +
        Number.parseFloat(getComputedStyle(row).borderInlineStartWidth);
      let level = 0;
      for (let parent = row.parentElement; parent; parent = parent.parentElement) {
        if (parent.matches(".sidebar-session-tree__children")) {
          level++;
        }
      }
      glyphs.push({
        kind: "bar",
        level,
        secondary: false,
        center: rtl ? box.right - inset - width / 2 : box.left + inset + width / 2,
        width,
        height: Number.parseFloat(bar.height),
      });
    }
    const textSelectors = [
      ".sidebar-agent-roster__copy > span",
      ".sidebar-agent-card__name-text",
      ".nav-item__text",
      ".sidebar-recent-sessions__label-text:not(.sr-only)",
      ".sidebar-online__person-name",
      ".sidebar-recent-session__name",
      ".sidebar-session-catalog-host__label",
      ".sidebar-session-catalog-project__label",
      ".sidebar-identity-card__name",
    ];
    const texts = Array.from(sidebar.querySelectorAll(textSelectors.join(",")))
      .filter((element) => element.checkVisibility())
      .map((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const box = range.getBoundingClientRect();
        let level = 0;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
          if (parent.matches(".sidebar-session-tree__children")) {
            level++;
          }
        }
        return { text: element.textContent?.trim(), level, start: rtl ? box.right : box.left };
      });
    const scrollerBox = scroller.getBoundingClientRect();
    const scrollbarWidth = scroller.offsetWidth - scroller.clientWidth;
    const style = getComputedStyle(scroller);
    return {
      glyphs,
      texts,
      scrollbarWidth,
      gutter: style.scrollbarGutter,
      overflows: scroller.scrollHeight > scroller.clientHeight,
      contentEnd: rtl
        ? scrollerBox.left + scrollbarWidth + Number.parseFloat(style.paddingInlineEnd)
        : scrollerBox.right - scrollbarWidth - Number.parseFloat(style.paddingInlineEnd),
    };
  });
}
