// Restart readiness consumes live service-instance health without requiring another boot.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  createPluginServiceHealthReporter,
  listPluginServiceHealthFailures,
} from "../../plugins/service-health.js";
import {
  callGateway,
  inspectPortUsage,
  makeGatewayService,
  mockGatewayLockReplacement,
  monotonicClock,
  resetRestartHealthMocks,
  restoreRestartHealthMocks,
  sleep,
} from "./restart-health.test-helpers.js";

describe("restart service-health recovery", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

  it.each([
    { mode: "managed", recovers: true },
    { mode: "managed", recovers: false },
    { mode: "external", recovers: true },
    { mode: "external", recovers: false },
  ])("$mode waits for same-instance service recovery=$recovers", async ({ mode, recovers }) => {
    const registry = createEmptyPluginRegistry();
    const registration = {
      pluginId: "background-service",
      source: "test",
      origin: "bundled" as const,
      service: { id: "background-service", start: () => {} },
    };
    registry.services.push(registration);
    const reporter = createPluginServiceHealthReporter(registration);
    reporter.health.reportFailure(new Error("temporary connection failure"));
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4300, commandLine: "openclaw-gateway" }],
      hints: [],
    });
    let probes = 0;
    callGateway.mockImplementation(async (options) => {
      // Recovery belongs to the original reporter, not a replacement Gateway or registry.
      if (recovers && probes++ > 0) {
        reporter.health.clearFailure();
      }
      return gatewayHealthResponse({
        server: { version: "2026.9.4", bootId: "unchanged-boot" },
        health: {
          ok: true,
          plugins: {
            errors: listPluginServiceHealthFailures(registry).map((failure) => ({
              id: failure.pluginId,
              origin: failure.origin,
              activated: true,
              failurePhase: "service",
              error: failure.error,
            })),
            unavailable: [],
          },
        },
      })(options);
    });
    const { waitForGatewayHealthyListener, waitForGatewayHealthyRestart } =
      await import("./restart-health.js");
    const params = { port: 18789, includePluginHealth: true, attempts: 3, delayMs: 500 };
    const snapshot =
      mode === "managed"
        ? await waitForGatewayHealthyRestart({
            ...params,
            service: makeGatewayService({ status: "running", pid: 4300 }),
            requireRunningService: true,
            includeChannelHealth: false,
          })
        : await waitForGatewayHealthyListener({
            ...params,
            previousLockIdentity: mockGatewayLockReplacement({ pid: 4300 }),
          });
    expect(snapshot.healthy).toBe(recovers);
    expect(callGateway).toHaveBeenCalledTimes(recovers ? 2 : mode === "managed" ? 4 : 3);
    expect(monotonicClock.nowMs).toBe(recovers ? (mode === "managed" ? 500 : 1000) : 1500);
    expect(sleep).toHaveBeenCalled();
    if (!recovers) {
      expect(snapshot.activatedPluginErrors).toEqual([
        expect.objectContaining({ id: "background-service", failurePhase: "service" }),
      ]);
      if (mode === "managed") {
        expect(snapshot).toMatchObject({ waitOutcome: "plugin-errors" });
      }
    }
    reporter.revoke();
  });
});
