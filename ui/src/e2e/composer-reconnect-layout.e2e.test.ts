import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Composer connection recovery layout" });
const recoveryNotice = "Finishing connection recovery. Try sending again when it is ready.";
type RecoveryWindow = Window & { releaseComposerRecovery?: () => void };
type RecoveryApp = HTMLElement & { runtime: { context: ApplicationContext } };

suite.define(() => {
  it.each([
    { width: 1440, readingHistory: false },
    { width: 390, readingHistory: false },
    { width: 1440, readingHistory: true },
    { width: 390, readingHistory: true },
  ])(
    "keeps the reading area stable during recovery at $width (history: $readingHistory)",
    async ({ width, readingHistory }) => {
      await suite.withPage({ viewport: { width, height: 907 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey: "agent:main:main",
          historyMessages: Array.from({ length: 72 }, (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content: [
              {
                type: "text",
                text: `Conversation message ${index + 1}. Keep the reading area stable while the connection recovers.`,
              },
            ],
            __openclaw: { id: `reconnect-layout-${index}`, seq: index + 1 },
          })),
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
        const textarea = page.locator("openclaw-chat-pane .agent-chat__composer-combobox textarea");
        await textarea.waitFor();
        await page.waitForFunction(
          () =>
            (document.querySelector("openclaw-app") as RecoveryApp).runtime.context.gateway.snapshot
              .client?.recoveryScopeReady,
        );
        await page.locator(".startup-chat-skeleton").waitFor({ state: "detached" });
        await textarea.fill("Preserve this unsent draft.");
        const thread = page.locator("openclaw-chat-pane .chat-thread");
        if (readingHistory) {
          await thread.hover();
          await page.mouse.wheel(0, -400);
          await expect
            .poll(() =>
              thread.evaluate(
                (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
              ),
            )
            .toBeGreaterThan(200);
        }
        const geometry = () =>
          page.evaluate(() => {
            const pane = document.querySelector("openclaw-chat-pane")!;
            const rect = (selector: string) => {
              const {
                x,
                y,
                width: rectWidth,
                height,
              } = pane.querySelector(selector)!.getBoundingClientRect();
              return { x, y, width: rectWidth, height };
            };
            return {
              composer: rect(".agent-chat__composer-shell"),
              input: rect(".agent-chat__input"),
              transcript: rect(".chat-thread"),
            };
          });
        const before = await geometry();
        const originalTextarea = await textarea.elementHandle();
        // Hold the native recovery digest, not application state, so the real
        // handshake, admission guard, and registered composer render all run.
        await page.evaluate(() => {
          const digest = crypto.subtle.digest.bind(crypto.subtle);
          crypto.subtle.digest = async (algorithm, data) => {
            const result = await digest(algorithm, data);
            if (new TextDecoder().decode(data) === "e2e-device-token") {
              await new Promise<void>((resolve) => {
                (window as RecoveryWindow).releaseComposerRecovery = () => {
                  crypto.subtle.digest = digest;
                  resolve();
                };
              });
            }
            return result;
          };
        });
        await gateway.closeLatest(1001, "same-account connection recovery");
        const notice = page.getByText(recoveryNotice, { exact: true });
        await notice.waitFor();
        await expect.poll(() => textarea.isDisabled()).toBe(true);
        expect(await textarea.inputValue()).toBe("Preserve this unsent draft.");
        expect(await originalTextarea!.evaluate((element) => element.isConnected)).toBe(true);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        const pending = await geometry();
        console.info(JSON.stringify({ width, readingHistory, before, pending }));
        expect(pending).toEqual(before);
        const description = await textarea.getAttribute("aria-describedby");
        const statusId = await notice.locator("..").getAttribute("id");
        expect(statusId).toBeTruthy();
        expect(description?.split(" ")).toContain(statusId);
        await page.evaluate(() => (window as RecoveryWindow).releaseComposerRecovery!());
        await notice.waitFor({ state: "detached" });
        await expect.poll(() => textarea.isEnabled()).toBe(true);
        expect(await geometry()).toEqual(before);
        expect(await textarea.inputValue()).toBe("Preserve this unsent draft.");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      });
    },
  );
});
