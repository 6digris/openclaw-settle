import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

function historyTurn(start: number, count: number, title: string) {
  const messages: Record<string, unknown>[] = [];
  const append = (message: Record<string, unknown>) => {
    const seq = start + messages.length;
    messages.push({
      ...message,
      __openclaw: { id: `home-${seq}`, seq },
      timestamp: 1_800_000_000_000 + seq,
      runId: `run-${start}`,
    });
  };
  append({ role: "user", content: `Please review ${title}.` });
  for (let index = 0; index < (count - 2) / 2; index++) {
    const id = `read-${start}-${index}`;
    append({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: "example.txt" } }],
    });
    append({
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: "Synthetic document content." }],
    });
  }
  append({
    role: "assistant",
    phase: "final_answer",
    content: `${title}\n\n${"The review is complete. This paragraph records a synthetic finding for history navigation.\n\n".repeat(3)}`,
  });
  return messages;
}

suite.define(() => {
  it.each([
    { width: 1440, height: 900, input: "Home" },
    { width: 390, height: 844, input: "Home" },
    { width: 390, height: 844, input: "wheel" },
    { width: 390, height: 844, input: "pending Home" },
  ])(
    "keeps the reader above the end after staged history ($width, $input)",
    async ({ input, ...viewport }) => {
      await suite.withPage({ viewport }, async ({ page }) => {
        const sessionKey = "agent:main:main";
        const sessionId = "home-history-session";
        const recent = [
          ...historyTurn(2732, 36, "Recent review one"),
          ...historyTurn(2768, 36, "Recent review two"),
        ];
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [{ key: sessionKey, sessionId }],
          methodResponses: {
            "chat.startup": {
              messages: recent,
              hasMore: true,
              nextOffset: 72,
              totalMessages: 2803,
              sessionId,
            },
            "chat.history": {
              cases: [
                {
                  match: { offset: 72 },
                  response: {
                    messages: [
                      ...historyTurn(1732, 500, "Earlier review one"),
                      ...historyTurn(2232, 500, "Earlier review two"),
                    ],
                    hasMore: true,
                    nextOffset: 1072,
                    totalMessages: 2803,
                    sessionId,
                  },
                },
                {
                  match: { offset: 1072 },
                  response: {
                    messages: [
                      ...historyTurn(732, 500, "Old review one"),
                      ...historyTurn(1232, 500, "Old review two"),
                    ],
                    hasMore: true,
                    nextOffset: 2072,
                    totalMessages: 2803,
                    sessionId,
                  },
                },
                {
                  match: { offset: 2072 },
                  response: {
                    messages: [
                      ...historyTurn(1, 730, "First review"),
                      {
                        role: "assistant",
                        content: "Earlier summary.",
                        __openclaw: { id: "home-731", seq: 731 },
                        timestamp: 1_800_000_000_731,
                      },
                    ],
                    hasMore: false,
                    totalMessages: 2803,
                    sessionId,
                  },
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const pane = page.locator(".chat-pane-cache__pane--active");
        const thread = pane.locator(".chat-thread");
        await thread.getByText("Recent review two", { exact: true }).waitFor();
        await waitForChatScrollIdle(page);
        const loadedCount = () =>
          pane.evaluate(
            (element) =>
              (element as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages
                .length,
          );
        if (input === "pending Home") {
          await gateway.deferNext("chat.history", { offset: 1072 });
        }
        // Desktop bootstraps its short first page; mobile needs an upward gesture.
        await thread.focus();
        if (viewport.width === 390) {
          await page.keyboard.press("Home");
        }
        await expect.poll(loadedCount).toBeGreaterThanOrEqual(1072);
        if (input === "pending Home") {
          await expect
            .poll(async () => (await gateway.getRequests("chat.history", { offset: 1072 })).length)
            .toBe(1);
        } else {
          await page.waitForFunction(() =>
            Boolean(
              (
                document.querySelector(".chat-pane-cache__pane--active") as HTMLElement & {
                  stagedOlderPage: unknown;
                }
              ).stagedOlderPage,
            ),
          );
        }
        await page.keyboard.press("End");
        await waitForChatScrollIdle(page);
        const distance = () =>
          thread.evaluate(
            (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
          );
        expect(await distance()).toBeLessThanOrEqual(1);
        const before = await loadedCount();
        expect([1072, 2072]).toContain(before);
        if (input === "wheel") {
          await thread.hover();
          await page.mouse.wheel(0, -420);
        } else if (input === "pending Home") {
          await Promise.all([page.keyboard.press("Home"), gateway.resolveDeferred("chat.history")]);
        } else {
          await page.keyboard.press("Home");
        }
        await expect.poll(loadedCount).toBe(before === 1072 ? 2072 : 2803);
        await waitForChatScrollIdle(page);
        expect(
          await distance(),
          "older history must not return the reader to the newest end",
        ).toBeGreaterThan(8);
        expect(await thread.evaluate((element) => document.activeElement === element)).toBe(true);

        await page.keyboard.press("End");
        await waitForChatScrollIdle(page);
        expect(await distance()).toBeLessThanOrEqual(1);
        await page.keyboard.press("ArrowUp");
        await waitForChatScrollIdle(page);
        expect(await distance()).toBeGreaterThan(8);
        await pane.getByRole("button", { name: "Scroll to latest" }).click();
        await waitForChatScrollIdle(page);
        expect(await distance()).toBeLessThanOrEqual(1);
      });
    },
  );
});
