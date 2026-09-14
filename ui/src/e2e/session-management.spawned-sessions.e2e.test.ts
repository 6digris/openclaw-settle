import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  requireRecord,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it("organizes persistent spawned sessions independently without moving their subagent siblings", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const parentKey = "agent:main:dashboard:planning";
    const childKey = "agent:main:dashboard:follow-up";
    const runKey = "agent:main:subagent:review";
    const now = Date.now();
    const parent = sessionRow(parentKey, "Plan the release", now, {
      category: "Planning",
      childSessions: [childKey, runKey],
    });
    const child = sessionRow(childKey, "Preserve file line endings", now - 1_000, {
      parentSessionKey: parentKey,
      spawnedBy: parentKey,
    });
    const run = sessionRow(runKey, "Review the release changes", now - 2_000, {
      parentSessionKey: parentKey,
      spawnedBy: parentKey,
      status: "running",
      hasActiveRun: true,
    });
    const gateway = await installMockGateway(page, {
      featureMethods: [
        ...defaultControlUiFeatureMethods,
        "sessions.groups.list",
        "sessions.groups.put",
      ],
      sessionGroups: ["Planning", "Engineering"],
      sessionKey: parentKey,
      methodResponses: {
        "sessions.list": {
          cases: [
            { match: { spawnedBy: parentKey }, response: sessionsListResponse([child, run]) },
            {
              match: {},
              response: sessionsListResponse([
                parent,
                sessionRow("agent:main:notes", "Release notes", now - 3_000),
              ]),
            },
          ],
        },
        "sessions.patch": {},
      },
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
      const toggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
      await toggle.waitFor({ state: "visible" });
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click();
      }
      const childRow = page.locator(`[data-session-key="${childKey}"]`);
      const runRow = page.locator(`[data-session-key="${runKey}"]`);
      await runRow.waitFor({ state: "visible" });
      await childRow.waitFor({ state: "visible" });
      await captureUiProof(suite, page, "spawned-sessions-initial.png");
      expect(await childRow.getAttribute("draggable")).toBe("true");
      expect(await runRow.getAttribute("draggable")).toBe("false");
      expect(await runRow.getByRole("button", { name: "Pin session", exact: true }).count()).toBe(
        0,
      );
      expect(
        await page
          .locator(`[data-session-tree="${parentKey}"] [data-session-key="${childKey}"]`)
          .count(),
      ).toBe(0);

      const engineering = page.locator('[data-session-section="category:Engineering"]');
      await childRow.dragTo(engineering.locator(":scope > .sidebar-recent-sessions__head"));
      await waitForPatch(
        gateway,
        (params) => params.key === childKey && params.category === "Engineering",
      );
      await engineering.locator(`[data-session-key="${childKey}"]`).waitFor({ state: "visible" });
      await captureUiProof(suite, page, "spawned-sessions-moved.png");

      const threads = page.locator('[data-session-section="ungrouped"]');
      await childRow.dragTo(threads.locator(":scope > .sidebar-recent-sessions__head"));
      await waitForPatch(gateway, (params) => params.key === childKey && params.category === null);
      await threads.locator(`[data-session-key="${childKey}"]`).waitFor({ state: "visible" });
      expect(
        await page
          .locator(`[data-session-tree="${parentKey}"] [data-session-key="${childKey}"]`)
          .count(),
      ).toBe(0);

      await childRow.hover();
      await childRow.getByRole("button", { name: "Pin session", exact: true }).click();
      await waitForPatch(gateway, (params) => params.key === childKey && params.pinned === true);
      await page
        .locator(`[data-sidebar-entry="session:${childKey}"]`)
        .waitFor({ state: "visible" });
      expect(await childRow.count()).toBe(1);
      expect(
        await page
          .locator(`[data-session-tree="${parentKey}"] [data-session-key="${runKey}"]`)
          .count(),
      ).toBe(1);
      const patches = (await gateway.getRequests("sessions.patch")).map((request) =>
        requireRecord(request.params),
      );
      for (const patch of patches) {
        expect(patch).not.toHaveProperty("parentSessionKey");
        expect(patch).not.toHaveProperty("spawnedBy");
        expect(patch).not.toHaveProperty("completionOwnerSessionKey");
      }
      await captureUiProof(suite, page, "spawned-sessions-pinned.png");
      await childRow.locator(".sidebar-recent-session__link").click();
      const sourceLink = page.getByRole("button", {
        name: "Open parent session Plan the release",
        exact: true,
      });
      await sourceLink.waitFor({ state: "visible" });
      await sourceLink.click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(new URL(controlUiSessionUrl(suite.server.baseUrl, parentKey)).pathname);
    } finally {
      await context.close();
    }
  });
});
