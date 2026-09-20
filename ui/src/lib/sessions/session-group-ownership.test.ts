// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { load as loadNewSession } from "../../pages/new-session/route-loader.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

const methods = ["list", "defaults", "put", "rename", "delete", "update"].map(
  (method) => "sessions.groups." + method,
);
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

function setup(handler?: (method: string, params: Record<string, unknown>) => unknown) {
  const request = vi.fn(async (method: string, params: Record<string, unknown> = {}) => {
    const supplied = handler?.(method, params);
    if (supplied !== undefined) {
      return supplied;
    }
    if (method.startsWith("sessions.groups.") && typeof params.agentId !== "string") {
      throw new Error("Expected an explicit group owner");
    }
    const agentId = String(params.agentId);
    if (method === "sessions.groups.list") {
      return {
        groups: [
          { name: "Shared", position: 0 },
          { name: agentId + " empty", position: 1 },
        ],
        sectionOrder: ["category:Shared", "ungrouped"],
      };
    }
    if (method === "sessions.groups.defaults") {
      return {
        defaults: [
          {
            name: "Shared",
            cwd: "/workspace/" + agentId,
            worktree: params.agentId === "alpha",
          },
        ],
      };
    }
    return sessionsResult([], 1);
  });
  const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient, methods);
  harness.gateway.snapshot.hello = {
    ...harness.gateway.snapshot.hello,
    auth: { role: "operator", scopes: ["operator.write"] },
  } as GatewayHelloOk;
  harness.gateway.snapshot.assistantAgentId = "alpha";
  let selectedId = "alpha";
  const listeners = new Set<() => void>();
  const selection = {
    get state() {
      return { selectedId };
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const gateway = Object.assign(harness.gateway, {
    connection: { gatewayUrl: "wss://first.example/gateway" },
  });
  const sessions = createSessionCapability(gateway, selection);
  cleanup.push(() => sessions.dispose());
  return {
    ...harness,
    request,
    sessions,
    gateway,
    select: (agentId: string) => {
      selectedId = agentId;
      listeners.forEach((listener) => listener());
    },
  };
}

describe("agent-owned group catalog", () => {
  it("keeps equal names, empty groups, defaults and order independent without loading a roster's other catalogs", async () => {
    const h = setup();
    await h.sessions.groupsLoad("alpha");
    expect(h.sessions.state.groups).toEqual(["Shared", "alpha empty"]);
    expect(h.sessions.groupsSnapshot("beta").settings).toEqual([]);
    expect(h.request.mock.calls.filter(([method]) => method === "sessions.groups.list")).toEqual([
      ["sessions.groups.list", { agentId: "alpha" }],
    ]);
    await h.sessions.groupsLoad("beta");
    expect(h.sessions.state.groups).toEqual(["Shared", "alpha empty"]);
    expect(h.sessions.groupsSnapshot("alpha").settings[0]).toMatchObject({
      cwd: "/workspace/alpha",
      worktree: true,
    });
    expect(h.sessions.groupsSnapshot("beta").settings[0]).toMatchObject({
      cwd: "/workspace/beta",
      worktree: false,
    });
    expect(h.sessions.groupsSnapshot("beta").sectionOrder).toEqual([
      "category:Shared",
      "ungrouped",
    ]);
    await h.sessions.groupsLoad("beta");
    expect(
      h.request.mock.calls.filter(([method]) => method === "sessions.groups.list"),
    ).toHaveLength(2);
  });

  it("retires the first A read through A -> B -> A instead of admitting its late catalog", async () => {
    const stale = createDeferred<unknown>();
    let reads = 0;
    const h = setup((method, params) =>
      method === "sessions.groups.list" && params.agentId === "alpha" && ++reads === 1
        ? stale.promise
        : undefined,
    );
    const oldLoad = h.sessions.groupsLoad("alpha");
    await vi.waitFor(() =>
      expect(h.request).toHaveBeenCalledWith("sessions.groups.list", { agentId: "alpha" }),
    );
    h.select("beta");
    await h.sessions.groupsLoad("beta");
    h.select("alpha");
    await h.sessions.groupsLoad("alpha");
    stale.resolve({ groups: [{ name: "Retired A", position: 0 }] });
    await oldLoad;
    expect(h.sessions.state.groups).toEqual(["Shared", "alpha empty"]);
    expect(h.sessions.groupsSnapshot("beta").settings.map((group) => group.name)).toEqual([
      "Shared",
      "beta empty",
    ]);
  });

  it.each(["rename", "delete"] as const)(
    "does not apply a late %s response after switching away and back",
    async (method) => {
      const response = createDeferred<unknown>();
      const admitted = createDeferred();
      const h = setup((name) => {
        if (name === "sessions.groups." + method) {
          admitted.resolve();
          return response.promise;
        }
        return undefined;
      });
      await h.sessions.groupsLoad("alpha");
      const mutation =
        method === "rename"
          ? h.sessions.groupsRename("Shared", "Renamed", "alpha")
          : h.sessions.groupsDelete("Shared", "alpha");
      await admitted.promise;
      h.select("beta");
      await h.sessions.groupsLoad("beta");
      h.select("alpha");
      await h.sessions.groupsLoad("alpha");
      response.resolve({ ok: true, groups: [{ name: "Wrong late catalog", position: 0 }] });
      await expect(mutation).resolves.toBe("stale");
      expect(h.sessions.state.groups).toEqual(["Shared", "alpha empty"]);
      expect(h.request).toHaveBeenCalledWith(
        "sessions.groups." + method,
        method === "rename"
          ? { agentId: "alpha", name: "Shared", to: "Renamed" }
          : { agentId: "alpha", name: "Shared" },
      );
    },
  );

  it("admits a non-foreground write before the initiating UI scope can retire", async () => {
    let active = true;
    const admissions: Array<{ owner: unknown; active: boolean }> = [];
    const h = setup((method, params) => {
      if (method === "sessions.groups.put") {
        admissions.push({ owner: params.agentId, active });
        return { ok: true, groups: [{ name: "New", position: 0 }] };
      }
      return undefined;
    });
    await h.sessions.groupsLoad("alpha");
    await h.sessions.groupsLoad("beta");
    const mutation = h.sessions.groupsPut(["New"], undefined, "beta", true);
    active = false;
    h.select("gamma");
    await mutation;
    expect(admissions).toEqual([{ owner: "beta", active: true }]);
  });

  it("scopes append creation, reorder and defaults updates to their requested owner", async () => {
    const h = setup((method) =>
      method === "sessions.groups.put"
        ? { ok: true, groups: [{ name: "Shared", position: 0 }] }
        : method === "sessions.groups.update"
          ? { defaults: [{ name: "Shared", cwd: "/beta/changed", worktree: false }] }
          : undefined,
    );
    await h.sessions.groupsLoad("alpha");
    await h.sessions.groupsLoad("beta");
    await h.sessions.groupsPut(["New"], undefined, "beta", true);
    await h.sessions.groupsPut(["Shared"], ["ungrouped", "category:Shared"], "beta");
    await h.sessions.groupsUpdate("Shared", { cwd: "/beta/changed", worktree: false }, "beta");
    expect(h.request).toHaveBeenCalledWith("sessions.groups.put", {
      agentId: "beta",
      names: ["New"],
      append: true,
    });
    expect(h.request).toHaveBeenCalledWith("sessions.groups.put", {
      agentId: "beta",
      names: ["Shared"],
      sectionOrder: ["ungrouped", "category:Shared"],
    });
    expect(h.request).toHaveBeenCalledWith("sessions.groups.update", {
      agentId: "beta",
      name: "Shared",
      cwd: "/beta/changed",
      worktree: false,
    });
    expect(h.sessions.groupsSnapshot("alpha").settings[0]?.cwd).toBe("/workspace/alpha");
  });

  it("preloads New Session defaults for the route agent, not the foreground agent", async () => {
    const h = setup();
    await h.sessions.groupsLoad("alpha");
    const context = { sessions: h.sessions, gateway: h.gateway } as unknown as ApplicationContext;
    const beta = await loadNewSession(context, "?agent=beta&group=Shared", "preload");
    expect(beta).toMatchObject({
      agentId: "beta",
      requestedAgentId: "beta",
      groupStatus: "resolved",
      groupCwd: "/workspace/beta",
      groupWorktree: false,
    });
    expect(h.sessions.state.groupSettings[0]?.cwd).toBe("/workspace/alpha");
  });

  it("imports legacy browser names into the configured default using append even while another agent is selected", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem("openclaw:sessions:custom-groups", JSON.stringify(["Legacy"]));
    const h = setup((method) =>
      method === "sessions.groups.put"
        ? {
            ok: true,
            groups: [
              { name: "Existing", position: 0 },
              { name: "Legacy", position: 1 },
            ],
          }
        : undefined,
    );
    await h.sessions.groupsLoad("beta");
    await vi.waitFor(() =>
      expect(h.request).toHaveBeenCalledWith("sessions.groups.put", {
        agentId: "alpha",
        names: ["Legacy"],
        append: true,
        importId: expect.any(String),
      }),
    );
    await vi.waitFor(() =>
      expect(localStorage.getItem("openclaw:sessions:custom-groups")).toBeNull(),
    );
    await h.sessions.groupsLoad("alpha");
    expect(
      h.request.mock.calls.filter(([method]) => method === "sessions.groups.put"),
    ).toHaveLength(1);
  });

  it("retains legacy source when acknowledgement belongs to a retired connection", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem("openclaw:sessions:custom-groups", JSON.stringify(["Legacy"]));
    const ack = createDeferred<unknown>();
    const h = setup((method) => (method === "sessions.groups.put" ? ack.promise : undefined));
    const load = h.sessions.groupsLoad("beta");
    await vi.waitFor(() =>
      expect(h.request).toHaveBeenCalledWith("sessions.groups.put", {
        agentId: "alpha",
        names: ["Legacy"],
        append: true,
        importId: expect.any(String),
      }),
    );
    // Canonical reads do not wait for a migration acknowledgement.
    await expect(load).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "beta empty" })]),
    );
    h.publish(false);
    ack.resolve({ ok: true, groups: [{ name: "Legacy", position: 0 }] });
    await ack.promise;
    expect(localStorage.getItem("openclaw:sessions:custom-groups")).toBe(
      JSON.stringify(["Legacy"]),
    );
  });
  it("keeps canonical reads usable after a failed legacy import", async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    localStorage.setItem("openclaw:sessions:custom-groups", JSON.stringify(["Legacy"]));
    const h = setup((method) =>
      method === "sessions.groups.put"
        ? Promise.reject(new Error("Lost acknowledgement"))
        : undefined,
    );
    await expect(h.sessions.groupsLoad("alpha")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "alpha empty" })]),
    );
    await vi.waitFor(() =>
      expect(h.request).toHaveBeenCalledWith(
        "sessions.groups.put",
        expect.objectContaining({ importId: expect.any(String) }),
      ),
    );
    expect(h.sessions.groupsStatus("alpha")).toBe("ready");
    expect(localStorage.getItem("openclaw:sessions:custom-groups")).toBe(
      JSON.stringify(["Legacy"]),
    );
  });

  it.each(["default agent", "Gateway", "profile"] as const)(
    "reads a replacement catalog without retargeting the pending import after changing %s",
    async (boundary) => {
      vi.stubGlobal("localStorage", createStorageMock());
      localStorage.setItem("openclaw:sessions:custom-groups", JSON.stringify(["Legacy"]));
      const ack = createDeferred<unknown>();
      const first = setup((method) => (method === "sessions.groups.put" ? ack.promise : undefined));
      await first.sessions.groupsLoad("alpha");
      await vi.waitFor(() =>
        expect(first.request).toHaveBeenCalledWith(
          "sessions.groups.put",
          expect.objectContaining({ importId: expect.any(String) }),
        ),
      );
      const claim = localStorage.getItem("openclaw:sessions:custom-groups:import");
      first.sessions.dispose();
      ack.reject(new Error("Lost acknowledgement"));
      const replacement = setup();
      if (boundary === "default agent") {
        replacement.gateway.snapshot.assistantAgentId = "beta";
        replacement.select("beta");
      } else if (boundary === "Gateway") {
        replacement.gateway.connection.gatewayUrl = "wss://second.example/gateway";
      } else {
        replacement.gateway.snapshot.selfUser = { id: "other-viewer" };
      }
      const readClaim = vi.spyOn(localStorage, "getItem");
      await expect(replacement.sessions.groupsLoad("beta")).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ name: "beta empty" })]),
      );
      await vi.waitFor(() =>
        expect(readClaim).toHaveBeenCalledWith("openclaw:sessions:custom-groups:import"),
      );
      expect(
        replacement.request.mock.calls.filter(([method]) => method === "sessions.groups.put"),
      ).toEqual([]);
      expect(localStorage.getItem("openclaw:sessions:custom-groups:import")).toBe(claim);
      expect(localStorage.getItem("openclaw:sessions:custom-groups")).toBe(
        JSON.stringify(["Legacy"]),
      );
    },
  );
});
