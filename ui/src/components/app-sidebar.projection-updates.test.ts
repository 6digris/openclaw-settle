/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createGatewayHarness,
  createSessionsHarness,
  mountSidebar,
} from "../test-helpers/app-sidebar.ts";
import "../test-helpers/app-sidebar-suite.ts";
import * as agentSessionRows from "./app-sidebar-agent-session-rows.ts";
import { AppSidebarSessionNavigationElement } from "./app-sidebar-session-navigation.ts";
import "./app-sidebar.ts";

/** Use the real sidebar and menu with a bounded, deterministic session forest. */
async function mountProjectionFixture(rootCount: number) {
  const keys = Array.from({ length: rootCount }, (_, index) => `agent:main:task-${index}`);
  const children = keys
    .filter((_, index) => index % 4 === 0)
    .map((_, index) => `agent:main:subagent:child-${index}`);
  const harness = createSessionsHarness("main", [...keys, ...children]);
  for (const [index, row] of harness.sessions.state.result!.sessions.entries()) {
    row.createdAt = 100_000 - index;
    row.label = index < rootCount ? `Task ${index}` : `Child ${index - rootCount}`;
    if (index < rootCount) {
      row.category = `Group ${index % 4}`;
      if (index % 4 === 0) {
        row.childSessions = [children[index / 4]!];
      }
    } else {
      row.spawnedBy = keys[(index - rootCount) * 4];
    }
  }
  const gateway = createGatewayHarness({} as GatewayBrowserClient);
  const mounted = await mountSidebar(gateway.gateway, harness.sessions);
  const sidebar = mounted.sidebar;
  if (!(sidebar instanceof AppSidebarSessionNavigationElement)) {
    throw new Error("Expected the registered sidebar element");
  }
  sidebar.sidebarLiveActivity = false;
  await sidebar.updateComplete;
  const trigger = sidebar.querySelector<HTMLButtonElement>(".sidebar-nav__head-action");
  if (!trigger) {
    throw new Error("Expected the interactive Pages menu trigger");
  }
  return { ...mounted, sidebar, trigger, harness, gateway };
}

function percentile(values: number[], fraction: number): number {
  return values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? 0;
}

it("keeps session invalidation when a list update is batched with a menu click", async () => {
  const { sidebar, trigger, harness } = await mountProjectionFixture(20);
  const project = vi.spyOn(sidebar.sessionProjection, "project");
  const result = harness.sessions.state.result!;
  trigger.click();
  harness.publish({
    result: {
      ...result,
      sessions: result.sessions.map((row, index) =>
        index === 0 ? { ...row, label: "Updated task" } : row,
      ),
    },
  });
  // An event handler before Lit renders must not read the retained old projection.
  expect(sidebar.findSidebarSessionByKey("agent:main:task-0")?.label).toBe("Updated task");
  await sidebar.updateComplete;
  expect(sidebar.querySelector('[data-session-key="agent:main:task-0"]')?.textContent).toContain(
    "Updated task",
  );
  expect(project).toHaveBeenCalledTimes(1);
  project.mockRestore();
});

it("preserves the full freshness path for unclassified controller updates", async () => {
  const { sidebar, harness } = await mountProjectionFixture(20);
  const project = vi.spyOn(sidebar.sessionProjection, "project");
  harness.sessions.state.result!.sessions[0]!.label = "Controller update";
  sidebar.requestUpdate();
  await sidebar.updateComplete;
  expect(sidebar.querySelector('[data-session-key="agent:main:task-0"]')?.textContent).toContain(
    "Controller update",
  );
  expect(project).toHaveBeenCalledTimes(1);
  project.mockRestore();
});

it.each([20, 100, 200])(
  "does not project %i roots again when opening and closing Pages",
  async (rootCount) => {
    const { sidebar, trigger } = await mountProjectionFixture(rootCount);
    // Load and settle real menu code before timing. Every click awaits its Lit update.
    for (let index = 0; index < 6; index += 1) {
      trigger.click();
      await sidebar.updateComplete;
    }
    const originalProject = sidebar.sessionProjection.project.bind(sidebar.sessionProjection);
    const originalTree = agentSessionRows.projectSidebarAgentSessionRows;
    const treeDurations: number[] = [];
    const tree = vi
      .spyOn(agentSessionRows, "projectSidebarAgentSessionRows")
      .mockImplementation((input) => {
        const start = performance.now();
        const rows = originalTree(input);
        treeDurations.push(performance.now() - start);
        return rows;
      });
    const projectionDurations: number[] = [];
    const project = vi.spyOn(sidebar.sessionProjection, "project").mockImplementation((input) => {
      const start = performance.now();
      const result = originalProject(input);
      projectionDurations.push(performance.now() - start);
      return result;
    });
    const observe = vi.spyOn(sidebar.sessionProjection, "observeRows");
    const navigation = vi.spyOn(
      AppSidebarSessionNavigationElement.prototype,
      "getSessionNavigationState",
    );
    let renders = 0;
    sidebar.addController({
      hostUpdated: () => {
        renders += 1;
      },
    });
    const elapsed: number[] = [];
    const cpuBefore = process.cpuUsage();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let index = 0; index < 40; index += 1) {
      const start = performance.now();
      trigger.click();
      await sidebar.updateComplete;
      elapsed.push(performance.now() - start);
      expect(sidebar.querySelector(".sidebar-more-menu") !== null).toBe(index % 2 === 0);
    }
    const cpu = process.cpuUsage(cpuBefore);
    console.log(
      "SIDEBAR_PROJECTION_BENCHMARK",
      JSON.stringify({
        roots: rootCount,
        children: rootCount / 4,
        iterations: elapsed.length,
        renders,
        projections: project.mock.calls.length,
        treeProjections: tree.mock.calls.length,
        observations: observe.mock.calls.length,
        navigations: navigation.mock.calls.length,
        updateMedianMs: percentile(elapsed, 0.5),
        updateP95Ms: percentile(elapsed, 0.95),
        projectionMedianMs: percentile(projectionDurations, 0.5),
        projectionP95Ms: percentile(projectionDurations, 0.95),
        treeMedianMs: percentile(treeDurations, 0.5),
        treeP95Ms: percentile(treeDurations, 0.95),
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        netHeapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
      }),
    );
    try {
      expect(renders).toBe(40);
      expect(project).not.toHaveBeenCalled();
      expect(tree).not.toHaveBeenCalled();
      expect(observe).not.toHaveBeenCalled();
    } finally {
      project.mockRestore();
      tree.mockRestore();
      observe.mockRestore();
      navigation.mockRestore();
    }
  },
);
