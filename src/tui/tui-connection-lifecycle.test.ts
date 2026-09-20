import { describe, expect, it } from "vitest";
import {
  createTuiConnectionLineage,
  resolveGatewayDisconnectState,
} from "./tui-connection-lifecycle.js";

describe("resolveGatewayDisconnectState", () => {
  it("shows startup progress while the gateway keeps retrying", () => {
    expect(resolveGatewayDisconnectState({ reason: "gateway starting" })).toEqual({
      connectionStatus: "gateway starting",
      activityStatus: "starting up",
    });
  });

  it("returns scope-upgrade recovery guidance when disconnect reason requires pairing", () => {
    const state = resolveGatewayDisconnectState({
      reason: "gateway closed (1008): pairing required",
    });
    expect(state.connectionStatus).toContain("pairing required");
    expect(state.activityStatus).toBe("device approval needed: preview latest request");
    expect(state.remediation).toContain("openclaw devices approve --latest");
    expect(state.remediation).toContain("openclaw devices approve <requestId>");
    expect(state.remediation).toContain("--url");
    expect(state.remediation).toContain("--token/--password");
    // Must steer users to `devices`, not the unrelated chat-DM `pairing` command.
    expect(state.remediation).not.toContain("openclaw pairing");
  });

  it("uses structured pairing details before the generic close reason", () => {
    const state = resolveGatewayDisconnectState({
      details: { code: "PAIRING_REQUIRED", reason: "scope-upgrade" },
      reason: "connect failed",
    });
    expect(state.activityStatus).toBe("device approval needed: preview latest request");
    expect(state.connectionStatus).toContain("scope upgrade pending approval");
    expect(state.remediation).toContain("openclaw devices approve --latest");
  });

  it("shows the device-token rotation command for structured token mismatch", () => {
    const state = resolveGatewayDisconnectState({
      details: { code: "AUTH_DEVICE_TOKEN_MISMATCH" },
      reason: "device token mismatch",
    });
    expect(state.activityStatus).toBe("gateway authentication needs attention");
    expect(state.remediation).toContain(
      "openclaw devices rotate --device <deviceId> --role operator",
    );
  });

  it("shows wait-and-retry guidance for a temporary authentication lockout", () => {
    const state = resolveGatewayDisconnectState({
      details: { code: "AUTH_RATE_LIMITED" },
      reason: "unauthorized: too many failed authentication attempts (retry later)",
    });
    expect(state.activityStatus).toBe("gateway authentication temporarily rate-limited");
    expect(state.remediation).toContain("temporary authentication lockout");
    expect(state.remediation).not.toContain("gateway.remote.token");
    expect(state.remediation).not.toContain("devices rotate");
  });

  it("shows edge-auth guidance for an identity-proxy rejection", () => {
    const state = resolveGatewayDisconnectState({
      details: { reason: "websocket-upgrade-rejected", httpStatus: 302 },
      reason: "gateway rejected websocket upgrade (HTTP 302)",
    });
    expect(state.activityStatus).toBe("identity-aware proxy rejected connection");
    expect(state.remediation).toContain("gateway.remote.edgeAuth");
  });

  it("falls back to idle for generic disconnect reasons", () => {
    const state = resolveGatewayDisconnectState({ reason: "network timeout" });
    expect(state.connectionStatus).toBe("gateway disconnected: network timeout");
    expect(state.activityStatus).toBe("idle");
    expect(state.remediation).toBeUndefined();
  });
});

describe("createTuiConnectionLineage", () => {
  it("keeps a startup retry before the first hello out of reconnect recovery", () => {
    const lineage = createTuiConnectionLineage();

    lineage.disconnect();
    expect(lineage.wasDisconnected()).toBe(false);
    expect(lineage.connect()).toBe(false);

    lineage.disconnect();
    expect(lineage.wasDisconnected()).toBe(true);
    expect(lineage.connect()).toBe(true);
  });
});
