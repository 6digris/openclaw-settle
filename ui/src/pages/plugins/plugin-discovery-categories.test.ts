// @vitest-environment node
import type { ReactiveControllerHost } from "lit";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayBrowserClient } from "../../api/gateway.ts";
import type { PluginDiscoveryResult } from "../../lib/plugins/index.ts";
import { PluginDiscoveryController } from "./plugin-discovery-controller.ts";

const categories = [
  {
    slug: "channels",
    label: "Channels",
    description: "Channels",
    icon: "message-circle",
    order: 0,
  },
];
function setup() {
  const browse = createDeferred<PluginDiscoveryResult>();
  const category = createDeferred<{ categories: typeof categories }>();
  const client = new GatewayBrowserClient({ url: "ws://fixture.invalid" });
  const request = vi.spyOn(client, "request").mockImplementation(async (method) => {
    if (method === "plugins.catalog.categories") {
      return category.promise;
    }
    if (method === "plugins.catalog.browse") {
      return browse.promise;
    }
    throw new Error(method);
  });
  const host = {
    addController() {},
    removeController() {},
    requestUpdate: vi.fn(),
    updateComplete: Promise.resolve(true),
  } satisfies ReactiveControllerHost;
  const controller = new PluginDiscoveryController(host, {
    getClient: () => client,
    isConnected: () => true,
  });
  return { controller, browse, category, request };
}
it("publishes categories before the inventory-backed overview completes", async () => {
  const { controller, browse, category, request } = setup();
  const refresh = controller.refresh();
  expect(request).toHaveBeenCalledWith("plugins.catalog.categories", {}, expect.anything());
  category.resolve({ categories });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(controller.categories).toEqual(categories);
  expect(controller.loading).toBe(true);
  browse.resolve({ items: [] });
  await refresh;
  expect(controller.categories).toEqual(categories);
});

it("stops loading for an empty taxonomy and reuses it across filters", async () => {
  const { controller, category, browse, request } = setup();
  const loading = controller.loadCategories();
  expect(controller.categoriesLoading).toBe(true);
  category.resolve({ categories: [] });
  await loading;
  expect(controller.categoriesLoading).toBe(false);
  browse.resolve({ items: [] });
  await controller.refresh();
  controller.selectIntent("featured");
  await controller.refresh();
  expect(
    request.mock.calls.filter(([method]) => method === "plugins.catalog.categories"),
  ).toHaveLength(1);
  expect(controller.categories).toEqual([]);
});

it("uses a faster overview without waiting for or accepting a late category response", async () => {
  const { controller, category, browse } = setup();
  const loading = controller.loadCategories();
  const refresh = controller.refresh();
  browse.resolve({ items: [], categories });
  await refresh;
  expect(controller.categoriesLoading).toBe(false);
  expect(controller.categories).toEqual(categories);
  category.resolve({ categories: [] });
  await loading;
  expect(controller.categories).toEqual(categories);
});

it("keeps navigation when the overview fails", async () => {
  const { controller, category, browse } = setup();
  const loading = controller.loadCategories();
  const refresh = controller.refresh();
  category.resolve({ categories });
  await loading;
  browse.reject(new Error("Catalog unavailable"));
  await refresh;
  expect(controller.categories).toEqual(categories);
  expect(controller.categoriesLoading).toBe(false);
  expect(controller.error).toContain("Catalog unavailable");
});

it("ends category skeletons on failure and retries only the categories request", async () => {
  const { controller, category, request } = setup();
  const loading = controller.loadCategories();
  category.reject(new Error("Categories unavailable"));
  await loading;
  expect(controller.categoriesLoading).toBe(false);
  expect(controller.categoriesError).toContain("Categories unavailable");
  await controller.loadCategories();
  expect(request).toHaveBeenCalledOnce();
  request.mockResolvedValueOnce({ categories });
  await controller.loadCategories(true);
  expect(request).toHaveBeenCalledTimes(2);
  expect(controller.categoriesError).toBeNull();
  expect(controller.categories).toEqual(categories);
});

it("recovers through the overview when an older registry lacks the category endpoint", async () => {
  const { controller, category, browse } = setup();
  const loading = controller.loadCategories();
  const refresh = controller.refresh();
  category.reject(new Error("Not found"));
  await loading;
  browse.resolve({ items: [], categories });
  await refresh;
  expect(controller.categories).toEqual(categories);
  expect(controller.categoriesError).toBeNull();
});

it("fences a late category response after connection invalidation", async () => {
  const { controller, category, request } = setup();
  const old = controller.loadCategories();
  controller.invalidate();
  request.mockResolvedValueOnce({ categories: [] });
  await controller.loadCategories();
  category.resolve({ categories });
  await old;
  expect(controller.categories).toEqual([]);
  expect(controller.categoriesLoading).toBe(false);
});

it("fences disconnect results without preventing a later category load", async () => {
  const { controller, category, request } = setup();
  const loading = controller.loadCategories();
  controller.disconnect();
  category.resolve({ categories });
  await loading;
  expect(controller.categories).toEqual([]);
  expect(controller.categoriesLoading).toBe(false);
  request.mockResolvedValueOnce({ categories });
  await controller.loadCategories();
  expect(request).toHaveBeenCalledTimes(2);
  expect(controller.categories).toEqual(categories);
});
