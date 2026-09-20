// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";

describe("createSessionCapability", () => {
  it("allows an advertised group catalog load to be retried after failure", async () => {
    let groupsCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.groups.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      groupsCalls += 1;
      if (groupsCalls === 1) {
        throw new Error("temporary catalog failure");
      }
      return {
        groups: [{ name: "Research" }],
        sectionOrder: ["work", "category:Research", "ungrouped"],
      };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.list"]);
    const sessions = createTestSessionCapability(gateway);

    await sessions.groupsLoad();
    expect(sessions.state.groups).toEqual([]);
    await sessions.groupsLoad();

    expect(groupsCalls).toBe(2);
    expect(sessions.state.groups).toEqual(["Research"]);
    expect(sessions.state.sectionOrder).toEqual(["work", "category:Research", "ungrouped"]);
    sessions.dispose();
  });

  it("automatically retries an explicitly retryable group catalog failure", async () => {
    let groupsCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.groups.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      groupsCalls += 1;
      if (groupsCalls === 1) {
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "temporary catalog failure",
          retryable: true,
          retryAfterMs: 100,
        });
      }
      return { groups: [{ name: "Recovered" }] };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.list"]);
    const sessions = createTestSessionCapability(gateway);

    await sessions.groupsLoad();

    await waitForFast(() => expect(sessions.state.groups).toEqual(["Recovered"]));
    expect(groupsCalls).toBe(2);
    sessions.dispose();
  });

  it("keeps the legacy group catalog probe one-shot without feature metadata", async () => {
    const request = vi.fn(async () => {
      throw new Error("unknown method");
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);

    await sessions.groupsLoad();
    await sessions.groupsLoad();

    expect(request).toHaveBeenCalledOnce();
    sessions.dispose();
  });

  it("loads a metadata-less group catalog without probing the newer defaults method", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        return { groups: [{ name: "Research", position: 0 }] };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client);
    const sessions = createTestSessionCapability(gateway);

    await expect(sessions.groupsLoad()).resolves.toEqual([{ name: "Research", position: 0 }]);
    expect(request).toHaveBeenCalledOnce();
    expect(sessions.state.groups).toEqual(["Research"]);
    sessions.dispose();
  });

  it("publishes state.error when group rename is rejected", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.rename") {
        throw new Error("rename failed");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.rename"]);
    const sessions = createTestSessionCapability(gateway);

    await expect(sessions.groupsRename("Alpha", "Beta")).rejects.toThrow("rename failed");
    expect(sessions.state.error).toBe("rename failed");
    sessions.dispose();
  });

  it("publishes state.error when replacing the group catalog is rejected", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.put") {
        throw new Error("group catalog rejected");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.put"]);
    const sessions = createTestSessionCapability(gateway);

    await expect(sessions.groupsPut(["Alpha"])).rejects.toThrow("group catalog rejected");
    expect(sessions.state.error).toBe("group catalog rejected");
    sessions.dispose();
  });

  it("publishes state.error when group delete is rejected", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.delete") {
        throw new Error("delete failed");
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.groups.delete"]);
    const sessions = createTestSessionCapability(gateway);

    await expect(sessions.groupsDelete("Alpha")).rejects.toThrow("delete failed");
    expect(sessions.state.error).toBe("delete failed");
    sessions.dispose();
  });

  it("reports a group rename as stale after a same-client reconnect", async () => {
    const renamed = createDeferred<{ groups: Array<{ name: string }> }>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.rename") {
        return await renamed.promise;
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client, ["sessions.groups.rename"]);
    const sessions = createTestSessionCapability(gateway);

    const operation = sessions.groupsRename("Alpha", "Beta");
    publish(false);
    publish(true);
    renamed.resolve({ groups: [{ name: "Beta" }] });

    await expect(operation).resolves.toBe("stale");
    expect(sessions.state.groups).toEqual([]);
    sessions.dispose();
  });

  it("reports a group catalog replacement as stale after a same-client reconnect", async () => {
    const replaced = createDeferred<{ groups: Array<{ name: string }> }>();
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.put") {
        return await replaced.promise;
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      if (method === "sessions.list") {
        return sessionsResult([], 2);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, publish } = createGatewayHarness(client, ["sessions.groups.put"]);
    const sessions = createTestSessionCapability(gateway);

    const operation = sessions.groupsPut(["Alpha"]);
    publish(false);
    publish(true);
    replaced.resolve({ groups: [{ name: "Alpha" }] });

    await expect(operation).resolves.toBe("stale");
    expect(sessions.state.groups).toEqual([]);
    expect(sessions.state.error).toBeNull();
    sessions.dispose();
  });

  it.each(["rename", "delete"] as const)(
    "keeps a confirmed group %s completed when its row refresh outlives the connection",
    async (operation) => {
      const refreshed = createDeferred<SessionsListResult>();
      const method = operation === "rename" ? "sessions.groups.rename" : "sessions.groups.delete";
      const request = vi.fn(async (requestedMethod: string) => {
        if (requestedMethod === method) {
          return { groups: [{ name: operation === "rename" ? "Beta" : "Other" }] };
        }
        if (requestedMethod === "sessions.list") {
          return await refreshed.promise;
        }
        throw new Error(`Unexpected request: ${requestedMethod}`);
      });
      const client = { request } as unknown as GatewayBrowserClient;
      const { gateway, publish } = createGatewayHarness(client, [method]);
      const sessions = createTestSessionCapability(gateway);

      const mutation =
        operation === "rename"
          ? sessions.groupsRename("Alpha", "Beta")
          : sessions.groupsDelete("Alpha");
      await waitForFast(() =>
        expect(request).toHaveBeenCalledWith("sessions.list", expect.any(Object)),
      );
      publish(false);
      refreshed.resolve(sessionsResult([], 2));

      await expect(mutation).resolves.toBe("completed");
      sessions.dispose();
    },
  );

  it("does not probe for a group catalog when the method is explicitly absent", async () => {
    const request = vi.fn();
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, []);
    const sessions = createTestSessionCapability(gateway);

    await sessions.groupsLoad();
    await sessions.groupsLoad();

    expect(request).not.toHaveBeenCalled();
    expect(sessions.state.groups).toEqual([]);
    sessions.dispose();
  });

  it("ignores an older group load failure after an event-driven load succeeds", async () => {
    const firstGroups = createDeferred<{ groups: Array<{ name: string }> }>();
    const currentGroups = createDeferred<{ groups: Array<{ name: string }> }>();
    let groupsCalls = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.groups.list") {
        groupsCalls += 1;
        return await (groupsCalls === 1 ? firstGroups.promise : currentGroups.promise);
      }
      if (method === "sessions.list") {
        return sessionsResult([], 1);
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, emitEvent } = createGatewayHarness(client, ["sessions.groups.list"]);
    const sessions = createTestSessionCapability(gateway);

    const firstLoad = sessions.groupsLoad();
    await waitForFast(() => expect(groupsCalls).toBe(1));
    emitEvent({ type: "event", event: "sessions.changed", payload: { reason: "groups" } });
    await waitForFast(() => expect(groupsCalls).toBe(2));
    currentGroups.resolve({ groups: [{ name: "Current" }] });
    await waitForFast(() => expect(sessions.state.groups).toEqual(["Current"]));
    firstGroups.reject(new Error("stale catalog failure"));
    await firstLoad;

    await sessions.groupsLoad();
    expect(groupsCalls).toBe(2);
    expect(sessions.state.groups).toEqual(["Current"]);
    sessions.dispose();
  });
});
