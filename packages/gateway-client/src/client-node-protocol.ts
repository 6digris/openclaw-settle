import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "@openclaw/gateway-protocol/client-info";
import { MIN_NODE_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import type { GatewayClientOptions } from "./client.js";

export function resolveLegacyNodePlatform(platform: string): string | undefined {
  switch (platform) {
    case "macos":
      return "darwin";
    case "windows":
      return "win32";
    default:
      return undefined;
  }
}

export function shouldNegotiateLegacyNodeProtocol(
  options: Pick<
    GatewayClientOptions,
    "role" | "mode" | "clientName" | "minProtocol" | "maxProtocol"
  >,
): boolean {
  if (
    options.role !== "node" ||
    options.mode !== GATEWAY_CLIENT_MODES.NODE ||
    options.clientName !== GATEWAY_CLIENT_NAMES.NODE_HOST
  ) {
    return false;
  }
  return (
    (options.minProtocol ?? MIN_NODE_PROTOCOL_VERSION) === MIN_NODE_PROTOCOL_VERSION &&
    (options.maxProtocol ?? PROTOCOL_VERSION) === PROTOCOL_VERSION
  );
}
