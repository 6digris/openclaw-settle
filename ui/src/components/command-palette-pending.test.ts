/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentsListResult, ModelCatalogResult, SessionsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import type { ApplicationContext } from "../app/context.ts";
import { loadModelCatalog } from "../lib/model-catalog-store.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import {
  createContext,
  createGateway,
  createSessionResult,
  enterQuery,
  findPaletteOption,
  mountPalette,
} from "./command-palette.test-support.ts";
import "./command-palette.ts";

describe("CommandPalette pending searches", () => {
  let restoreDialogPolyfill: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    restoreDialogPolyfill = installDialogPolyfill();
  });

  afterEach(() => {
    document.body.replaceChildren();
    restoreDialogPolyfill();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "publishes model navigation while every unrelated source waits (cached: %s)",
    async (cached) => {
      const optional = createDeferred<unknown>();
      const agents = createDeferred<AgentsListResult | null>();
      const sessions = createDeferred<SessionsListResult | null>();
      const request = vi.fn((method: string) =>
        method === "models.list"
          ? { models: [{ provider: "fixture", id: "ready", name: "Needle ready" }] }
          : optional.promise,
      );
      const { gateway } = createGateway(true, {
        methods: ["cron.list", "skills.status", "plugins.list"],
        request,
      });
      if (cached) {
        await loadModelCatalog(gateway.snapshot.client!, { agentId: "main" });
      }
      const context = createContext(gateway, () => sessions.promise);
      context.agents.ensureList = () => agents.promise;
      const { palette } = await mountPalette(context);
      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(50);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Needle ready")).toBeDefined();
      expect(palette.textContent).not.toContain("No results");
      expect(request.mock.calls.filter(([method]) => method === "models.list")).toEqual([
        ["models.list", { agentId: "main", view: "configured" }],
      ]);
      expect(request.mock.calls.map(([method]) => method)).toEqual(
        expect.arrayContaining(["cron.list", "skills.status", "plugins.list"]),
      );
      palette.querySelector("input")?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
        }),
      );
      expect(palette.onNavigate).toHaveBeenCalledExactlyOnceWith("model-providers");
      expect(
        request.mock.calls.filter(([method]) =>
          [
            "sessions.patch",
            "sessions.create",
            "config.set",
            "config.patch",
            "config.apply",
          ].includes(method),
        ),
      ).toEqual([]);
      optional.resolve({ jobs: [], skills: [], plugins: [] });
      agents.resolve(null);
      sessions.resolve(null);
      await vi.advanceTimersByTimeAsync(0);
    },
  );

  it("recovers model errors on input before an unrelated catalog settles", async () => {
    const optional = createDeferred<unknown>();
    const recovery = createDeferred<ModelCatalogResult>();
    const models = vi
      .fn()
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockReturnValueOnce(recovery.promise);
    const request = vi.fn((method: string) =>
      method === "models.list" ? models() : optional.promise,
    );
    const { gateway } = createGateway(true, { methods: ["cron.list"], request });
    const { palette } = await mountPalette(createContext(gateway, async () => null));
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(palette.textContent).toContain("Model search unavailable");
    await enterQuery(palette, "needle ready");
    await vi.advanceTimersByTimeAsync(50);
    expect(models).toHaveBeenCalledTimes(2);
    expect(palette.textContent).toContain("Model search unavailable");
    recovery.resolve({ models: [{ provider: "fixture", id: "ready", name: "Needle ready" }] });
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle ready")).toBeDefined();
    expect(palette.textContent).not.toContain("Model search unavailable");
    optional.resolve({ jobs: [] });
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle ready")).toBeDefined();
    expect(palette.textContent).not.toContain("Model search unavailable");
  });

  it("replaces partial and empty model snapshots before optional completion", async () => {
    const optional = createDeferred<unknown>();
    const models = vi
      .fn()
      .mockResolvedValueOnce({ models: [{ provider: "fixture", id: "old", name: "Needle old" }] })
      .mockResolvedValueOnce({
        models: [{ provider: "fixture", id: "new", name: "Needle new" }],
        refreshFailed: true,
      })
      .mockResolvedValueOnce({ models: [] });
    const request = vi.fn((method: string) =>
      method === "models.list" ? models() : optional.promise,
    );
    const harness = createGateway(true, { methods: ["cron.list"], request });
    const { palette } = await mountPalette(createContext(harness.gateway, async () => null));
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    expect(findPaletteOption(palette, "Needle old")).toBeDefined();
    harness.emit("config.changed");
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle old")).toBeUndefined();
    expect(findPaletteOption(palette, "Needle new")).toBeDefined();
    expect(palette.textContent).toContain("Some models could not be refreshed");
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle new")).toBeUndefined();
    expect(palette.textContent).not.toContain("Some models could not be refreshed");
    expect(palette.textContent).not.toContain("No results");
    optional.resolve({ jobs: [] });
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(palette.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(palette.textContent).toContain("No results");
    expect(palette.textContent).not.toContain("Some models could not be refreshed");
  });

  it("fences the first agent read after switching away and back", async () => {
    const old = createDeferred<ModelCatalogResult>();
    let mainReads = 0;
    const request = vi.fn((_method: string, params: unknown) => {
      const agentId = (params as { agentId: string }).agentId;
      if (agentId === "main" && ++mainReads === 1) {
        return old.promise;
      }
      return { models: [{ provider: "fixture", id: agentId, name: `Needle ${agentId}` }] };
    });
    const { gateway } = createGateway(true, { request });
    const context = createContext(gateway, async () => null);
    const { palette } = await mountPalette(context);
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    context.agentSelection.set("reviewer");
    await vi.advanceTimersByTimeAsync(50);
    expect(findPaletteOption(palette, "Needle reviewer")).toBeDefined();
    context.agentSelection.set("main");
    await vi.advanceTimersByTimeAsync(50);
    expect(findPaletteOption(palette, "Needle reviewer")).toBeUndefined();
    old.resolve({ models: [{ provider: "fixture", id: "old", name: "Needle old" }] });
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle old")).toBeUndefined();
    expect(findPaletteOption(palette, "Needle main")).toBeDefined();
    expect(mainReads).toBe(2);
  });

  it.each([false, true])(
    "keeps an accepted publication when an older read fails (partial: %s)",
    async (partial) => {
      const old = createDeferred<ModelCatalogResult>();
      const request = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce({
          models: [{ provider: "fixture", id: "accepted", name: "Needle accepted" }],
          refreshFailed: partial,
        });
      const { gateway } = createGateway(true, { request });
      const { palette } = await mountPalette(createContext(gateway, async () => null));
      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(50);
      await loadModelCatalog(gateway.snapshot.client!, { agentId: "main", timeoutMs: 1_000 });
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Needle accepted")).toBeDefined();
      old.reject(new Error("retired read failed"));
      await vi.advanceTimersByTimeAsync(0);
      await palette.updateComplete;
      expect(findPaletteOption(palette, "Needle accepted")).toBeDefined();
      expect(palette.textContent).not.toContain("Model search unavailable");
      expect(palette.textContent?.includes("Some models could not be refreshed")).toBe(partial);
    },
  );

  it.each(["close", "detach", "source"])(
    "preserves another consumer's shared read through palette %s",
    async (transition) => {
      const result = createDeferred<ModelCatalogResult>();
      const request = vi.fn(() => result.promise);
      const { gateway } = createGateway(true, { request });
      const { palette, provider } = await mountPalette(createContext(gateway, async () => null));
      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(50);
      const shared = loadModelCatalog(gateway.snapshot.client!, { agentId: "main" });
      if (transition === "close") {
        palette.togglePalette();
      } else if (transition === "detach") {
        palette.remove();
      } else {
        provider.setContext(createContext({ ...gateway }, async () => null));
      }
      await palette.updateComplete;
      const accepted = {
        models: [{ provider: "fixture", id: "accepted", name: "Needle accepted" }],
      };
      result.resolve(accepted);
      await expect(shared).resolves.toEqual(accepted);
      if (transition === "detach") {
        provider.append(palette);
      }
      await enterQuery(palette, "needle");
      await vi.advanceTimersByTimeAsync(50);
      expect(findPaletteOption(palette, "Needle accepted")).toBeDefined();
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the highlighted model when an earlier category arrives", async () => {
    const optional = createDeferred<unknown>();
    const request = vi.fn((method: string) =>
      method === "cron.list"
        ? optional.promise
        : {
            models: [
              { provider: "fixture", id: "first", name: "Needle first" },
              { provider: "fixture", id: "second", name: "Needle second" },
            ],
          },
    );
    const { gateway } = createGateway(true, { methods: ["cron.list"], request });
    const { palette } = await mountPalette(createContext(gateway, async () => null));
    await enterQuery(palette, "needle");
    await vi.advanceTimersByTimeAsync(50);
    palette.querySelector("input")?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
      }),
    );
    await palette.updateComplete;
    expect(palette.querySelector('[aria-selected="true"]')?.textContent).toContain("Needle second");
    optional.resolve({ jobs: [{ id: "earlier", name: "Needle earlier" }] });
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "Needle earlier")).toBeDefined();
    expect(palette.querySelector('[aria-selected="true"]')?.textContent).toContain("Needle second");
    palette.querySelector("input")?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
      }),
    );
    expect(palette.onNavigate).toHaveBeenCalledExactlyOnceWith("model-providers");
  });

  it.each(["match", "empty", "failure"])(
    "announces session search through debounce and deferred settlement: %s",
    async (outcome) => {
      const deferred = createDeferred<SessionsListResult | null>();
      const { gateway } = createGateway(true);
      const list = vi.fn(() => deferred.promise);
      const { palette } = await mountPalette(createContext(gateway, list));
      await enterQuery(palette, "zzfixtureunique");
      const results = palette.querySelector('[role="listbox"]')!;
      expect(results.getAttribute("aria-busy")).toBe("true");
      expect(palette.querySelector('[role="status"]')?.textContent).toContain("Searching sessions");
      expect(palette.textContent).not.toContain("No results");
      await vi.advanceTimersByTimeAsync(49);
      expect(list).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(list).toHaveBeenCalledOnce();
      expect(results.getAttribute("aria-busy")).toBe("true");
      expect(palette.querySelectorAll('[role="option"]')).toHaveLength(0);
      if (outcome === "failure") {
        deferred.reject(new Error("Search failed"));
      } else {
        deferred.resolve(
          outcome === "match"
            ? createSessionResult("agent:main:fixture", "zzfixtureunique session")
            : { ...createSessionResult("agent:main:fixture", "Unused"), sessions: [] },
        );
      }
      await vi.advanceTimersByTimeAsync(0);
      await palette.updateComplete;
      expect(results.getAttribute("aria-busy")).toBe("false");
      expect(palette.textContent).not.toContain("Searching sessions");
      if (outcome === "match") {
        findPaletteOption(palette, "zzfixtureunique session")!.click();
        expect(palette.onSelectSession).toHaveBeenCalledWith("agent:main:fixture");
      } else if (outcome === "empty") {
        expect(palette.textContent).toContain("No results");
      } else {
        expect(palette.textContent).toContain("Chat search failed");
        expect(palette.textContent).not.toContain("No results");
      }
    },
  );

  it("waits for uncached command sources without announcing a session search when unavailable", async () => {
    const catalog = createDeferred<{ models: { id: string; provider: string; name: string }[] }>();
    const request = vi.fn(() => catalog.promise);
    const { gateway } = createGateway(true, { request });
    const list = vi.fn(async () => null);
    const { palette } = await mountPalette(createContext(gateway, list));
    palette.onSelectSession = undefined;
    await enterQuery(palette, "zzcatalog");
    expect(palette.textContent).toContain("Searching commands");
    expect(palette.textContent).not.toContain("Searching sessions");
    await vi.advanceTimersByTimeAsync(50);
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(palette.textContent).not.toContain("No results");
    const input = palette.querySelector("input")!;
    input.value = "z";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await palette.updateComplete;
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(palette.textContent).not.toContain("No results");
    catalog.resolve({ models: [{ id: "fixture", provider: "fixture", name: "zzcatalog model" }] });
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(findPaletteOption(palette, "zzcatalog model")).toBeDefined();
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    await enterQuery(palette, "zzmissing");
    await vi.advanceTimersByTimeAsync(50);
    await palette.updateComplete;
    expect(palette.textContent).toContain("No results");
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    expect(request).toHaveBeenCalledOnce();
    expect(list).not.toHaveBeenCalled();
  });

  it("waits for the transcript source after metadata settles", async () => {
    const transcript = createDeferred<SessionsSearchResult>();
    const roster = createSessionResult("agent:main:fixture", "Unrelated title");
    const list = vi.fn<ApplicationContext<RouteId>["sessions"]["list"]>(async (options) =>
      options?.search ? { ...roster, sessions: [] } : roster,
    );
    const { gateway } = createGateway(true, {
      methods: ["sessions.search"],
      request: (method) => (method === "sessions.search" ? transcript.promise : { models: [] }),
    });
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "zzfixtureunique");
    await vi.advanceTimersByTimeAsync(50);
    expect(list).toHaveBeenCalledTimes(2);
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(palette.textContent).not.toContain("No results");
    transcript.resolve({
      results: [
        {
          sessionKey: "agent:main:fixture",
          sessionId: "fixture",
          messageId: "message",
          role: "assistant",
          timestamp: 1,
          score: 1,
          snippet: "zzfixtureunique transcript match",
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
    expect(findPaletteOption(palette, "Unrelated title")?.textContent).toContain(
      "zzfixtureunique transcript match",
    );
  });

  it("keeps static commands usable while session search is pending", async () => {
    const { gateway } = createGateway(true);
    const { palette } = await mountPalette(createContext(gateway, () => new Promise(() => {})));
    await enterQuery(palette, "plugins");
    expect(palette.textContent).toContain("Searching sessions");
    findPaletteOption(palette, "Plugins")!.click();
    expect(palette.onNavigate).toHaveBeenCalledWith("plugins");
  });

  it("does not let an old query settle or select rows during a newer debounce", async () => {
    const old = createDeferred<SessionsListResult | null>();
    const current = createDeferred<SessionsListResult | null>();
    const { gateway } = createGateway(true);
    const list = vi
      .fn<ApplicationContext<RouteId>["sessions"]["list"]>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const { palette } = await mountPalette(createContext(gateway, list));
    await enterQuery(palette, "zzold");
    await vi.advanceTimersByTimeAsync(50);
    const input = palette.querySelector("input")!;
    input.value = "zznew";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    old.resolve(createSessionResult("agent:main:old", "zzold match"));
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("true");
    expect(palette.querySelectorAll('[role="option"]')).toHaveLength(0);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(palette.onSelectSession).not.toHaveBeenCalled();
    expect(palette.isOpen).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    current.resolve(createSessionResult("agent:main:new", "zznew match"));
    await vi.advanceTimersByTimeAsync(0);
    await palette.updateComplete;
    expect(palette.textContent).not.toContain("zzold match");
    expect(findPaletteOption(palette, "zznew match")).toBeDefined();
    expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
  });

  it.each(["close", "detach", "short-query", "disconnect"])(
    "clears pending search on %s and ignores its late completion",
    async (action) => {
      const deferred = createDeferred<SessionsListResult | null>();
      const harness = createGateway(true);
      const { palette, provider } = await mountPalette(
        createContext(harness.gateway, () => deferred.promise),
      );
      await enterQuery(palette, "zzfixtureunique");
      await vi.advanceTimersByTimeAsync(50);
      if (action === "close") {
        palette.togglePalette();
        palette.openPalette();
      } else if (action === "detach") {
        palette.remove();
        provider.append(palette);
        palette.openPalette();
      } else if (action === "disconnect") {
        harness.setConnected(false);
      } else {
        const input = palette.querySelector("input")!;
        input.value = "z";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await palette.updateComplete;
      expect(palette.querySelector('[role="listbox"]')?.getAttribute("aria-busy")).toBe("false");
      deferred.resolve(createSessionResult("agent:main:stale", "zzfixtureunique stale"));
      await vi.advanceTimersByTimeAsync(0);
      await palette.updateComplete;
      expect(palette.textContent).not.toContain("Searching sessions");
      expect(findPaletteOption(palette, "zzfixtureunique stale")).toBeUndefined();
    },
  );
});
