/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import "../test-helpers/app-sidebar-suite.ts";
import {
  createGateway,
  createSessionsHarness,
  mountSidebar,
  TWO_AGENTS,
  type SidebarLifecycleState,
} from "../test-helpers/app-sidebar.ts";
import "./app-sidebar.ts";

async function chooseEmptyGroups(
  sidebar: SidebarLifecycleState,
  mode: "filtering" | "always" | "never",
) {
  sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort")!.click();
  await sidebar.updateComplete;
  sidebar.querySelector(".sidebar-session-sort-menu")!.dispatchEvent(
    new CustomEvent("wa-select", {
      bubbles: true,
      detail: { item: { value: `empty-groups:${mode}` } },
    }),
  );
  await sidebar.updateComplete;
}

const groupNames = ["Main only", "Research only", "Empty"];
const renderedGroups = (sidebar: SidebarLifecycleState) =>
  [...sidebar.querySelectorAll<HTMLElement>('[data-session-section^="category:"]')].map((section) =>
    section.dataset.sessionSection?.slice("category:".length),
  );

describe("AppSidebar agent-filtered group visibility", () => {
  it.each(["filtering", "always", "never"] as const)(
    "honors %s while switching agents without changing the shared catalog",
    async (mode) => {
      const harness = createSessionsHarness("main", ["agent:main:work"]);
      const main = harness.sessions.state.result!;
      main.sessions[0]!.category = "Main only";
      const research = {
        ...main,
        sessions: [{ ...main.sessions[0]!, key: "agent:research:work", category: "Research only" }],
      };
      harness.publish({ groups: groupNames });
      harness.list.mockImplementation(async (options) =>
        options?.agentId === "research" ? research : main,
      );
      const { sidebar, context } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        harness.sessions,
        "panel",
        TWO_AGENTS,
      );
      await chooseEmptyGroups(sidebar, mode);
      expect(renderedGroups(sidebar)).toEqual(mode === "never" ? groupNames : ["Main only"]);

      for (const [agentId, result, group] of [
        ["research", research, "Research only"],
        ["main", main, "Main only"],
      ] as const) {
        context.agentSelection.set(agentId);
        harness.publishList({ agentId, result });
        await sidebar.updateComplete;
        expect(renderedGroups(sidebar)).toEqual(mode === "never" ? groupNames : [group]);
      }
      expect(harness.sessions.state.groups).toEqual(groupNames);
      expect(harness.groupsPut).not.toHaveBeenCalled();
      expect(harness.groupsRename).not.toHaveBeenCalled();
      expect(harness.groupsDelete).not.toHaveBeenCalled();
    },
  );

  it.each([null, { ...TWO_AGENTS, agents: TWO_AGENTS.agents.slice(0, 1) }])(
    "keeps empty groups by default without a known multi-agent filter (%j)",
    async (agents) => {
      const harness = createSessionsHarness("main", ["agent:main:work"]);
      harness.sessions.state.result!.sessions[0]!.category = "Main only";
      harness.publish({ groups: groupNames });
      const { sidebar } = await mountSidebar(
        createGateway({} as GatewayBrowserClient),
        harness.sessions,
        "panel",
        agents,
      );
      expect(renderedGroups(sidebar)).toEqual(groupNames);
      await chooseEmptyGroups(sidebar, "always");
      expect(renderedGroups(sidebar)).toEqual(["Main only"]);
    },
  );
});
