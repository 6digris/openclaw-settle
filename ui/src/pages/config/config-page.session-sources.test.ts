/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { settleLitElement, settleLitElements } from "../../test-helpers/lit-settle.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { ConfigPage } from "./config-page.ts";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("localStorage", createStorageMock());
});

afterEach(async () => {
  const pages = document.querySelectorAll<ConfigPage>("openclaw-config-page");
  document.body.replaceChildren();
  await settleLitElements(pages);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function plugins(...ids: string[]) {
  return { plugins: ids.map((id) => ({ id, installed: true })) };
}

function createClient() {
  const reads: ReturnType<typeof deferred<ReturnType<typeof plugins>>>[] = [];
  const request = vi.fn((method: string) => {
    if (method !== "plugins.list") {
      throw new Error(`Unexpected request: ${method}`);
    }
    const read = deferred<ReturnType<typeof plugins>>();
    reads.push(read);
    // Deliberately allow retired replies to arrive; the page must fence publication.
    return read.promise;
  });
  return { client: { request } as unknown as GatewayBrowserClient, reads, request };
}

async function mount() {
  const connection = createClient();
  const source = createApplicationGateway({
    client: connection.client,
    phase: "connected",
    hello: gatewayHelloForMethods(["plugins.list"]),
  } as ApplicationGatewaySnapshot);
  const subscribe = () => () => undefined;
  const config = { plugins: { entries: {} } };
  const patchForm = vi.fn();
  const context = {
    basePath: "",
    gateway: source.gateway,
    settingsAgentSelection: { state: { selectedId: "main" }, subscribe },
    config: {
      current: { assistantIdentity: { name: "OpenClaw" }, serverVersion: "test" },
      subscribe,
    },
    runtimeConfig: {
      canSet: true,
      state: {
        connected: true,
        configLoading: false,
        configSchemaLoading: false,
        configSnapshot: { config, runtimeConfig: config, hash: "session-sources" },
        configSchema: {
          type: "object",
          properties: {
            plugins: {
              type: "object",
              properties: {
                entries: {
                  type: "object",
                  properties: Object.fromEntries(
                    ["anthropic", "codex"].map((id) => [
                      id,
                      {
                        type: "object",
                        properties: {
                          config: {
                            type: "object",
                            properties: {
                              sessionCatalog: {
                                type: "object",
                                properties: { enabled: { type: "boolean", default: true } },
                              },
                            },
                          },
                        },
                      },
                    ]),
                  ),
                },
              },
            },
          },
        },
        configUiHints: {},
        configForm: config,
        configFormOriginal: config,
        configRaw: JSON.stringify(config),
        configRawOriginal: JSON.stringify(config),
        configValid: true,
        configIssues: [],
      },
      patchForm,
      subscribe,
    },
    theme: { serverSelection: null, subscribe },
    overlays: { snapshot: {}, subscribe },
    webPush: { snapshot: undefined, subscribe },
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const page = new ConfigPage();
  page.pageId = "appearance";
  provider.append(page);
  document.body.append(provider);
  await settleLitElement(page);
  expect(connection.reads).toHaveLength(1);
  connection.reads[0]!.resolve(plugins("anthropic", "codex"));
  await settleLitElement(page);
  expect(titles(page)).toEqual(["Show Claude Code sessions", "Show Codex sessions"]);
  return { page, provider, context, source, connection, patchForm };
}

function titles(page: ConfigPage) {
  return [...page.querySelectorAll("#settings-session-sources .settings-row__title")].map((row) =>
    row.textContent?.trim(),
  );
}

async function returnToAppearance(page: ConfigPage) {
  page.pageId = "advanced";
  await settleLitElement(page);
  page.pageId = "appearance";
  await settleLitElement(page);
}

describe("ConfigPage session source refresh", () => {
  it.each(["changed", "empty", "failure"] as const)(
    "keeps rows read-only during return refresh and adopts its %s outcome",
    async (outcome) => {
      const { page, connection, patchForm } = await mount();
      await returnToAppearance(page);
      expect(connection.reads).toHaveLength(2);
      expect(titles(page)).toEqual(["Show Claude Code sessions", "Show Codex sessions"]);
      const switches = [...page.querySelectorAll("#settings-session-sources wa-switch")];
      expect(switches).toHaveLength(2);
      expect(switches.every((toggle) => toggle.hasAttribute("disabled"))).toBe(true);
      for (const row of page.querySelectorAll<HTMLElement>(
        "#settings-session-sources .settings-row",
      )) {
        row.click();
      }
      expect(patchForm).not.toHaveBeenCalled();

      if (outcome === "failure") {
        connection.reads[1]!.reject(new Error("Plugin discovery failed"));
      } else {
        connection.reads[1]!.resolve(outcome === "changed" ? plugins("codex") : plugins());
      }
      await settleLitElement(page);
      expect(titles(page)).toEqual(outcome === "changed" ? ["Show Codex sessions"] : []);
      if (outcome === "changed") {
        expect(
          page.querySelector("#settings-session-sources wa-switch")?.hasAttribute("disabled"),
        ).toBe(false);
        page.querySelector<HTMLElement>("#settings-session-sources .settings-row")!.click();
        expect(patchForm).toHaveBeenCalledWith(
          ["plugins", "entries", "codex", "config", "sessionCatalog", "enabled"],
          false,
        );
      } else {
        expect(page.querySelector("#settings-session-sources")?.textContent).toContain(
          outcome === "empty"
            ? "No supported session source plugins are installed"
            : "Session source settings are unavailable",
        );
        await returnToAppearance(page);
        expect(connection.reads).toHaveLength(3);
        expect(titles(page)).toEqual([]);
        connection.reads[2]!.resolve(plugins());
        await settleLitElement(page);
      }
    },
  );

  it.each([
    "source",
    "client",
    "reconnect",
    "read scope",
    "advertisement",
    "read scope bounce",
    "advertisement bounce",
  ] as const)(
    "clears retained rows on %s changes and ignores the retired reply",
    async (change) => {
      const { page, provider, context, source, connection, patchForm } = await mount();
      await returnToAppearance(page);
      const retired = connection.reads[1]!;
      const snapshot = source.gateway.snapshot;
      let currentConnection = connection;
      if (change === "source") {
        provider.setContext({ ...context, gateway: createApplicationGateway(snapshot).gateway });
      } else if (change === "client") {
        currentConnection = createClient();
        source.publish({ ...snapshot, client: currentConnection.client });
      } else if (change === "reconnect") {
        source.publish({ ...snapshot, phase: "offline" });
        // Even a reconnect within one render turn retires the old transport epoch.
        source.publish(snapshot);
      } else {
        source.publish({
          ...snapshot,
          hello: gatewayHelloForMethods(
            change.startsWith("advertisement") ? [] : ["plugins.list"],
            change.startsWith("read scope") ? [] : ["operator.admin"],
          ),
        });
        if (!change.endsWith("bounce")) {
          await settleLitElement(page);
          expect(titles(page)).toEqual([]);
          expect(connection.reads).toHaveLength(2);
        }
        source.publish(snapshot);
      }
      await settleLitElement(page);
      expect(titles(page)).toEqual([]);
      expect(currentConnection.reads).toHaveLength(change === "client" ? 1 : 3);
      currentConnection.reads.at(-1)!.resolve(plugins("codex"));
      await settleLitElement(page);
      expect(titles(page)).toEqual(["Show Codex sessions"]);
      retired.resolve(plugins("anthropic"));
      await settleLitElement(page);
      expect(titles(page)).toEqual(["Show Codex sessions"]);
      expect(patchForm).not.toHaveBeenCalled();
    },
  );
});
