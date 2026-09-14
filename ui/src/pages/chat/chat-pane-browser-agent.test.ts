import { nothing, render } from "lit";
import { afterEach, expect, it } from "vitest";
import { loadSettings } from "../../app/settings.ts";
import { sidebarPanelDefinitions } from "./chat-pane-embedded-panels.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

afterEach(() => document.body.replaceChildren());

it("passes the pane agent to the embedded Browser panel", () => {
  const state = {
    browserPanelAvailable: true,
    connected: false,
    resourceBasePath: "",
    sessionKey: "agent:research:main",
    settings: loadSettings(),
    sidebarContent: null,
    sidebarLayout: { columns: [] },
  } as unknown as ChatPageHost;
  const browser = sidebarPanelDefinitions({
    state,
    agentId: "research",
  } as Parameters<typeof sidebarPanelDefinitions>[0]).find(
    (definition) => definition.slot === "browser",
  );
  const mount = document.body.appendChild(document.createElement("div"));
  render(browser?.content ?? nothing, mount);
  expect(
    (
      mount.querySelector("openclaw-browser-panel") as HTMLElement & {
        agentId: string | null;
      }
    ).agentId,
  ).toBe("research");
});
