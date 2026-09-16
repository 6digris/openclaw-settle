import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import type {
  GatewayDrainReason,
  GatewayShutdownTrigger,
} from "../../process/gateway-work-admission.js";
import type { createGatewayHostLifecycle } from "./host-lifecycle.js";

export type GatewayRunSignalAction = "stop" | "restart" | "external-restart";

export type GatewayRunSignalRequest = {
  action: GatewayRunSignalAction;
  signal: GatewayShutdownTrigger;
  restartReason?: string;
  restartIntent?: GatewayRestartIntent;
  hostedStop?: ReturnType<typeof createGatewayHostLifecycle>;
};

export function formatShutdownReason(request: GatewayRunSignalRequest): GatewayDrainReason {
  const { action, signal, restartReason } = request;
  const trigger =
    restartReason && restartReason !== signal
      ? (`${signal}: ${truncateUtf16Safe(restartReason.replaceAll(/\s+/g, " "), 200)}` as const)
      : signal;
  return `${action === "stop" ? "stop" : "restart"} (${trigger})`;
}

// Blocker descriptions can contain task identities and request origins.
export function formatDrainCounts(snapshot: GatewayActiveWorkSnapshot): string {
  return Object.entries(snapshot.counts)
    .filter(([name, count]) => name !== "totalActive" && count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
}

export function isUpdateProcessRestartReason(reason: string | undefined): boolean {
  return reason === "update.run" || reason === "update.auto";
}

export const sameManagedUpdateOwner = (
  left: GatewayRestartIntent["successorOwner"],
  right: GatewayRestartIntent["successorOwner"],
) =>
  Boolean(
    left && right && left.handoffId === right.handoffId && left.installRoot === right.installRoot,
  );
