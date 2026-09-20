import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  takeControlUiViewportScreenshot,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI plugin channel runtime status",
  startServerBeforeBrowser: true,
});
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("shows active plugin accounts in the hub while preserving explicit channel status", async () => {
    const proofDir = captureUiProof
      ? createControlUiE2eArtifactDir("channels-plugin-runtime-status")
      : undefined;
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        assistantName: "Main agent",
        methodResponses: {
          "channels.status": {
            ts: 1,
            channelOrder: ["guildchat", "relaychat", "pausedchat"],
            channelLabels: {
              guildchat: "Guild Chat",
              relaychat: "Relay Chat",
              pausedchat: "Paused Chat",
            },
            channels: {
              guildchat: { configured: true },
              relaychat: { configured: true },
              pausedchat: { configured: true, running: false, connected: false },
            },
            channelAccounts: {
              guildchat: [
                {
                  accountId: "default",
                  name: "Default account",
                  configured: true,
                  running: false,
                },
                {
                  accountId: "workspace",
                  name: "Workspace account",
                  configured: true,
                  running: true,
                },
              ],
              relaychat: [{ accountId: "default", configured: true, connected: true }],
              pausedchat: [
                { accountId: "default", configured: true, running: true, connected: true },
              ],
            },
            channelDefaultAccountId: {
              guildchat: "default",
              relaychat: "default",
              pausedchat: "default",
            },
          },
          "channels.pairing.list": {
            accounts: [],
            requests: [],
            commandOwnerConfigured: true,
            limits: { pendingPerAccount: 3, ttlMs: 3_600_000 },
          },
        },
      });

      expect((await page.goto(`${suite.server.baseUrl}settings/channels`))?.status()).toBe(200);
      await waitForControlUiGatewayReady(page);
      await gateway.waitForRequest("channels.status");
      const guild = page.locator("button.channels-item", { hasText: "Guild Chat" });
      const relay = page.locator("button.channels-item", { hasText: "Relay Chat" });
      const paused = page.locator("button.channels-item", { hasText: "Paused Chat" });
      await Promise.all([guild.waitFor(), relay.waitFor(), paused.waitFor()]);
      await expect
        .poll(async () => (await paused.locator(".settings-status").textContent())?.trim())
        .toBe("Configured");
      if (proofDir) {
        await writeFile(
          path.join(proofDir, "hub.png"),
          await takeControlUiViewportScreenshot(page, guild, [guild, relay, paused]),
        );
      }

      await guild.click();
      const detail = page.locator(".channels-detail");
      const workspaceAccount = detail.locator(".settings-row", { hasText: "Workspace account" });
      const defaultAccount = detail.locator(".settings-row", { hasText: "Default account" });
      await expect
        .poll(async () =>
          (await workspaceAccount.locator(".settings-status").textContent())?.trim(),
        )
        .toBe("Running");
      await expect
        .poll(async () => (await defaultAccount.locator(".settings-status").textContent())?.trim())
        .toBe("Configured");
      if (proofDir) {
        await waitForControlUiProofSurface(
          page.locator("openclaw-modal-dialog").filter({ has: detail }).locator("dialog"),
          [workspaceAccount, defaultAccount],
        );
        await writeFile(
          path.join(proofDir, "account-details.png"),
          await takeControlUiViewportScreenshot(page, detail, [workspaceAccount, defaultAccount]),
        );
      }
      await detail.getByRole("button", { name: "Close", exact: true }).click();
      await detail.waitFor({ state: "detached" });

      await expect
        .poll(async () => (await guild.locator(".settings-status").textContent())?.trim())
        .toBe("Running");
      await expect
        .poll(async () => (await relay.locator(".settings-status").textContent())?.trim())
        .toBe("Running");
      expect((await paused.locator(".settings-status").textContent())?.trim()).toBe("Configured");
    });
  });
});
