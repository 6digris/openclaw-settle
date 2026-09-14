import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { HOME_PANEL_TOGGLE_EVENT } from "../components/panel-toggle-contract.ts";
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

const suite = createControlUiE2eSuite({ name: "Chat startup request priority" });
const sessionKey = "agent:research:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const historyText = "Authoritative selected conversation.";
const bulkMethods = ["sessions.list", "sessions.catalog.list"];

async function installStartupGateway(page: Page) {
  const config = { tools: { swarm: { enabled: true } } };
  return installMockGateway(page, {
    defaultAgentId: "main",
    assistantAgentId: "main",
    mainSessionKey: "agent:main:main",
    sessionKey,
    sessions: [{ key: sessionKey, kind: "direct", label: "Selected conversation", updatedAt: 1 }],
    historyMessages: [{ role: "assistant", content: historyText }],
    deferredMethods: ["chat.startup"],
    heldMethods: bulkMethods,
    featureMethods: [
      ...defaultControlUiFeatureMethods,
      "chat.history",
      "chat.send",
      "sessions.catalog.list",
    ],
    methodResponses: {
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Main" },
          { id: "research", name: "Research" },
        ],
      },
      "sessions.catalog.list": { catalogs: [] },
      "config.get": {
        raw: JSON.stringify(config),
        hash: "synthetic-swarm-enabled",
        config,
        sourceConfig: config,
        runtimeConfig: config,
      },
    },
  });
}

type Gateway = Awaited<ReturnType<typeof installStartupGateway>>;

async function openPendingChat(page: Page, gateway: Gateway, presentedShell = false) {
  const pathname = new URL("chat/research/selected-conversation-12345678", suite.server.baseUrl)
    .pathname;
  if (presentedShell) {
    await page.goto(`${suite.server.baseUrl}new`);
    for (const method of bulkMethods) {
      await gateway.waitForRequest(method, { match: { agentId: "main" } });
      await gateway.resolveDeferred(
        method,
        method === "sessions.list"
          ? {
              ts: 1,
              path: "",
              count: 0,
              defaults: { model: null, modelProvider: null, contextTokens: null },
              sessions: [],
            }
          : undefined,
      );
      await gateway.deferNext(method, { agentId: "research" });
    }
    await page.locator(".new-session-page__message").waitFor();
    await page.evaluate((targetPath) => {
      const app = document.querySelector("openclaw-app") as HTMLElement & {
        runtime: { context: { navigate: (route: string, options: { pathname: string }) => void } };
      };
      app.runtime.context.navigate("chat", { pathname: targetPath });
    }, pathname);
  } else {
    await page.goto(new URL(pathname, suite.server.baseUrl).href);
  }
  const resolution = await gateway.waitForRequest("sessions.resolve");
  expect(resolution.params).toMatchObject({ agentId: "research", shortId: "12345678" });
  const startup = await gateway.waitForRequest("chat.startup");
  expect(startup.params).toMatchObject({ sessionKey });
  const subscription = await gateway.waitForRequest("sessions.subscribe");
  expect(subscription.params).toEqual({});
  await page
    .locator(
      presentedShell
        ? ".chat-pane-cache__pane--active .chat-thread .lazy-view-state--loading"
        : ".startup-chat-skeleton",
    )
    .waitFor();
}

