/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createClient,
  createContext,
  createGateway,
  createPluginsRouteData,
  createPluginsRouteLocation,
  createResult,
  mountPage,
  resetPluginsPageTestState,
} from "./plugins-page.test-support.ts";

describe("PluginsPage config connection", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });
  afterEach(resetPluginsPageTestState);

  it("loads Advanced configuration after mounting disconnected and reconnecting", async () => {
    const { client, request } = createClient(async (method) => {
      if (method === "plugins.list") {
        return createResult();
      }
      if (method === "config.get") {
        return { config: { plugins: { enabled: true } }, hash: "fixture", valid: true, issues: [] };
      }
      if (method === "config.schema") {
        return {
          schema: {
            type: "object",
            properties: {
              plugins: {
                type: "object",
                properties: { enabled: { type: "boolean", title: "Plugin startup setting" } },
              },
            },
          },
          uiHints: {},
          version: "connected-schema",
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const harness = createGateway(client, false);
    const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
    try {
      const { page } = await mountPage(
        { ...createContext(harness.gateway), runtimeConfig },
        createPluginsRouteData(
          harness.gateway,
          null,
          createPluginsRouteLocation("/settings/plugins?tab=advanced"),
        ),
      );
      expect(request).not.toHaveBeenCalledWith("config.schema", {});
      expect(runtimeConfig.state.configSchemaVersion).toBeNull();

      harness.emit(client, true, {
        hello: gatewayHelloForMethods([
          "config.get",
          "config.schema",
          "config.set",
          "plugins.list",
        ]),
      });
      await waitForFast(() =>
        expect(runtimeConfig.state.configSchemaVersion).toBe("connected-schema"),
      );
      await page.updateComplete;
      expect(request.mock.calls.filter(([method]) => method === "config.schema")).toHaveLength(1);
      expect(page.textContent).toContain("Plugin startup setting");
    } finally {
      runtimeConfig.dispose();
    }
  });
});
