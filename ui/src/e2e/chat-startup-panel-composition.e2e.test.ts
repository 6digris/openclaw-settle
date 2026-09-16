import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat startup panel composition" });
const sessionKey = "agent:main:panel-composition";
const historyText = "The conversation is ready before its saved panels.";

suite.define(() => {
  it.each([false, true])(
    "reveals mounted saved Files and terminal frames with Files promoted=%s",
    async (promoted) => {
      await suite.withPage(
        { ...createControlUiE2eContextOptions(), viewport: { width: 1600, height: 1000 } },
        async ({ page }) => {
          await page.addInitScript(
            ({ key, sessionKey: savedSessionKey, promoted: filesPromoted }) => {
              localStorage.setItem(
                key,
                JSON.stringify({
                  sessionKey: savedSessionKey,
                  sidebarSessionLayouts: {
                    [savedSessionKey]: {
                      columns: [
                        {
                          id: "saved-files",
                          side: "right",
                          panels: [{ id: "workspace", slot: "workspace" }],
                          activePanelId: "workspace",
                          width: 360,
                          height: 360,
                        },
                      ],
                      mainPanelId: filesPromoted ? "workspace" : undefined,
                      dock: "right",
                      open: true,
                      expanded: false,
                    },
                  },
                }),
              );
              sessionStorage.setItem(
                "openclaw.terminal.sessions.v1",
                JSON.stringify(["composition-terminal"]),
              );
              localStorage.setItem(
                "openclaw.terminal.panel.v1",
                JSON.stringify({ open: true, dock: "bottom", height: 240, width: 480 }),
              );
            },
            { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), sessionKey, promoted },
          );
          const gateway = await installMockGateway(page, {
            sessionKey,
            historyMessages: [{ role: "assistant", content: historyText }],
            deferredMethods: ["chat.startup", "terminal.attach"],
            terminalEnabled: true,
            workspace: "/workspace/project",
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "terminal.open",
              "terminal.attach",
              "terminal.list",
              "sessions.files.list",
            ],
            methodResponses: {
              "terminal.list": {
                sessions: [
                  {
                    sessionId: "composition-terminal",
                    agentId: "main",
                    shell: "/bin/bash",
                    cwd: "/workspace/project",
                    confined: false,
                    attached: false,
                    createdAtMs: 1,
                  },
                ],
              },
              "terminal.attach": {
                agentId: "main",
                confined: false,
                cwd: "/workspace/project",
                sessionId: "composition-terminal",
                shell: "/bin/bash",
                buffer: "Existing terminal session\r\n$ ",
                seq: "Existing terminal session\r\n$ ".length,
              },
              "sessions.files.list": {
                root: "/workspace/project",
                sessionKey,
                files: [],
                browser: { path: "", entries: [] },
              },
            },
          });
          const regionModule = await holdModuleResponse(
            page,
            /\/chat-sidebar-region\.runtime(?:-[^/?]+)?\.(?:ts|js)(?:\?|$)/u,
          );
          const terminalModule = await holdModuleResponse(
            page,
            /\/terminal-panel-registration(?:-[^/?]+)?\.(?:ts|js)(?:\?|$)/u,
          );
          try {
            await page.goto(
              `${suite.server.baseUrl}chat?session=${encodeURIComponent(sessionKey)}`,
            );
            await gateway.waitForRequest("chat.startup");
            await Promise.all([regionModule.request, terminalModule.request]);
            const pane = page.locator("openclaw-chat-page openclaw-chat-pane").first();
            const composer = pane.locator(".agent-chat__composer-combobox textarea");
            if (!promoted) {
              await expect.poll(() => composer.isEditable()).toBe(true);
              await composer.fill("Keep this draft through the reveal.");
            }
            await gateway.resolveDeferred("chat.startup");
            const message = pane.getByText(historyText, { exact: true });
            if (!promoted) {
              await message.waitFor({ state: "attached" });
            }
            const messagePainted = () =>
              message.evaluate((element) => {
                for (let node: Element | null = element; node; node = node.parentElement) {
                  const style = getComputedStyle(node);
                  if (
                    style.visibility === "hidden" ||
                    style.display === "none" ||
                    Number(style.opacity) === 0
                  ) {
                    return false;
                  }
                }
                return element.getBoundingClientRect().height > 0;
              });
            if (!promoted) {
              expect(await messagePainted()).toBe(false);
            }
            await expect
              .poll(() =>
                page
                  .locator(".startup-chat-skeleton")
                  .evaluate((element) => Number(getComputedStyle(element).opacity)),
              )
              .toBe(1);
            expect(
              await page.locator(".startup-chat-skeleton .startup-transcript-skeleton").count(),
            ).toBe(1);
            const optionalShapesPainted = () =>
              page
                .locator(
                  "openclaw-panel-loading-skeleton .skeleton, .startup-chat-skeleton .side-panel__panel .skeleton",
                )
                .evaluateAll((elements) =>
                  elements.some((element) =>
                    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
                  ),
                );
            expect(await optionalShapesPainted()).toBe(false);
            const geometry = () =>
              pane.evaluate((element) => {
                const box = (selector: string) => {
                  const node = element.querySelector(selector)!;
                  const { x, y, width, height } = node.getBoundingClientRect();
                  return { x, y, width, height };
                };
                return {
                  primary: box(".sidebar-region__primary"),
                  frame: box(".sidebar-region"),
                };
              });
            const reserved = await geometry();
            expect(reserved.frame.width - reserved.primary.width).toBeGreaterThanOrEqual(360);
            const reservationDiagnostic = await page.evaluate(() => {
              const content = document.querySelector<HTMLElement>(".content")!;
              const { x, y, width, height } = content.getBoundingClientRect();
              const appShell = document.querySelector("openclaw-app-shell") as
                | (HTMLElement & {
                    context?: { config?: { current?: { terminalEnabled?: boolean } } };
                  })
                | null;
              return {
                reserveBottom: getComputedStyle(document.documentElement).getPropertyValue(
                  "--oc-terminal-reserve-bottom",
                ),
                contentMarginBottom: getComputedStyle(content).marginBottom,
                contentRect: { x, y, width, height },
                stage: document.querySelector<HTMLElement>(".shell")?.dataset.startupStage,
                terminalDefined: Boolean(customElements.get("openclaw-terminal-panel")),
                storedLayout: localStorage.getItem("openclaw.terminal.panel.v1"),
                terminalEnabled: appShell?.context?.config?.current?.terminalEnabled,
              };
            });
            expect(reserved.frame.height, JSON.stringify(reservationDiagnostic)).toBe(1000 - 240);

            terminalModule.release();
            await page
              .locator(".shell > openclaw-terminal-panel .tp-header")
              .waitFor({ state: "attached" });
            expect(
              await page
                .locator(".shell > openclaw-terminal-panel .tp-header")
                .evaluate((element) =>
                  element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
                ),
            ).toBe(false);
            await gateway.waitForRequest("terminal.attach");
            const terminalStatus = page.locator(
              '.shell > openclaw-terminal-panel openclaw-panel-loading-skeleton[data-panel-skeleton="terminal"]',
            );
            await terminalStatus.waitFor({ state: "attached" });
            expect(await terminalStatus.locator(".skeleton").count()).toBeGreaterThan(0);
            expect(await optionalShapesPainted()).toBe(false);
            if (!promoted) {
              expect(await messagePainted()).toBe(false);
            }
            regionModule.release();
            await pane.locator('[data-panel-slot="workspace"]:not([hidden])').waitFor();
            if (!promoted) {
              await expect.poll(messagePainted).toBe(true);
            }
            await page.locator(".startup-chat-skeleton").waitFor({ state: "detached" });
            // Terminal service readiness is independent of the mounted layout.
            // Its real loading component stays in status mode after chat reveals.
            await terminalStatus.locator(".status").waitFor();
            expect(await terminalStatus.locator(".status").textContent()).toMatch(/\S/u);
            expect(await optionalShapesPainted()).toBe(false);
            const revealed = await geometry();
            for (const key of promoted ? (["frame"] as const) : (["primary", "frame"] as const)) {
              for (const axis of ["x", "y", "width", "height"] as const) {
                expect(
                  Math.abs(revealed[key][axis] - reserved[key][axis]),
                  `${key}.${axis}`,
                ).toBeLessThanOrEqual(1);
              }
            }
            if (!promoted) {
              expect(await composer.inputValue()).toBe("Keep this draft through the reveal.");
              expect(await composer.evaluate((element) => document.activeElement === element)).toBe(
                true,
              );
              await composer.press("End");
              await composer.press("!");
              expect(await composer.inputValue()).toBe("Keep this draft through the reveal.!");
            }
            expect(await gateway.getRequests("chat.send")).toEqual([]);
            await gateway.resolveDeferred("terminal.attach");
            await terminalStatus.waitFor({ state: "detached" });
            expect(await gateway.getRequests("terminal.open")).toEqual([]);
          } finally {
            regionModule.release();
            terminalModule.release();
          }
        },
      );
    },
  );
});
