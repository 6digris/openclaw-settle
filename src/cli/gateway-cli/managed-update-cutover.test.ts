import { beforeEach, expect, it, vi } from "vitest";
import { prepareGatewayManagedUpdateRestart } from "./managed-update-cutover.js";
import { managedUpdateSuccessorOwner as owner } from "./managed-update-cutover.test-support.js";

const consume = vi.hoisted(() => vi.fn());
vi.mock("../../infra/gateway-suspend-coordinator.js", () => ({
  consumeGatewaySuspendHandoff: consume,
}));
beforeEach(() => {
  consume.mockReset().mockReturnValue({ ok: true, value: true });
});

it("prepares and consumes the exact host handoff before allowing one-way drain", async () => {
  const events: string[] = [];
  const host = { isCurrent: () => true };
  consume.mockImplementation((actual) => {
    expect(actual).toBe(host);
    events.push("consume");
    return { ok: true, value: true };
  });
  const prepared = await prepareGatewayManagedUpdateRestart({
    intent: { successorOwner: owner },
    host,
    warn: vi.fn(),
    runtime: {
      rollbackGatewayRestartSignalAdmission: () => {
        events.push("release-signal-fence");
        return true;
      },
      prepareManagedServiceUpdateHandoffPark: async (actual) => {
        expect(actual).toBe(owner);
        events.push("prepare");
        return true;
      },
      cancelManagedServiceUpdateHandoff: vi.fn(),
    },
  });
  if (prepared) {
    events.push("drain");
  }
  expect(events).toEqual(["release-signal-fence", "prepare", "consume", "drain"]);
});

it.each(["busy", "host replaced", "preparation lost"])(
  "defers %s without granting drain authority",
  async (failure) => {
    const cancel = vi.fn(async () => "restored-in-process" as const);
    if (failure === "preparation lost") {
      consume.mockReturnValue({ ok: true, value: false });
    }
    const allowed = await prepareGatewayManagedUpdateRestart({
      intent: { successorOwner: owner },
      host: { isCurrent: () => failure !== "host replaced" },
      warn: vi.fn(),
      runtime: {
        rollbackGatewayRestartSignalAdmission: () => true,
        prepareManagedServiceUpdateHandoffPark: async () => failure !== "busy",
        cancelManagedServiceUpdateHandoff: cancel,
      },
    });
    expect(allowed).toBe(false);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(owner);
  },
);