async function expectBulkReadsHeld(gateway: Gateway, agentId?: string) {
  // Cover the event refresh debounce as well as immediate mount requests.
  const deadline = Date.now() + 500;
  do {
    for (const method of bulkMethods) {
      expect(
        await gateway.getRequests(method, agentId ? { agentId } : undefined),
        `${method} before chat startup settled`,
      ).toEqual([]);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  } while (Date.now() < deadline);
}

async function expectBulkReadsReleased(gateway: Gateway) {
  for (const method of bulkMethods) {
    await gateway.waitForRequest(method, { match: { agentId: "research" } });
    await gateway.resolveDeferred(method);
  }
}

async function readStartupShimmer(page: Page) {
  return page.evaluate(() => {
    const shell = document.querySelector(".shell")!;
    const masks = [
      ...shell.querySelectorAll(
        ".startup-chat-skeleton .startup-transcript-lines > .skeleton-line:first-child, .startup-chat-skeleton .user .chat-bubble, .assistant-panel-title",
      ),
    ];
    return {
      stage: shell.getAttribute("data-startup-stage"),
      clockPhase: Number.parseFloat(
        getComputedStyle(document.querySelector("openclaw-app")!).getPropertyValue(
          "--startup-shimmer",
        ),
      ),
      shellPhase: getComputedStyle(shell).getPropertyValue("--startup-shimmer").trim(),
      transcriptPhases: [...shell.querySelectorAll("openclaw-chat-pane .chat-thread")].map(
        (element) => getComputedStyle(element).getPropertyValue("--startup-shimmer").trim(),
      ),
      // Read the painted gradient, not the synchronizer's internal bookkeeping.
      maskPositions: masks.map((element) =>
        Number.parseFloat(getComputedStyle(element, "::after").backgroundPositionX),
      ),
    };
  });
}

async function expectAlignedStartupMasks(page: Page) {
  // A style read can precede the first animation frame of a newly mounted region.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  let sample = await readStartupShimmer(page);
  // Endpoints can hide drift between nested animations. Compare mid-pulse.
  await expect
    .poll(async () => {
      sample = await readStartupShimmer(page);
      return Math.abs(sample.clockPhase) < 60;
    })
    .toBe(true);
  expect(sample.maskPositions.length).toBeGreaterThan(1);
  for (const position of sample.maskPositions) {
    expect(Number.isFinite(position)).toBe(true);
    expect(Math.abs(position - sample.maskPositions[0]!)).toBeLessThan(0.1);
  }
}

async function expectStartupShimmerRetired(page: Page) {
  await page.locator(".shell[data-startup-stage='ready']").waitFor();
  await page.locator(".startup-chat-skeleton").waitFor({ state: "detached" });
  await page.locator(".startup-sidebar-skeleton").waitFor({ state: "detached" });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation instanceof CSSAnimation && animation.animationName === "startup-shimmer",
            ).length,
      ),
    )
    .toBe(0);
}

