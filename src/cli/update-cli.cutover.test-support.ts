import { expect } from "vitest";
import type { CallGatewayOptions } from "../gateway/call.js";

/** Extend the health double with main's preserve-only, generation-bound cutover RPCs. */
export function withUpdateCutoverResponses(
  health: (options: CallGatewayOptions) => Promise<unknown>,
  pid: number,
) {
  const processInstanceId = `update-fixture-${pid}`;
  const suspensionId = `cutover-fixture-${pid}`;
  let requested = false;
  return async (options: CallGatewayOptions): Promise<unknown> => {
    const response = await health(options);
    if (options.method !== "system.info" && !options.method.startsWith("gateway.suspend.")) {
      return response;
    }
    options.assertDispatchCurrent?.();
    if (options.method === "system.info") {
      return { pid, processInstanceId };
    }
    if (options.method === "gateway.suspend.prepare") {
      expect(options.params).toMatchObject({ terminalPolicy: "preserve" });
      requested = true;
      return {
        status: "ready",
        suspensionId,
        expiresAtMs: Date.now() + 60_000,
        activeCount: 0,
        blockers: [],
        writeCustody: [],
      };
    }
    expect(requested).toBe(true);
    expect(options.params).toMatchObject({ suspensionId });
    if (options.method === "gateway.suspend.status") {
      return { status: "ready" };
    }
    if (options.method === "gateway.suspend.handoff") {
      expect(options.params).toMatchObject({ target: { pid, processInstanceId } });
      return { status: "armed" };
    }
    if (options.method === "gateway.suspend.resume") {
      requested = false;
      return { ok: true, status: "running", resumed: true };
    }
    throw new Error(`Unexpected cutover fixture method: ${options.method}`);
  };
}
