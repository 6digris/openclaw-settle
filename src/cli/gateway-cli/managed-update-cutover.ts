// Converts a reversible restart-signal fence into prepared update ownership, before host retirement.
import {
  consumeGatewaySuspendHandoff,
  type GatewaySuspendHandoffOwner,
} from "../../infra/gateway-suspend-coordinator.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
type GatewayLifecycleRuntime = typeof import("./lifecycle.runtime.js");

export const sameManagedUpdateOwner = (
  left: GatewayRestartIntent["successorOwner"],
  right: GatewayRestartIntent["successorOwner"],
) =>
  Boolean(
    left && right && left.handoffId === right.handoffId && left.installRoot === right.installRoot,
  );

export async function prepareGatewayManagedUpdateRestart(params: {
  intent: GatewayRestartIntent | null;
  host: GatewaySuspendHandoffOwner | undefined;
  runtime: Pick<
    GatewayLifecycleRuntime,
    | "prepareManagedServiceUpdateHandoffPark"
    | "cancelManagedServiceUpdateHandoff"
    | "rollbackGatewayRestartSignalAdmission"
  >;
  warn: (message: string) => void;
}): Promise<boolean> {
  const owner = params.intent?.successorOwner;
  if (!owner) {
    return true;
  }
  // The signal fence is reversible; the suspension coordinator acquires its own
  // admission hold. Do not retire the host or abort active work to acquire it.
  params.runtime.rollbackGatewayRestartSignalAdmission();
  try {
    if (
      !params.host?.isCurrent() ||
      !(await params.runtime.prepareManagedServiceUpdateHandoffPark(owner))
    ) {
      throw new Error("serving Gateway cannot prepare the managed update");
    }
    const consumed = consumeGatewaySuspendHandoff(params.host);
    if (!consumed.ok || !consumed.value) {
      throw new Error("prepared update authority changed before drain");
    }
    return true;
  } catch (error) {
    const cancelled = await params.runtime.cancelManagedServiceUpdateHandoff(owner);
    params.warn(
      `Update deferred before restart drain: ${String(error)}; helper cancellation: ${String(cancelled)}`,
    );
    return false;
  }
}
