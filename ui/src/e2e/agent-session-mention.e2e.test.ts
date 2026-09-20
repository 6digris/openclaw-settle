import { expect as expectBrowser } from "playwright/test";
import { expect, it } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import {
  defaultControlUiFeatureMethods,
  reconnectMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI agent session mention Inbox" });
const homeKey = "agent:atlas:daily-planning";
const reviewKey = "agent:atlas:launch-review";
const sourceId = "launch-review-request";
const sourceText = "Morgan, please review the launch checklist before we continue.";
const homeText = "Your daily plan is ready. Keep working here while Atlas prepares the review.";
const gatewayInstanceId = "agent-mention-fixture-boot";
const reader = {
  type: "human" as const,
  id: "profile-morgan",
  label: "Morgan",
  identity: { type: "profile" as const, id: "profile-morgan" },
};

suite.define(() => {
  it("receives an agent mention in another session, opens its exact source, and reconciles dismissal", async () => {
    await suite.withPage(
      {
        viewport: { width: 1440, height: 900 },
        colorScheme: "dark",
        reducedMotion: "reduce",
        locale: "en-US",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const now = Date.now();
        const message = (id: string, seq: number, role: string, content: string) => ({
          role,
          content,
          timestamp: now - 120_000 + seq * 1_000,
          __openclaw: { id, seq },
        });
        const home = {
          key: homeKey,
          sessionId: "daily-planning-session",
          kind: "direct",
          label: "Daily planning",
          owner: { actor: reader },
          createdActor: reader,
          updatedAt: now - 60_000,
        };
        const review = {
          ...home,
          key: reviewKey,
          sessionId: "launch-review-session",
          label: "Launch checklist review",
          updatedAt: now - 30_000,
        };
        const mention: MentionInboxItem = {
          id: "atlas-review-mention",
          sender: { type: "agent", id: "atlas" },
          senderLabel: "Atlas",
          sessionKey: reviewKey,
          agentId: "atlas",
          sessionTitle: review.label,
          messageId: sourceId,
          createdAt: now,
          expiresAt: now + 7 * 24 * 60 * 60 * 1_000,
          excerpt: sourceText,
        };
        const snapshot = (revision: number, items: MentionInboxItem[]) => ({
          gatewayInstanceId,
          revision,
          items,
        });
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const gateway = await installMockGateway(page, {
          defaultAgentId: "atlas",
          assistantAgentId: "atlas",
          assistantName: "Atlas",
          agentModel: "fixture/example",
          models: [{ id: "example", name: "Example model", provider: "fixture" }],
          gatewayBootId: gatewayInstanceId,
          sessionKey: homeKey,
          sessions: [home, review],
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [
            { self: true, id: reader.id, identity: reader.identity, name: reader.label },
          ],
          featureMethods: [...defaultControlUiFeatureMethods, "mentions.list", "mentions.dismiss"],
          sessionTranscripts: {
            [homeKey]: { messages: [message("daily-plan", 1, "assistant", homeText)] },
            [reviewKey]: {
              // The source is deliberately outside the initial bottom viewport. Identical
              // later text also prevents a text-only assertion from accepting the wrong note.
              messages: [
                message("review-introduction", 1, "user", "Prepare the launch checklist."),
                message(sourceId, 2, "assistant", sourceText),
                ...Array.from({ length: 36 }, (_, index) =>
                  message(
                    "checklist-update-" + index,
                    index + 3,
                    index % 2 === 0 ? "user" : "assistant",
                    "Checklist update " +
                      (index + 1) +
                      ". " +
                      "The team is reviewing the schedule, documentation, and release notes.",
                  ),
                ),
                message("later-review-request", 39, "assistant", sourceText),
              ],
            },
          },
          methodResponses: {
            "sessions.list": {
              ...sessionsListResponse([home, review]),
              defaults: { contextTokens: null, model: null, modelProvider: null },
              owners: [reader],
            },
            "mentions.list": snapshot(0, []),
            "mentions.dismiss": snapshot(2, []),
            "models.authStatus": { providers: [], ts: now },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, homeKey));
        const pane = page.locator(".chat-pane-cache__pane--active");
        const sidebar = page.locator("openclaw-app-sidebar");
        const inbox = sidebar.locator(".sidebar-issues-button");
        const mentionRow = sidebar.locator('[data-mention-id="atlas-review-mention"]');
        const openMentions = async () => {
          if ((await inbox.getAttribute("aria-expanded")) !== "true") {
            await inbox.click();
          }
          await sidebar.getByRole("tab", { name: /^Mentions/ }).click();
        };
        await expectBrowser(pane.getByText(homeText, { exact: true })).toBeVisible();
        await gateway.waitForRequest("mentions.list");
        await openMentions();
        await expectBrowser(sidebar.getByText("No mentions yet", { exact: true })).toBeVisible();
        await expectBrowser(mentionRow).toHaveCount(0);
        await captureUiProof(suite, page, "01-before-agent-mention.png");
        await inbox.click();

        // Deliver the Gateway's unchanged invalidation, not a fabricated toast or
        // client-side item insertion. The real Inbox owner fetches its typed snapshot.
        const beforeMention = (await gateway.getRequests("mentions.list")).length;
        await gateway.setMethodResponse("mentions.list", snapshot(1, [mention]));
        await gateway.emitGatewayEvent("mentions.changed", { gatewayInstanceId, revision: 1 });
        await gateway.waitForRequest("mentions.list", { after: beforeMention });
        await expectBrowser(sidebar.locator(".sidebar-issues-button__count")).toHaveText("1");
        await expectBrowser(page).toHaveURL(controlUiSessionUrl(suite.server.baseUrl, homeKey));
        await expectBrowser(pane.getByText(homeText, { exact: true })).toBeVisible();
        await openMentions();
        await expectBrowser(mentionRow).toHaveCount(1);
        await expectBrowser(mentionRow).toHaveAttribute("aria-label", "Atlas mentioned you");
        await expectBrowser(mentionRow.locator(".sidebar-issues-panel__state")).toHaveText(
          review.label,
        );
        await expectBrowser(mentionRow.locator(".sidebar-mention-row__excerpt")).toHaveText(
          sourceText,
        );
        const avatar = mentionRow.locator(".identity-avatar--agent");
        await expectBrowser(avatar).toHaveAttribute("aria-label", "Atlas");
        await expectBrowser(avatar.locator("svg")).toBeVisible();
        await expectBrowser(mentionRow.locator("openclaw-viewer-avatar")).toHaveCount(0);
        await captureUiProof(suite, page, "02-after-agent-mention.png");

        const beforeReconnect = (await gateway.getRequests("mentions.list")).length;
        await reconnectMockGateway(page, gateway);
        await gateway.waitForRequest("mentions.list", { after: beforeReconnect });
        if ((await inbox.getAttribute("aria-expanded")) !== "true") {
          await inbox.click();
        }
        await expectBrowser(mentionRow).toHaveCount(1);
        await expectBrowser(sidebar.locator(".sidebar-issues-button__count")).toHaveText("1");
        await expectBrowser(pane.getByText(homeText, { exact: true })).toBeVisible();

        const open = mentionRow.getByRole("link", { name: "Open", exact: true });
        const expectedUrl = new URL(controlUiSessionUrl(suite.server.baseUrl, reviewKey));
        expectedUrl.searchParams.set("messageId", sourceId);
        await expectBrowser(open).toHaveAttribute(
          "href",
          expectedUrl.pathname + expectedUrl.search,
        );
        await open.click();
        const source = pane.locator('.chat-bubble[data-entry-id="' + sourceId + '"]');
        await expectBrowser(source).toHaveClass(/chat-bubble--reply-target/);
        await expectBrowser(source).toHaveText(sourceText);
        await expectBrowser(source).toBeInViewport({ ratio: 1 });
        await captureUiProof(suite, page, "03-opened-exact-source.png");
        await expectBrowser(page).toHaveURL(expectedUrl.toString());
        const startup = await gateway.waitForRequest("chat.startup", {
          match: { sessionKey: reviewKey },
        });
        expect(startup.params).toMatchObject({ sessionKey: reviewKey });
        await expectBrowser(pane.getByText(homeText, { exact: true })).toHaveCount(0);
        // A bottom-of-history opening can show the duplicate wording but cannot
        // satisfy the source ID, highlight, viewport, and non-bottom scroll together.
        const scroll = await pane.locator(".chat-thread").evaluate((element) => ({
          top: element.scrollTop,
          remaining: element.scrollHeight - element.clientHeight - element.scrollTop,
          viewport: element.clientHeight,
        }));
        expect(scroll.remaining).toBeGreaterThan(scroll.viewport);
        expect(await gateway.getRequests("mentions.dismiss")).toHaveLength(0);

        // Reopening an undismissed entry is a new navigation even at the same URL.
        await pane.getByRole("button", { name: "Scroll to latest", exact: true }).click();
        await expectBrowser(source).not.toBeInViewport();
        await openMentions();
        await mentionRow.getByRole("link", { name: "Open", exact: true }).click();
        await expectBrowser(source).toHaveClass(/chat-bubble--reply-target/);
        await expectBrowser(source).toBeInViewport({ ratio: 1 });
        await captureUiProof(suite, page, "04-reopened-exact-source.png");

        await openMentions();
        await expectBrowser(mentionRow).toHaveCount(1);
        await gateway.setMethodResponse("mentions.list", snapshot(2, []));
        await mentionRow.getByRole("button", { name: "Dismiss", exact: true }).click();
        expect((await gateway.waitForRequest("mentions.dismiss")).params).toEqual({
          ids: [mention.id],
        });
        await expectBrowser(mentionRow).toHaveCount(0);
        await expectBrowser(sidebar.getByText("No mentions yet", { exact: true })).toBeVisible();
        await expectBrowser(sidebar.locator(".sidebar-issues-button__count")).toHaveCount(0);
        await captureUiProof(suite, page, "05-dismissed-agent-mention.png");

        const beforeDismissedReconnect = (await gateway.getRequests("mentions.list")).length;
        await reconnectMockGateway(page, gateway);
        await gateway.waitForRequest("mentions.list", { after: beforeDismissedReconnect });
        await openMentions();
        await expectBrowser(mentionRow).toHaveCount(0);
        await expectBrowser(sidebar.getByText("No mentions yet", { exact: true })).toBeVisible();
        expect(await gateway.getRequests("mentions.dismiss")).toHaveLength(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(pageErrors).toEqual([]);
      },
    );
  });
});