suite.define(() => {
  it("loads selected history before automatic rosters, including event refreshes, and keeps live messages", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installStartupGateway(page);
      try {
        await openPendingChat(page, gateway);
        await expectBulkReadsHeld(gateway);
        await gateway.emitGatewayEvent("sessions.changed", {
          agentId: "research",
          sessionKey,
          reason: "patch",
        });
        await gateway.emitGatewayEvent("presence", {
          presence: [{ instanceId: "synthetic-worker", mode: "node", host: "fixture", ts: 1 }],
        });
        await expectBulkReadsHeld(gateway);
        expect(await gateway.getRequests("sessions.list", { spawnedBy: sessionKey })).toEqual([]);
        expect(await gateway.getRequests("talk.catalog")).toEqual([]);

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "01-selected-chat-pending.png"),
          });
        }

        await gateway.resolveDeferred("chat.startup");
        // RPC admission follows history; initial presentation also waits for the roster.
        await page.locator(".startup-chat-skeleton").waitFor();
        expect(await gateway.getRequests("talk.catalog")).toEqual([]);
        await expectBulkReadsReleased(gateway);
        const transcript = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await transcript.getByText(historyText, { exact: true }).waitFor();
        await gateway.waitForRequest("talk.catalog");
        const composer = page.locator(
          ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
        );
        const draft = "Synthetic draft after coordinated startup.";
        await expect.poll(() => composer.isEnabled()).toBe(true);
        await composer.fill(draft);
        await gateway.waitForRequest("sessions.messages.subscribe", { match: { key: sessionKey } });
        // A live history refresh must preserve the presented transcript and draft.
        await gateway.deferNext("chat.history");
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          messageId: "synthetic-live-answer",
          messageSeq: 2,
          session: { key: sessionKey, kind: "direct", updatedAt: 2 },
          message: {
            role: "user",
            content: [{ type: "text", text: "Live peer message after startup." }],
            __openclaw: { id: "synthetic-live-answer", seq: 2 },
          },
        });
        await transcript.getByText("Live peer message after startup.", { exact: true }).waitFor();
        expect(await composer.inputValue()).toBe(draft);
        expect(await composer.isEditable()).toBe(true);
        await composer.fill(`${draft} Still editable.`);
        expect(await composer.inputValue()).toBe(`${draft} Still editable.`);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "02-selected-chat-completed.png"),
          });
        }
        await gateway.waitForRequest("sessions.list", { match: { spawnedBy: sessionKey } });
      } finally {
        await writeFile(
          path.join(suite.artifactDir, "selected-chat-startup-requests.json"),
          JSON.stringify(await gateway.getRequests(), null, 2),
        );
      }
    });
  });

  it("lets an explicit sidebar filter load while the selected transcript is still pending", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installStartupGateway(page);
      await openPendingChat(page, gateway, true);
      await expectBulkReadsHeld(gateway, "research");
      await gateway.setSessionsListResponse({
        ts: 2,
        path: "",
        count: 1,
        defaults: { model: null, modelProvider: null, contextTokens: null },
        sessions: [
          {
            key: "agent:research:archived-fixture",
            kind: "direct",
            label: "Archived fixture",
            updatedAt: 2,
            archived: true,
          },
        ],
      });
      await page.getByRole("button", { name: "Filter & sort" }).click();
      await page
        .locator(".sidebar-session-sort-menu")
        .getByRole("menuitemradio", { name: "Archived", exact: true })
        .click();
      await gateway.waitForRequest("sessions.list", {
        match: { agentId: "research", archived: true },
      });
      await gateway.resolveDeferred("sessions.list");
      await page
        .locator("openclaw-app-sidebar")
        .getByText("Archived fixture", { exact: true })
        .waitFor();
      expect(await gateway.getRequests("sessions.catalog.list", { agentId: "research" })).toEqual(
        [],
      );
      expect(await gateway.getRequests("sessions.list", { spawnedBy: sessionKey })).toEqual([]);
      expect(await page.getByText(historyText, { exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
      await page
        .locator(".chat-pane-cache__pane--active .chat-thread .lazy-view-state--loading")
        .waitFor();
      await gateway.resolveDeferred("chat.startup");
      await page.locator(".chat-thread").getByText(historyText, { exact: true }).waitFor();
    });
  });

  it.each(["failed startup", "New Session navigation"] as const)(
    "releases background reads after %s retires the pending chat",
    async (outcome) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installStartupGateway(page);
        const presentedShell = outcome === "New Session navigation";
        await openPendingChat(page, gateway, presentedShell);
        await expectBulkReadsHeld(gateway, presentedShell ? "research" : undefined);
        if (outcome === "failed startup") {
          await gateway.rejectDeferred("chat.startup", {
            code: "GATEWAY_UNAVAILABLE",
            message: "Synthetic history unavailable.",
          });
        } else {
          await page.locator("openclaw-app-sidebar .sidebar-brand__new-thread").click();
          await page.waitForURL((url) => url.pathname === "/new");
          await page.locator("openclaw-new-session-page").waitFor();
        }
        await expectBulkReadsReleased(gateway);
        if (outcome === "failed startup") {
          await page.getByRole("alert").getByText("Synthetic history unavailable.").waitFor();
        }
        if (outcome === "New Session navigation") {
          await gateway.resolveDeferred("chat.startup");
          expect(new URL(page.url()).pathname).toBe("/new");
          expect(await page.getByText(historyText, { exact: true }).isVisible()).toBe(false);
        }
      });
    },
  );
  it.each([false, true])(
    "isolates the live transcript while delayed Home joins the startup phase (split=%s)",
    async (split) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        if (split) {
          await page.addInitScript(
            ({ key, selected }) => {
              localStorage.setItem(
                key,
                JSON.stringify({
                  sessionKey: selected,
                  chatSplitLayout: {
                    activePaneId: "p1",
                    columns: [
                      { id: "c1", panes: [{ id: "p1", sessionKey: selected }], paneWeights: [1] },
                      { id: "c2", panes: [{ id: "p2", sessionKey: selected }], paneWeights: [1] },
                    ],
                    columnWeights: [0.5, 0.5],
                  },
                }),
              );
            },
            { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), selected: sessionKey },
          );
        }
        const gateway = await installStartupGateway(page);
        await openPendingChat(page, gateway);
        await page.locator(".shell[data-startup-placeholder='true']").waitFor();
        const placeholders = page.locator(".startup-chat-skeleton openclaw-startup-chat-pane");
        await expect.poll(() => placeholders.count()).toBe(split ? 2 : 1);
        await page
          .locator("openclaw-router-outlet openclaw-chat-pane .chat-thread")
          .first()
          .waitFor({ state: "attached" });
        await expectAlignedStartupMasks(page);
        const first = await readStartupShimmer(page);
        expect(first.transcriptPhases.length).toBeGreaterThan(0);
        expect(first.transcriptPhases.every((phase) => phase === "-100%")).toBe(true);
        // Observe actual motion while the Gateway keeps startup pending.
        await expect
          .poll(async () => {
            const current = await readStartupShimmer(page);
            return Math.abs(current.maskPositions[0]! - first.maskPositions[0]!);
          })
          .toBeGreaterThan(1);

        // Hold the real Home import to cover its ordinary loading bar as well as its header mask.
        // Components such as the model trigger override the ordinary skeleton duration.
        await page.addStyleTag({
          content: "openclaw-assistant-panel .skeleton { --skeleton-duration: 1.45s; }",
        });
        const homeModule = await holdModuleResponse(
          page,
          /\/home-session\.runtime(?:-[^/?]+)?\.(?:ts|js)(?:\?|$)/u,
        );
        try {
          await page.evaluate((eventName) => {
            window.dispatchEvent(new CustomEvent(eventName, { detail: { open: true } }));
          }, HOME_PANEL_TOGGLE_EVENT);
          await homeModule.request;
          await page.locator("openclaw-assistant-panel .assistant-panel-header").waitFor();
          await expectAlignedStartupMasks(page);
          const loadingBar = page.locator("openclaw-assistant-panel .lazy-view-state .skeleton");
          await loadingBar.waitFor();
          const readLoadingBar = () =>
            loadingBar.evaluate((element) => {
              const style = getComputedStyle(element, "::after");
              const shift = new DOMMatrixReadOnly(style.transform).m41;
              const mainMask = document.querySelector(
                ".startup-chat-skeleton .startup-transcript-lines > .skeleton-line",
              )!;
              return {
                position: (100 * shift) / element.getBoundingClientRect().width,
                mainPosition:
                  Number.parseFloat(getComputedStyle(mainMask, "::after").backgroundPositionX) -
                  100,
              };
            });
          let barSample = await readLoadingBar();
          await expect
            .poll(async () => {
              barSample = await readLoadingBar();
              return Math.abs(barSample.mainPosition) < 60;
            })
            .toBe(true);
          expect(Math.abs(barSample.position - barSample.mainPosition)).toBeLessThan(0.1);
          const firstBar = await readLoadingBar();
          await expect
            .poll(async () => Math.abs((await readLoadingBar()).position - firstBar.position))
            .toBeGreaterThan(1);
        } finally {
          homeModule.release();
        }
        await expectAlignedStartupMasks(page);
        const withHome = await readStartupShimmer(page);
        expect(withHome.stage).toBe("pending");
        expect(withHome.transcriptPhases.every((phase) => phase === "-100%")).toBe(true);
        await expect
          .poll(async () => {
            const current = await readStartupShimmer(page);
            return Math.abs(current.maskPositions[0]! - withHome.maskPositions[0]!);
          })
          .toBeGreaterThan(1);
        await expectAlignedStartupMasks(page);

        const composer = page.locator(
          "openclaw-assistant-panel .agent-chat__composer-combobox textarea",
        );
        await expect.poll(() => composer.isEditable()).toBe(true);
        const draft = "Keep this Home draft through the coordinated reveal.";
        await composer.fill(draft);
        expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
        await gateway.resolveDeferred("chat.startup");
        await expectBulkReadsReleased(gateway);
        await expectStartupShimmerRetired(page);
        expect(await composer.inputValue()).toBe(draft);
        expect(await composer.evaluate((element) => document.activeElement === element)).toBe(true);
        await composer.press("End");
        await composer.press("!");
        expect(await composer.inputValue()).toBe(`${draft}!`);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
      });
    },
  );

  it("removes all startup pulses for reduced motion and still releases the placeholders", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "no-preference" });
      const gateway = await installStartupGateway(page);
      await openPendingChat(page, gateway);
      await expectAlignedStartupMasks(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document
                .getAnimations()
                .filter(
                  (animation) =>
                    animation instanceof CSSAnimation &&
                    animation.animationName === "startup-shimmer",
                ).length,
          ),
        )
        .toBe(0);
      const reduced = await readStartupShimmer(page);
      expect(reduced.maskPositions.every((position) => position === 0)).toBe(true);
      expect(reduced.shellPhase).toBe("-100%");

      // New CSS players must rejoin the shared phase when motion is enabled again.
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await expectAlignedStartupMasks(page);
      await expect
        .poll(async () => (await readStartupShimmer(page)).maskPositions[0])
        .toBeGreaterThan(1);
      await expectAlignedStartupMasks(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await gateway.resolveDeferred("chat.startup");
      await expectBulkReadsReleased(gateway);
      await expectStartupShimmerRetired(page);
      expect(
        await page
          .locator(".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea")
          .isEditable(),
      ).toBe(true);
    });
  });
});
