import { describe, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import {
  filterCommandPaletteItems,
  getCommandPaletteModelItems,
  getStaticCommandPaletteCatalogItems,
  loadCommandPaletteCatalogItems,
} from "./command-palette-catalog-search.ts";

describe("command palette catalog search", () => {
  it("projects core model rows separately from optional catalogs", () => {
    const items = getCommandPaletteModelItems({
      models: [{ provider: "fixture", id: "current", name: "Current model" }],
    });
    expect(items).toContainEqual(
      expect.objectContaining({
        category: "models",
        label: "Current model",
        routeId: "model-providers",
      }),
    );
  });

  it("projects the returned rows from a partial catalog without restoring old rows", () => {
    const items = getCommandPaletteModelItems({
      models: [{ provider: "ollama", id: "retained", name: "Retained model", available: true }],
      refreshFailed: true,
      providerOutcomes: [{ provider: "ollama", status: "unavailable" }],
    });

    expect(items).toContainEqual(
      expect.objectContaining({ category: "models", label: "Retained model" }),
    );
    expect(getCommandPaletteModelItems({ models: [] })).toEqual([]);
  });

  it("opens meeting transcripts from search without querying agent chat history", () => {
    const items = filterCommandPaletteItems({
      query: "meeting",
      includeSlashCommands: false,
      sessionItems: [],
      catalogItems: [],
      desktopAvailable: false,
      custodianAvailable: false,
    });
    expect(items).toContainEqual(
      expect.objectContaining({ label: "Meetings", action: "nav:meetings" }),
    );
  });
  it("exposes app cards and permission-filtered settings sections without RPCs", () => {
    const regular = getStaticCommandPaletteCatalogItems(false);
    const admin = getStaticCommandPaletteCatalogItems(true);

    expect(regular).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "apps", label: "iPhone" }),
        expect.objectContaining({ category: "settings", routeId: "profile" }),
      ]),
    );
    expect(regular.some((item) => item.routeId === "security")).toBe(false);
    expect(admin.some((item) => item.routeId === "security")).toBe(true);
    expect(regular.some((item) => item.label === "Meeting capture")).toBe(false);
    expect(admin).toContainEqual(
      expect.objectContaining({
        label: "Meeting capture",
        routeId: "communications",
        search: "?section=transcripts",
      }),
    );
  });

  it("loads bounded name and description catalogs in parallel", async () => {
    const request = vi.fn(async (method: string) => {
      switch (method) {
        case "cron.list":
          return {
            jobs: [
              {
                id: "nightly",
                name: "Nightly invoices",
                description: "Reconciles customer billing",
              },
            ],
          };
        case "skills.status":
          return {
            skills: [
              {
                skillKey: "forecast-brief",
                name: "Forecast brief",
                description: "Summarizes the weather",
                source: "workspace",
              },
            ],
          };
        case "plugins.list":
          return {
            plugins: [
              {
                id: "weather-helper",
                name: "Weather helper",
                description: "Adds forecast tools",
                packageName: "@openclaw/weather-helper",
              },
            ],
          };
        default:
          throw new Error(`Unexpected method: ${method}`);
      }
    });

    const items = await loadCommandPaletteCatalogItems({
      client: createTestGatewayClient(request),
      agentId: "main",
      agents: async () => ({
        defaultId: "main",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "main", name: "Main assistant", workspace: "/workspace" }],
      }),
      methodAvailable: () => true,
    });

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "agents", label: "Main assistant" }),
        expect.objectContaining({ category: "automations", label: "Nightly invoices" }),
        expect.objectContaining({ category: "skills", label: "Forecast brief" }),
        expect.objectContaining({ category: "plugins", label: "Weather helper", icon: "plug" }),
      ]),
    );
    expect(request).toHaveBeenCalledWith(
      "cron.list",
      expect.objectContaining({ includeDisabled: true, limit: 200, offset: 0, compact: true }),
    );
    expect(request).toHaveBeenCalledWith("skills.status", { agentId: "main" });
    expect(request).toHaveBeenCalledWith("plugins.list", {});
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "cron.list",
      "skills.status",
      "plugins.list",
    ]);
  });
});
