import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import { html, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import "../../../styles.css";
import "../../../styles/chat/startup-layout.css";
import "../../../styles/chat/split-view.css";
import { mockWorkspaceIconFetch, mountChatPaneHeader } from "./chat-pane-header.test-support.ts";
import { renderChatPaneHeader } from "./chat-pane-header.ts";

const containers: HTMLElement[] = [];
const originalTheme = document.documentElement.dataset.theme;
afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  document.documentElement.classList.remove("openclaw-native-macos", "openclaw-native-web-chrome");
  if (originalTheme === undefined) {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = originalTheme;
  }
  vi.restoreAllMocks();
});

describe.skipIf(typeof HTMLElement.prototype.checkVisibility !== "function")(
  "chat header trail",
  () => {
    for (const theme of ["light", "dark"]) {
      for (const width of [1440, 390]) {
        it.each([
          { levels: 3, icon: "loaded" },
          ...(width === 1440 ? [{ levels: 3, icon: "native" }] : []),
          { levels: 3, icon: "missing" },
          { levels: 3, icon: "broken" },
          { levels: 2, icon: "loaded" },
          { levels: 2, icon: "missing" },
          { levels: 1, icon: "missing" },
        ])(
          `preserves $levels levels with a $icon icon at ${width}px in ${theme}`,
          async ({ levels, icon }) => {
            const { page, userEvent } = await import("vitest/browser");
            await page.viewport(width, 800);
            await i18n.setLocale("en");
            document.documentElement.dataset.theme = theme;
            if (icon === "native") {
              document.documentElement.classList.add(
                "openclaw-native-macos",
                "openclaw-native-web-chrome",
              );
            }
            const hasImage = icon === "loaded" || icon === "native";
            const fetchIcon = mockWorkspaceIconFetch().mockResolvedValue(
              icon === "missing"
                ? new Response(null, { status: 404 })
                : new Response(
                    icon === "broken"
                      ? "invalid image"
                      : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7" fill="red"/></svg>',
                    { headers: { "content-type": "image/svg+xml" } },
                  ),
            );
            const { container, props } = mountChatPaneHeader(containers, {
              mergedChrome: true,
              narrow: width === 390,
              workspaceLabel: levels === 1 ? null : "harbor-project",
              workspaceRoot: levels === 1 ? null : "/repo/harbor-project",
              workspaceIcon:
                levels === 1
                  ? null
                  : {
                      routeUrl: `/__openclaw__/workspace-icon/${theme}-${width}-${levels}-${icon}`,
                      authTokens: ["test-token"],
                      authReady: true,
                    },
              parentSession:
                levels === 3 ? { key: "agent:main:parent", title: "Parent session" } : null,
            });
            container.className = "sidebar-region__header";
            container.style.cssText = "container-type: inline-size; width: 100%";
            if (levels > 1) {
              await expect.poll(() => fetchIcon.mock.calls.length).toBe(1);
              if (hasImage) {
                await expect
                  .poll(
                    () =>
                      container.querySelector<HTMLImageElement>(".workspace-icon")?.naturalWidth,
                  )
                  .toBe(16);
              } else {
                await expect
                  .poll(() => container.querySelector(".workspace-icon-fallback") !== null)
                  .toBe(true);
              }
            }
            const compact = width === 1440 && levels === 3 && hasImage;
            const label = container.querySelector<HTMLElement>(".chat-pane__workspace-chip > span");
            expect(label?.checkVisibility() ?? false).toBe(levels > 1 && !compact);
            const separators = [
              ...container.querySelectorAll<HTMLElement>(".chat-pane__crumb-sep"),
            ].filter((element) => element.checkVisibility());
            expect(separators).toHaveLength(compact ? 1 : width === 390 ? 0 : levels - 1);
            const title = container.querySelector<HTMLButtonElement>(
              ".chat-pane__session-title-button",
            )!;
            expect(title.checkVisibility()).toBe(true);
            if (width === 390 && levels > 1) {
              expect(label!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
                title.getBoundingClientRect().top,
              );
            }
            if (levels > 1) {
              const chip = container.querySelector<HTMLButtonElement>(
                ".chat-pane__workspace-chip",
              )!;
              expect(chip.getAttribute("aria-label")).toBe("Workspace actions for harbor-project");
              expect(chip.title).toBe("/repo/harbor-project");
              chip.focus();
              await userEvent.keyboard("{Enter}");
              await page.getByRole("menuitem", { name: "Copy path" }).click();
              expect(props.onMenuAction).toHaveBeenCalledWith("copy-path");
            }
            if (levels === 3) {
              const parent = container.querySelector<HTMLButtonElement>(
                ".chat-pane__parent-session",
              )!;
              parent.focus();
              await userEvent.keyboard("{Enter}");
              expect(props.onOpenParentSession).toHaveBeenCalledExactlyOnceWith(
                "agent:main:parent",
              );
              if (compact) {
                const image = container.querySelector<HTMLImageElement>(".workspace-icon")!;
                expect(
                  Math.abs(
                    image.getBoundingClientRect().top +
                      image.height / 2 -
                      (parent.getBoundingClientRect().top +
                        parent.getBoundingClientRect().height / 2),
                  ),
                ).toBeLessThan(1);
                render(
                  html`${renderChatPaneHeader({ ...props, copiedAction: "copy-path" })}`,
                  container,
                );
                await expect
                  .poll(() =>
                    container
                      .querySelector<HTMLElement>(".chat-pane__workspace-chip > span")
                      ?.checkVisibility(),
                  )
                  .toBe(true);
                expect(
                  container.querySelector(".chat-pane__workspace-chip > span")?.textContent,
                ).toBe("Copied");
              }
            }
            container.querySelector<HTMLButtonElement>(".chat-pane__session-title-button")!.focus();
            await userEvent.keyboard("{Enter}");
            expect(props.onBeginRename).toHaveBeenCalledOnce();
          },
        );
      }
    }
  },
);
