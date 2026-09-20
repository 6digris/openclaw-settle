// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { importLegacySessionGroups } from "./session-group-operations.ts";

const sourceKey = "openclaw:sessions:custom-groups";
const claimKey = sourceKey + ":import";
const destination = {
  gatewayUrl: "wss://first.example/gateway",
  profileId: "viewer",
  agentId: "alpha",
};
beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  localStorage.setItem(sourceKey, JSON.stringify(["Legacy"]));
});
afterEach(() => vi.unstubAllGlobals());

function createHarness() {
  const names = new Set<string>();
  const receipts = new Map<string, { agentId: string; names: Set<string> }>();
  let failAck = false;
  let pending: Promise<unknown> | null = null;
  const request = vi.fn(
    async (
      _method: string,
      params: { agentId: string; names: string[]; append: boolean; importId?: string },
    ) => {
      if (params.importId) {
        expect(JSON.parse(localStorage.getItem(claimKey)!)).toMatchObject({
          importId: params.importId,
          agentId: params.agentId,
        });
        const receipt = receipts.get(params.importId) ?? {
          agentId: params.agentId,
          names: new Set<string>(),
        };
        if (receipt.agentId !== params.agentId || !params.append) {
          throw new Error("Wrong import destination");
        }
        for (const name of params.names) {
          if (!receipt.names.has(name)) {
            names.add(name);
            receipt.names.add(name);
          }
        }
        receipts.set(params.importId, receipt);
      } else {
        for (const name of params.names) {
          names.add(name);
        }
      }
      if (pending) {
        await pending;
      }
      if (failAck) {
        throw new Error("acknowledgement lost");
      }
      return { ok: true, groups: [...names].map((name, position) => ({ name, position })) };
    },
  );
  const client = { request } as unknown as GatewayBrowserClient;
  return {
    request,
    names,
    receipts,
    client,
    loseAck: (value: boolean) => {
      failAck = value;
    },
    defer: (value: Promise<unknown> | null) => {
      pending = value;
    },
    run: (overrides: Partial<typeof destination> = {}, isCurrent = () => true) =>
      importLegacySessionGroups({ ...destination, ...overrides, client, isCurrent }),
  };
}

describe("durable browser group import", () => {
  it("reuses its receipt after a lost acknowledgement and deletion, without resurrection", async () => {
    const h = createHarness();
    h.loseAck(true);
    expect(await h.run()).toBeNull();
    const claim = localStorage.getItem(claimKey);
    expect(h.names.has("Legacy")).toBe(true);
    expect(localStorage.getItem(sourceKey)).toBe(JSON.stringify(["Legacy"]));
    h.names.delete("Legacy");
    h.loseAck(false);
    expect(await h.run()).toBe("alpha");
    expect(h.names.size).toBe(0);
    expect(h.request.mock.calls[1]?.[1].importId).toBe(h.request.mock.calls[0]?.[1].importId);
    expect(localStorage.getItem(sourceKey)).toBeNull();
    expect(localStorage.getItem(claimKey)).toBe(claim);
    await h.request("sessions.groups.put", { agentId: "alpha", names: ["Legacy"], append: true });
    expect(h.names.has("Legacy")).toBe(true);
  });

  it.each([
    { agentId: "beta" },
    { gatewayUrl: "wss://second.example/gateway" },
    { profileId: "other-viewer" },
  ])("does not retarget a durable claim after lost acknowledgement: %j", async (next) => {
    const h = createHarness();
    h.loseAck(true);
    await h.run();
    const claim = localStorage.getItem(claimKey);
    h.loseAck(false);
    expect(await h.run(next)).toBeNull();
    expect(h.request).toHaveBeenCalledOnce();
    expect(localStorage.getItem(claimKey)).toBe(claim);
    expect(localStorage.getItem(sourceKey)).toBe(JSON.stringify(["Legacy"]));
    expect(await h.run()).toBe("alpha");
    expect(h.request.mock.calls[1]?.[1].importId).toBe(h.request.mock.calls[0]?.[1].importId);
  });

  it("preserves new names added while pending and imports them with the same receipt", async () => {
    const h = createHarness();
    const ack = createDeferred();
    h.defer(ack.promise);
    const pending = h.run();
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
    localStorage.setItem(sourceKey, JSON.stringify(["Legacy", "Added"]));
    h.names.delete("Legacy");
    ack.resolve();
    expect(await pending).toBe("alpha");
    expect(localStorage.getItem(sourceKey)).toBe(JSON.stringify(["Legacy", "Added"]));
    h.defer(null);
    expect(await h.run()).toBe("alpha");
    expect([...h.names]).toEqual(["Added"]);
    expect(h.receipts.size).toBe(1);
    expect(localStorage.getItem(sourceKey)).toBeNull();
  });

  it("serializes competing destination claims before either RPC", async () => {
    const h = createHarness();
    const ack = createDeferred();
    h.defer(ack.promise);
    const first = h.run();
    const second = h.run({ agentId: "beta" });
    expect(await second).toBeNull();
    expect(h.request).toHaveBeenCalledOnce();
    ack.resolve();
    expect(await first).toBe("alpha");
    expect(h.request.mock.calls[0]?.[1].agentId).toBe("alpha");
  });

  it("does not clear an acknowledgement after its connection is retired", async () => {
    const h = createHarness();
    const ack = createDeferred();
    h.defer(ack.promise);
    let current = true;
    const pending = h.run({}, () => current);
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
    current = false;
    ack.resolve();
    expect(await pending).toBeNull();
    expect(localStorage.getItem(sourceKey)).toBe(JSON.stringify(["Legacy"]));
    expect(localStorage.getItem(claimKey)).not.toBeNull();
  });

  it.each(["throws", "no-op"])(
    "does not send an import without a durable claim (%s)",
    async (mode) => {
      const h = createHarness();
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        if (mode === "throws") {
          throw new Error("Storage disabled");
        }
      });
      expect(await h.run()).toBeNull();
      expect(h.request).not.toHaveBeenCalled();
      expect(localStorage.getItem(sourceKey)).toBe(JSON.stringify(["Legacy"]));
    },
  );

  it("does not replace a malformed existing claim", async () => {
    const h = createHarness();
    localStorage.setItem(claimKey, "broken");
    expect(await h.run()).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
    expect(localStorage.getItem(claimKey)).toBe("broken");
  });
  it("preserves the source when cross-tab locking is unavailable", async () => {
    const h = createHarness();
    vi.stubGlobal("navigator", {});
    expect(await h.run()).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
    expect(localStorage.getItem(sourceKey)).toBe(JSON.stringify(["Legacy"]));
  });

  it.each([undefined, { ok: false }, { groups: [] }])(
    "retains a source without an explicit successful acknowledgement: %j",
    async (response) => {
      const request = vi.fn(async () => response);
      const client = { request } as unknown as GatewayBrowserClient;
      expect(
        await importLegacySessionGroups({ ...destination, client, isCurrent: () => true }),
      ).toBeNull();
      expect(request).toHaveBeenCalledOnce();
      expect(localStorage.getItem(sourceKey)).toBe(JSON.stringify(["Legacy"]));
      expect(localStorage.getItem(claimKey)).not.toBeNull();
    },
  );
});
