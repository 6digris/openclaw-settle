import { writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  chatSessionListResponse,
  controlUiSessionPath,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("drains an inactive agent outbox while the selected global agent is active", async () => {
    const startedAt = performance.now();
    // Preserve the last awaited stage even when Vitest's outer timeout skips failure capture.
    const phase = (name: string) => {
      writeSync(
        2,
        `[control-ui-e2e] outbox ${name} +${Math.round(performance.now() - startedAt)}ms\n`,
      );
    };
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("chat-outbox-agent-scope", artifactRoot)
      : undefined;
    phase("create browser context");
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    phase("create page");
    const page = await context.newPage();
    const activePane = page.locator(".chat-pane-cache__pane--active");
    const agentsList = {
      agents: [
        { id: "main", name: "Main" },
        { id: "work", name: "Work" },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "global",
    };
    const historyResponse = (agentId: "main" | "work", active: boolean) => ({
      messages: [],
      sessionId: `${agentId}-global-session`,
      sessionInfo: {
        activeRunIds: active ? [`${agentId}-active-run`] : [],
        hasActiveRun: active,
        key: "global",
        status: active ? "running" : "done",
      },
      thinkingLevel: null,
    });
    const sessionsResponse = (active: boolean) =>
      chatSessionListResponse([
        {
          activeRunIds: active ? ["main-active-run"] : [],
          hasActiveRun: active,
          key: "global",
          kind: "global",
          label: "Main Session",
          status: active ? "running" : "done",
          updatedAt: Date.now(),
        },
      ]);
    phase("install mock Gateway");
    const gateway = await installMockGateway(page, {
      sessionScope: "global",
      mainSessionKey: "global",
      methodResponses: {
        "agents.list": agentsList,
        "chat.history": {
          cases: [
            {
              match: { agentId: "work", sessionKey: "global" },
              response: historyResponse("work", true),
            },
            {
              match: { agentId: "main", sessionKey: "global" },
              response: historyResponse("main", true),
            },
          ],
        },
        "chat.startup": {
          cases: [
            {
              match: { agentId: "work" },
              response: { ...historyResponse("work", false), agentsList },
            },
            {
              match: { agentId: "main" },
              response: { ...historyResponse("main", true), agentsList },
            },
          ],
        },
        "sessions.list": {
          cases: [
            { match: { agentId: "work" }, response: sessionsResponse(false) },
            { match: { agentId: "main" }, response: sessionsResponse(true) },
          ],
        },
      },
    });

    try {
      phase("navigate to work chat");
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:work:main"));
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      phase("wait for work composer");
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      phase("take Gateway offline");
      await gateway.setOnline(false);
      phase("wait for offline status");
      await page
        .locator(
          '.agent-chat__composer-underlaps[data-tone="warn"] .agent-chat__composer-status-band',
        )
        .waitFor({ timeout: 10_000 });

      const prompt = "deliver the work outbox independently";
      phase("fill queued prompt");
      await composer.fill(prompt);
      phase("submit queued prompt");
      await page.getByRole("button", { name: "Send message" }).click();
      const queue = page.locator(".chat-queue");
      phase("wait for reconnect queue");
      await queue.getByText("Waiting for reconnect").waitFor({ timeout: 10_000 });
      if (artifactDir) {
        phase("capture offline queue");
        await writeFile(
          `${artifactDir}/inactive-agent-offline.png`,
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [queue]),
        );
      }
      phase("navigate to main chat");
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      phase("select main agent");
      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context: { agentSelection: { set: (agentId: string) => void } } };
        };
        app.runtime?.context.agentSelection.set("main");
      });
      phase("reconnect Gateway");
      await gateway.setOnline(true);
      phase("wait for offline status to clear");
      await page
        .locator(
          '.agent-chat__composer-underlaps[data-tone="warn"] .agent-chat__composer-status-band',
        )
        .waitFor({ state: "detached", timeout: 10_000 });
      phase("refresh main sessions");
      await page.evaluate(async () => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context: { sessions: { refresh: (options: unknown) => Promise<void> } } };
        };
        await app.runtime?.context.sessions.refresh({ agentId: "main", force: true });
      });

      phase("verify main sessions request");
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (entry) => requireRecord(entry.params).agentId === "main",
          ),
        )
        .toBe(true);
      phase("verify history request");
      await expect
        .poll(async () => (await gateway.getRequests("chat.history")).length)
        .toBeGreaterThan(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      phase("defer outbox send");
      await gateway.deferNext("chat.send");
      phase("make work history inactive");
      await gateway.setMethodResponse("chat.history", {
        cases: [
          {
            match: { agentId: "work", sessionKey: "global" },
            response: historyResponse("work", false),
          },
          {
            match: { agentId: "main", sessionKey: "global" },
            response: historyResponse("main", true),
          },
        ],
      });
      phase("publish inactive work session");
      await gateway.emitGatewayEvent("sessions.changed", {
        activeRunIds: [],
        agentId: "work",
        hasActiveRun: false,
        key: "global",
        kind: "global",
        status: "done",
      });

      phase("wait for outbox send");
      const request = await gateway.waitForRequest("chat.send");
      const params = requireRecord(request.params);
      expect(params).toMatchObject({ agentId: "work", message: prompt, sessionKey: "global" });
      const runId = requireString(params.idempotencyKey, "inactive-agent outbox run id");
      phase("verify single outbox send");
      await expectRequestCountStable(gateway, "chat.send", 1);
      const recoveryRequests = (await gateway.getRequests("chat.history"))
        .map((entry) => requireRecord(entry.params))
        .filter((historyParams) => Array.isArray(historyParams.inputRunIds));
      expect(recoveryRequests.length).toBeGreaterThan(0);
      for (const historyParams of recoveryRequests) {
        expect(historyParams).toMatchObject({
          agentId: "work",
          sessionKey: "global",
          inputRunIds: [runId],
        });
      }
      const workPath = controlUiSessionPath("agent:work:main");
      phase("return to work chat");
      await page.evaluate((pathname) => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              agentSelection: { set: (agentId: string) => void };
              navigate: (routeId: string, options: { pathname: string }) => void;
            };
          };
        };
        if (!app.runtime) {
          throw new Error("OpenClaw application runtime is unavailable");
        }
        app.runtime.context.agentSelection.set("work");
        app.runtime.context.navigate("chat", { pathname });
      }, workPath);
      phase("wait for work route");
      await page.waitForURL((url) => url.pathname === workPath);
      phase("publish work history");
      await gateway.setHistoryMessages([
        {
          content: prompt,
          idempotencyKey: `${runId}:user`,
          role: "user",
          timestamp: Date.now(),
        },
      ]);
      phase("publish work user message");
      await gateway.emitGatewayEvent("session.message", {
        agentId: "work",
        clientRunId: runId,
        hasActiveRun: true,
        message: {
          __openclaw: { id: "work-outbox-user", idempotencyKey: `${runId}:user`, seq: 1 },
          content: [{ text: prompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        messageId: "work-outbox-user",
        messageSeq: 1,
        sessionKey: "global",
        status: "running",
      });
      phase("wait for work user message");
      await activePane.locator(".chat-group.user").getByText(prompt).waitFor({ timeout: 10_000 });
      phase("acknowledge outbox send");
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      if (artifactDir) {
        phase("capture dispatched outbox");
        await writeFile(
          `${artifactDir}/inactive-agent-dispatched.png`,
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            activePane.locator(".chat-group.user").getByText(prompt),
          ]),
        );
      }

      phase("publish final work reply");
      await gateway.emitGatewayEvent("chat", {
        agentId: "work",
        message: {
          content: [{ text: "Work outbox delivered.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "global",
        state: "final",
      });
      phase("wait for queue removal");
      await queue.waitFor({ state: "detached", timeout: 10_000 });
      // Retained panes also receive this conversation's events; assert its rendered owner.
      const reply = activePane
        .locator(".chat-group.assistant")
        .getByText("Work outbox delivered.", { exact: true });
      phase("wait for assistant reply");
      await reply.waitFor({ timeout: 10_000 });
      phase("verify no duplicate send");
      await expectRequestCountStable(gateway, "chat.send", 1);
      expect(await activePane.count()).toBe(1);
      expect(await reply.count()).toBe(1);
      phase("read final transcript");
      const messages = await activePane.evaluate(
        (pane) => (pane as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages,
      );
      expect(messages.map(requireRecord).filter((message) => message.role === "assistant")).toEqual(
        [
          expect.objectContaining({
            content: [{ text: "Work outbox delivered.", type: "text" }],
          }),
        ],
      );
      if (artifactDir) {
        phase("capture delivered reply");
        await writeFile(
          `${artifactDir}/inactive-agent-delivered.png`,
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [reply]),
        );
      }
    } finally {
      phase("close browser context");
      await suite.closeBrowserContext(context);
      phase("browser context closed");
    }
    phase("complete");
  });
});
