import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";
import { waitForGatewayRecoveryScope } from "./new-session-page.test-support.ts";

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
          expect(request.params.message).toBe("@everyone Please review the release checklist.");
          expect(request.params.mentions).toEqual([{ kind: "everyone", start: 0, end: 9 }]);
          await expect.poll(() => page.locator(".human-mention-everyone").count()).toBe(1);
          expect(await page.locator(".human-mention-everyone").textContent()).toBe("@everyone");
          expect(await page.locator("openclaw-person-reference").count()).toBe(0);
        },
      );
    },
  );

  it.each(["chat", "new"])(
    "keeps everyone intentional while searching people in %s",
    async (route) => {
      await suite.withPage(
        { viewport: { width: 390, height: 844 }, colorScheme: "light" },
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
                users: [{ profileId: "peter", displayName: "Peter Steinberger", online: false }],
                truncated: false,
                everyone: { recipientCount: 12 },
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}${route}`, { waitUntil: "domcontentloaded" });
          await waitForGatewayRecoveryScope(page);
          const input = page.locator(
            route === "new"
              ? ".new-session-page__message"
              : ".agent-chat__composer-combobox textarea",
          );
          const menu = page.getByRole("listbox", { name: "Mention a person" });
          const everyone = menu.getByRole("option", { name: /@everyone/ });
          await input.fill("@");
          await everyone.waitFor();
          await input.press("Escape");
          await input.fill("@Other @");
          await menu.getByRole("option", { name: /Peter Steinberger/ }).waitFor();
          expect(await everyone.count()).toBe(0);
          for (const query of ["ev", "yon"]) {
            await input.press("Escape");
            await input.fill(`@Other @${query}`);
            await everyone.waitFor();
            expect(await everyone.locator(".mention-everyone-icon").count()).toBe(1);
          }
          await input.press("Escape");
          await gateway.setMethodResponse("users.mentionable", {
            users: [{ profileId: "peter", displayName: "Peter Steinberger", online: false }],
            truncated: false,
          });
          await input.fill("@einb");
          await menu.getByRole("option", { name: /Peter Steinberger/ }).waitFor();
          expect(await everyone.count()).toBe(0);
          await input.press("Enter");
          expect(await input.inputValue()).toBe("@Peter Steinberger ");
          expect(await page.locator(".composer-context-strip").textContent()).not.toContain(
            "Everyone with access",
          );
        },
      );
    },
  );
});
