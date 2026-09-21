import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it.each([390, 1440])(
    "sends only an explicitly selected everyone mention at %ipx and preserves its transcript label",
    async (width) => {
      await suite.withPage(
        { viewport: { width, height: 900 }, colorScheme: width === 390 ? "light" : "dark" },
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
              "users.mentionable": {
                users: [],
                truncated: false,
                everyone: { recipientCount: 12 },
              },
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
          const params = requireRecord(request.params);
          expect(params.message).toBe("@everyone Please review the release checklist.");
          expect(params.mentions).toEqual([{ kind: "everyone", start: 0, end: 9 }]);
          await page.locator(".human-mention-everyone").waitFor({ state: "visible" });
          expect(await page.locator(".human-mention-everyone").count()).toBe(1);
          expect(await page.locator(".human-mention-everyone").textContent()).toBe("@everyone");
          expect(await page.locator("openclaw-person-reference").count()).toBe(0);
        },
      );
    },
  );
});
