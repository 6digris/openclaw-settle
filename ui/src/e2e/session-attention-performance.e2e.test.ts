import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Session attention update proof",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
});

suite.define(() => {
  it("updates row attention previews when requests arrive, change and resolve", async () => {
    const context = await suite.newBrowserContext({
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    const page = await context.newPage();
    const key = "agent:main:release-check";
    const gateway = await installMockGateway(page, {
      featureMethods: ["question.list", "question.get", "question.resolve"],
      methodResponses: {
        "question.list": { questions: [] },
        "sessions.list": {
          ts: 1,
          path: "",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [{ key, kind: "direct", label: "Release checks", updatedAt: 1 }],
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const row = page.locator(`[data-session-tree="${key}"]`).first();
    await row.waitFor();
    const capture = async (name: string) => {
      await page.screenshot({
        path: path.join(suite.artifactDir, `${name}.png`),
        animations: "disabled",
      });
    };
    await capture("00-quiet");
    const now = Date.now();
    const request = (command: string) => ({
      id: "proof-approval",
      createdAtMs: now,
      expiresAtMs: now + 300_000,
      request: { command, sessionKey: key, agentId: "main" },
    });
    await gateway.emitGatewayEvent(
      "exec.approval.requested",
      request("pnpm test --filter release"),
    );
    const indicator = row.locator("[data-session-attention]");
    await expect.poll(() => indicator.count()).toBe(1);
    await indicator.hover();
    await expect.poll(() => tooltipTitleText(row)).toContain("pnpm test --filter release");
    await page
      .locator("openclaw-tooltip[open] .sidebar-session-attention-tooltip__preview")
      .filter({ hasText: "pnpm test --filter release" })
      .waitFor({ state: "visible" });
    await capture("01-approval");
    await gateway.emitGatewayEvent(
      "exec.approval.requested",
      request("pnpm test --filter updated-release"),
    );
    await expect.poll(() => tooltipTitleText(row)).toContain("updated-release");
    await page
      .locator("openclaw-tooltip[open] .sidebar-session-attention-tooltip__preview")
      .filter({ hasText: "updated-release" })
      .waitFor({ state: "visible" });
    await capture("02-updated-approval");
    await gateway.emitGatewayEvent("exec.approval.resolved", {
      id: "proof-approval",
      decision: "deny",
    });
    await expect.poll(() => indicator.count()).toBe(0);
    await capture("03-resolved");
  });
});
