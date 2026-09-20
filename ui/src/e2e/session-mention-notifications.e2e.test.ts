import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const targetKey = "agent:main:design-review";
const keys = ["agent:main:gateway-cleanup", targetKey, "agent:main:release-prep"] as const;
const titles = ["Gateway cleanup", "Design review", "Release prep"];
const bootId = "mention-proof-boot";
const previous: MentionInboxItem = {
  id: "previous",
  senderProfileId: "profile-alex",
  senderLabel: "Alex",
  sessionKey: targetKey,
  agentId: "main",
  sessionTitle: "Earlier discussion",
  messageId: "earlier-message",
  createdAt: 1_000,
  expiresAt: 8_640_000_000_000,
  excerpt: "An earlier mention retained in your Inbox.",
};
const arrival: MentionInboxItem = {
  ...previous,
  id: "new-mention",
  sessionTitle: "Design review",
  messageId: "new-message",
  createdAt: 2_000,
  excerpt: "@Taylor can you check the spacing before we ship?",
};
const snapshot = (revision: number, items: MentionInboxItem[]) => ({
  gatewayInstanceId: bootId,
  revision,
  items,
});

async function openTab(page: Page, key: string, mobile = false) {
  const gateway = await installMockGateway(page, {
    sessionKey: key,
    gatewayBootId: bootId,
    presenceUsers: [
      {
        self: true,
        id: "profile-taylor",
        identity: { type: "profile", id: "profile-taylor" },
        name: "Taylor",
      },
    ],
    featureMethods: [...defaultControlUiFeatureMethods, "mentions.list", "mentions.dismiss"],
    historyMessages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "The workspace is ready for collaboration." }],
      },
    ],
    methodResponses: {
      "mentions.list": snapshot(1, [previous]),
      "sessions.list": sessionsListResponse(
        keys.map((sessionKey, i) => ({
          key: sessionKey,
          sessionId: sessionKey.split(":").at(-1),
          kind: "direct",
          label: titles[i],
          displayName: titles[i],
          updatedAt: Date.now() - 60_000,
        })),
      ),
    },
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
  await gateway.waitForRequest("mentions.list");
  // The visible Inbox proves that its initial snapshot has been accepted, not
  // merely requested, before the arrival event is sent through the real client.
  if (mobile) {
    await page
      .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
      .first()
      .click();
  }
  const inbox = page.getByRole("button", { name: /inbox items?$/i });
  await inbox.click();
  await expectBrowser(page.locator('[data-mention-id="previous"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expectBrowser(inbox).toHaveAttribute("aria-expanded", "false");
  if (mobile) {
    await page.keyboard.press("Escape");
    await expectBrowser(page.locator(".shell")).not.toHaveClass(/shell--nav-drawer-open/);
  }
  await expectBrowser(page.locator(".app-toast--notification")).toHaveCount(0);
  return gateway;
}

async function deliver(gateway: Awaited<ReturnType<typeof openTab>>, item = arrival, revision = 2) {
  await gateway.setMethodResponse("mentions.list", snapshot(revision, [item, previous]));
  await gateway.emitGatewayEvent("mentions.changed", { gatewayInstanceId: bootId, revision });
}

suite.define(() => {
  it("notifies only the other two tabs and keeps toast dismissal local", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
      async ({ page, context }) => {
        const pages = [page, await context.newPage(), await context.newPage()] as const;
        const gateways = [
          await openTab(pages[0], keys[0]),
          await openTab(pages[1], keys[1]),
          await openTab(pages[2], keys[2]),
        ] as const;
        await captureUiProof(suite, page, "01-before-mention.png");
        for (const gateway of gateways) await deliver(gateway);
        const toast = page.locator(".app-toast--notification");
        await expectBrowser(toast).toBeVisible();
        await toast.hover();
        await expectBrowser(pages[1].locator(".app-toast--notification")).toHaveCount(0);
        const other = pages[2].locator(".app-toast--notification");
        await expectBrowser(other).toBeVisible();
        await other.getByRole("button", { name: "View session" }).focus();
        await expectBrowser(toast).toContainText("mentioned you");
        await expectBrowser(toast).toContainText(arrival.excerpt!);
        await expectBrowser(toast.locator(".app-toast__dismiss svg")).toHaveCount(1);
        expect(await toast.locator(".app-toast__dismiss").innerText()).toBe("");
        const bounds = await toast.boundingBox();
        expect(bounds!.x).toBeGreaterThan(800);
        const message = await toast.locator(".app-toast__message").boundingBox();
        const action = await toast.getByRole("button", { name: "View session" }).boundingBox();
        expect(action!.y).toBeGreaterThanOrEqual(message!.y + message!.height);
        await captureUiProof(suite, page, "02-after-desktop-dark.png");
        await toast.getByRole("button", { name: "Dismiss", exact: true }).click();
        await expectBrowser(toast).toHaveCount(0);
        await expectBrowser(other).toBeVisible();
        await other.getByRole("button", { name: "View session" }).click();
        await expectBrowser(other).toHaveCount(0);
        await expectBrowser(pages[2]).toHaveURL(
          controlUiSessionUrl(suite.server.baseUrl, targetKey),
        );
        for (const gateway of gateways)
          expect(await gateway.getRequests("mentions.dismiss")).toHaveLength(0);
        await page.reload();
        await gateways[0].waitForRequest("mentions.list");
        await expectBrowser(page.locator(".app-toast--notification")).toHaveCount(0);
      },
    );
  });

  it.each([
    { name: "desktop-light", width: 1280, height: 900, theme: "light" as const },
    { name: "mobile-dark", width: 390, height: 844, theme: "dark" as const },
  ])(
    "keeps long notification content readable in $name",
    async ({ name, width, height, theme }) => {
      await suite.withPage(
        { viewport: { width, height }, colorScheme: theme },
        async ({ page }) => {
          const gateway = await openTab(page, keys[0], width < 768);
          const item = {
            ...arrival,
            senderLabel: "Alexandria Catherine Montgomery-Worthington",
            sessionTitle: "Release readiness — notification delivery and workspace collaboration",
            excerpt: "@Taylor can you check the spacing before we ship the new notifications?",
          };
          await deliver(gateway, item);
          const toast = page.locator(".app-toast--notification");
          await expectBrowser(toast).toBeVisible();
          await toast.getByRole("button", { name: "View session" }).focus();
          await expectBrowser(toast).toContainText("mentioned you");
          const layout = await toast.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const avatar = element.querySelector(".viewer-avatar")!.getBoundingClientRect();
            return {
              width: box.width,
              right: box.right,
              left: box.left,
              overflow: element.scrollWidth > element.clientWidth,
              avatar: avatar.width,
            };
          });
          expect(layout.overflow).toBe(false);
          expect(layout.left).toBeGreaterThanOrEqual(0);
          expect(layout.right).toBeLessThanOrEqual(width);
          expect(layout.avatar).toBe(14);
          await captureUiProof(suite, page, "03-after-" + name + ".png");
          // Routing into the mentioned session retires its active toast without a
          // server dismissal; this is a tab-local presentation decision.
          await toast.getByRole("button", { name: "View session" }).click();
          await expectBrowser(toast).toHaveCount(0);
          expect(await gateway.getRequests("mentions.dismiss")).toHaveLength(0);
        },
      );
    },
  );
});
