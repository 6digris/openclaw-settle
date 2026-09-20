import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("sends only an explicitly selected everyone mention and preserves its transcript label", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "users.mentionable"],
          presenceUsers: [
            {
              self: true,
              id: "sender",
              identity: { type: "profile", id: "sender" },
              name: "Sender",
            },
          ],
          methodResponses: {
            "users.mentionable": { users: [], truncated: false, everyone: { recipientCount: 12 } },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`, { waitUntil: "domcontentloaded" });
        const input = page.locator(".agent-chat__composer-combobox textarea");
        await input.fill("@every");
        const option = page.getByRole("option", { name: /@everyone/ });
        await option.waitFor();
        expect(await option.textContent()).toContain("Notify everyone with access (12)");
        await input.press("Enter");
        expect(await input.inputValue()).toBe("@everyone ");
        expect(await page.locator(".composer-context-strip").textContent()).toContain(
          "Everyone with access",
        );
        await input.pressSequentially("Please review the release checklist.");
        await input.press("Enter");
        const request = await gateway.waitForRequest("chat.send");
        expect(request.params.message).toBe("@everyone Please review the release checklist.");
        expect(request.params.mentions).toEqual([{ kind: "everyone", start: 0, end: 9 }]);
        await expect.poll(() => page.locator(".human-mention-everyone").count()).toBe(1);
        expect(await page.locator(".human-mention-everyone").textContent()).toBe("@everyone");
        expect(await page.locator("openclaw-person-reference").count()).toBe(0);
      },
    );
  });
});
