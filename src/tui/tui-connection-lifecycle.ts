import { classifyGatewayConnectFailure } from "../../packages/gateway-protocol/src/connect-error-details.js";

export function resolveGatewayDisconnectState(
  input: {
    details?: unknown;
    reason?: string | null;
  } = {},
): {
  connectionStatus: string;
  activityStatus: string;
  remediation?: string;
} {
  if (input.reason === "gateway starting") {
    return {
      connectionStatus: "gateway starting",
      activityStatus: "starting up",
    };
  }
  const failure = classifyGatewayConnectFailure(input);
  const reasonLabel =
    failure.userMessage === "gateway unreachable" ? "closed" : failure.userMessage;
  if (failure.kind === "pairing-required") {
    return {
      connectionStatus: `gateway disconnected: ${reasonLabel}`,
      activityStatus: "device approval needed: preview latest request",
      remediation: failure.remediation,
    };
  }
  if (failure.kind === "rate-limited") {
    return {
      connectionStatus: `gateway disconnected: ${reasonLabel}`,
      activityStatus: "gateway authentication temporarily rate-limited",
      remediation: failure.remediation,
    };
  }
  if (failure.kind === "identity-proxy") {
    return {
      connectionStatus: `gateway disconnected: ${reasonLabel}`,
      activityStatus: "identity-aware proxy rejected connection",
      remediation: failure.remediation,
    };
  }
  return {
    connectionStatus: `gateway disconnected: ${reasonLabel}`,
    activityStatus: failure.remediation ? "gateway authentication needs attention" : "idle",
    remediation: failure.remediation,
  };
}

export function createTuiConnectionLineage() {
  let hasConnected = false;
  let wasDisconnected = false;
  return {
    connect: () => {
      const reconnected = wasDisconnected;
      hasConnected = true;
      wasDisconnected = false;
      return reconnected;
    },
    disconnect: () => {
      if (hasConnected) {
        wasDisconnected = true;
      }
    },
    wasDisconnected: () => wasDisconnected,
  };
}
