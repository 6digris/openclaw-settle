import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayRequestContext, GatewayRequestHandler, RespondFn } from "./types.js";

/** Observe the RPC event, including calls made before observation was installed. */
export async function waitForApprovalRequested(
  broadcast: GatewayRequestContext["broadcast"],
  eventName: string,
  request: ReturnType<GatewayRequestHandler>,
): Promise<void> {
  const mock = vi.mocked(broadcast);
  const observed = createDeferred();
  const implementation = mock.getMockImplementation();
  mock.mockImplementation((...args) => {
    implementation?.(...args);
    if (args[0] === eventName) {
      observed.resolve();
    }
  });
  try {
    if (mock.mock.calls.some(([event]) => event === eventName)) {
      observed.resolve();
    }
    await Promise.race([
      observed.promise,
      Promise.resolve(request).then(() => {
        throw new Error("Approval request completed before the expected RPC event");
      }),
    ]);
  } finally {
    mock.mockImplementation(implementation ?? (() => {}));
  }
}

/** Join the real two-phase acceptance response, not a polling deadline or decision. */
export async function waitForApprovalAccepted(
  respond: RespondFn,
  request: ReturnType<GatewayRequestHandler>,
): Promise<void> {
  const mock = vi.mocked(respond);
  const observed = createDeferred();
  const implementation = mock.getMockImplementation();
  const accepted = (ok: boolean, payload: unknown) =>
    ok && isRecord(payload) && payload.status === "accepted";
  mock.mockImplementation((...args) => {
    implementation?.(...args);
    if (accepted(args[0], args[1])) {
      observed.resolve();
    }
  });
  try {
    if (mock.mock.calls.some(([ok, payload]) => accepted(ok, payload))) {
      observed.resolve();
    }
    await Promise.race([
      observed.promise,
      Promise.resolve(request).then(() => {
        throw new Error("Approval request completed before acceptance");
      }),
    ]);
  } finally {
    mock.mockImplementation(implementation ?? (() => {}));
  }
}
