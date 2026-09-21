import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { waitForApprovalRequested } from "./approval-request.test-support.js";
import type { GatewayRequestContext } from "./types.js";

describe("approval requested observation", () => {
  it("observes an already-published public event and restores the broadcaster", async () => {
    const implementation: GatewayRequestContext["broadcast"] = () => {};
    const broadcast = vi.fn(implementation);
    const request = createDeferred();
    broadcast("plugin.approval.requested", { id: "approval" });

    await waitForApprovalRequested(broadcast, "plugin.approval.requested", request.promise);

    expect(broadcast.getMockImplementation()).toBe(implementation);
    request.resolve();
  });

  it("observes the targeted publisher without changing its arguments or policy result", async () => {
    const implementation = vi.fn<GatewayRequestContext["broadcastToConnIds"]>();
    const broadcast = vi.fn<GatewayRequestContext["broadcastToConnIds"]>(implementation);
    const request = createDeferred<{ ok: true; payload: { completed: true } }>();
    const observed = waitForApprovalRequested(
      broadcast,
      "plugin.approval.requested",
      request.promise,
    );
    const payload = { id: "approval" };
    const recipients = new Set(["reviewer"]);
    const options = { dropIfSlow: true };
    broadcast("plugin.approval.requested", payload, recipients, options);
    await observed;

    expect(implementation).toHaveBeenCalledExactlyOnceWith(
      "plugin.approval.requested",
      payload,
      recipients,
      options,
    );
    expect(broadcast.getMockImplementation()).toBe(implementation);
    const result = { ok: true as const, payload: { completed: true as const } };
    request.resolve(result);
    await expect(request.promise).resolves.toBe(result);
  });

  it("reports request completion before publication", async () => {
    const implementation: GatewayRequestContext["broadcastToConnIds"] = () => {};
    const broadcast = vi.fn(implementation);

    await expect(
      waitForApprovalRequested(
        broadcast,
        "plugin.approval.requested",
        Promise.resolve({ ok: false }),
      ),
    ).rejects.toThrow("Approval request completed before the expected RPC event");
    expect(broadcast.getMockImplementation()).toBe(implementation);
  });

  it("preserves an early request rejection and restores the broadcaster", async () => {
    const implementation: GatewayRequestContext["broadcast"] = () => {};
    const broadcast = vi.fn(implementation);
    const failure = new Error("approval persistence failed");

    await expect(
      waitForApprovalRequested(broadcast, "plugin.approval.requested", Promise.reject(failure)),
    ).rejects.toBe(failure);
    expect(broadcast.getMockImplementation()).toBe(implementation);
  });
});
