import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayService } from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import {
  callGateway,
  inspectPortUsage,
  monotonicClock,
  readActiveGatewayLockIdentity,
  readGatewayOwnerLease,
  requestStartupProbe,
  resetRestartHealthMocks,
  resolveGatewayProbeAuthSafeWithSecretInputs,
  restoreRestartHealthMocks,
} from "./restart-health.test-helpers.js";

const { readRuntime, readCommand } = vi.hoisted(() => ({
  readCommand: vi.fn<GatewayService["readCommand"]>(),
  readRuntime: vi.fn<GatewayService["readRuntime"]>(),
}));
vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readRuntime, readCommand }),
}));
const { waitForGatewayDiagnosticReadiness } = await import("./diagnostic-readiness.js");

describe("diagnostic Gateway readiness", () => {
  beforeEach(() => {
    resetRestartHealthMocks();
    inspectPortUsage.mockImplementation(async (port) => ({
      port,
      status: "free",
      listeners: [],
      hints: [],
    }));
    readRuntime.mockReset();
    readRuntime.mockResolvedValue({ status: "stopped" });
    readCommand.mockReset();
    readCommand.mockResolvedValue({ programArguments: ["gateway", "--port", "18789"] });
    vi.stubEnv("OPENCLAW_GATEWAY_URL", undefined);
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", undefined);
  });
  afterEach(() => {
    restoreRestartHealthMocks();
    vi.unstubAllEnvs();
  });

  it.each<{ envUrl?: string; url?: string; config?: OpenClawConfig }>([
    { url: "ws://127.0.0.1:18789" },
    { config: { gateway: { mode: "remote", remote: { url: "wss://peer.example" } } } },
    { envUrl: "wss://peer.example" },
  ])("preserves an explicit or remote target: %j", async ({ envUrl, ...options }) => {
    if (envUrl) {
      vi.stubEnv("OPENCLAW_GATEWAY_URL", envUrl);
    }
    await expect(
      waitForGatewayDiagnosticReadiness({ config: {}, ...options }),
    ).resolves.toBeUndefined();
    expect(inspectPortUsage).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("defers to original diagnostic authentication when no shared credential is available", async () => {
    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "token" } } },
    });
    expect(result).toBeUndefined();
    expect(monotonicClock.nowMs).toBe(0);
    expect(readRuntime).not.toHaveBeenCalled();
    expect(inspectPortUsage).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it.each([22_000, 61_000])(
    "charges %d ms of authentication preparation to the caller's absolute deadline",
    async (authElapsedMs) => {
      resolveGatewayProbeAuthSafeWithSecretInputs.mockImplementation(async () => {
        monotonicClock.nowMs += authElapsedMs;
        return { auth: { token: "fixture-token" } };
      });
      readGatewayOwnerLease.mockReturnValue({
        owner: "fixture-owner",
        pid: 8000,
        host: "fixture-host",
        startedAt: 1,
        port: 18789,
        mode: "foreground",
        supervisor: null,
        state: "live",
        expired: false,
      });

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "token" } } },
        timeoutMs: 60_000,
        deadlineMs: 60_000,
      });

      expect(result).toMatchObject({
        healthy: false,
        waitOutcome: "timeout",
        elapsedMs: Math.max(0, 60_000 - authElapsedMs),
      });
      expect(monotonicClock.nowMs).toBe(Math.max(60_000, authElapsedMs));
      expect(callGateway).not.toHaveBeenCalled();
      if (authElapsedMs >= 60_000) {
        expect(inspectPortUsage).not.toHaveBeenCalled();
        expect(result?.probeError).toBe("Gateway readiness budget exhausted.");
      }
    },
  );

  it.each(
    [
      { timeoutMs: 20_000, ownerAppearsDuringProbe: false },
      { timeoutMs: 7_500, ownerAppearsDuringProbe: false },
      { timeoutMs: 20_000, ownerAppearsDuringProbe: true },
      { timeoutMs: 7_500, ownerAppearsDuringProbe: true },
    ].flatMap(({ timeoutMs, ownerAppearsDuringProbe }) =>
      ["lease", "legacy lock"].map((ownerKind) => ({
        timeoutMs,
        ownerAppearsDuringProbe,
        ownerKind,
      })),
    ),
  )(
    "observes $ownerKind foreground startup within $timeoutMs ms (owner appears during probe: $ownerAppearsDuringProbe)",
    async ({ timeoutMs, ownerAppearsDuringProbe, ownerKind }) => {
      const config: OpenClawConfig = { gateway: { port: 19091, auth: { mode: "token" } } };
      resolveGatewayProbeAuthSafeWithSecretInputs.mockResolvedValue({
        auth: { token: "fixture-token" },
      });
      const owner = {
        owner: "fixture-owner",
        pid: 8000,
        host: "fixture-host",
        startedAt: 1,
        port: 19091,
        mode: "foreground" as const,
        supervisor: null,
        state: "live" as const,
        expired: false,
      };
      const publishOwner = () => {
        if (ownerKind === "lease") {
          readGatewayOwnerLease.mockReturnValue(owner);
        } else {
          readActiveGatewayLockIdentity.mockResolvedValue({
            pid: owner.pid,
            port: owner.port,
            createdAt: "2026-09-01T00:00:00.000Z",
          });
        }
      };
      if (ownerAppearsDuringProbe) {
        readCommand.mockResolvedValue(null);
        inspectPortUsage.mockImplementationOnce(async (port) => {
          publishOwner();
          return { port, status: "free", listeners: [], hints: [] };
        });
      } else {
        publishOwner();
      }
      inspectPortUsage.mockImplementation(async (port) => {
        const listening = ownerKind !== "legacy lock" || monotonicClock.nowMs >= 1_000;
        return {
          port,
          status: listening ? "busy" : "free",
          listeners: listening ? [{ pid: 8000 }] : [],
          hints: [],
        };
      });
      requestStartupProbe.mockImplementation(async () => ({
        statusCode: monotonicClock.nowMs < 20_000 ? 503 : 200,
        body: JSON.stringify(
          monotonicClock.nowMs < 20_000
            ? { status: "starting", pendingReason: "plugin-convergence" }
            : { status: "started" },
        ),
      }));
      callGateway.mockImplementation(gatewayHealthResponse());
      const result = await waitForGatewayDiagnosticReadiness({
        config,
        token: "fixture-token",
        timeoutMs,
      });
      expect(result).toMatchObject({
        healthy: timeoutMs === 20_000,
        waitOutcome: timeoutMs === 20_000 ? "healthy" : "still-starting",
        elapsedMs: timeoutMs,
        runtime: { status: "running", pid: 8000 },
        portUsage: { port: 19091 },
      });
      expect(readRuntime).not.toHaveBeenCalled();
      if (timeoutMs === 20_000) {
        expect(callGateway).toHaveBeenCalledWith(
          expect.objectContaining({ config, token: "fixture-token", localPortOverride: 19091 }),
        );
      } else {
        expect(result?.startupPhase).toBe("plugin-convergence");
        expect(callGateway).not.toHaveBeenCalled();
      }
    },
  );

  it("caps service inspection by an explicit timeout before a later deadline", async () => {
    readRuntime.mockImplementation(async (_env, options) => {
      monotonicClock.nowMs += options?.timeoutMs ?? 0;
      return { status: "stopped" };
    });

    await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
      timeoutMs: 1_250,
      deadlineMs: 60_000,
    });

    expect(monotonicClock.nowMs).toBe(1_250);
  });

  it("waits for a legacy replacement after an observed owner lease dies", async () => {
    let leasePublished = false;
    readCommand.mockResolvedValue(null);
    readGatewayOwnerLease.mockImplementation(() =>
      leasePublished
        ? {
            owner: "previous-owner",
            pid: 8000,
            host: "fixture-host",
            startedAt: 1,
            port: 18789,
            mode: "foreground",
            supervisor: null,
            state: monotonicClock.nowMs === 0 ? "live" : "dead",
            expired: false,
          }
        : undefined,
    );
    inspectPortUsage.mockImplementation(async (port) => {
      if (monotonicClock.nowMs === 0) {
        leasePublished = true;
      } else {
        readActiveGatewayLockIdentity.mockResolvedValue({
          pid: 9000,
          port,
          createdAt: "2026-09-01T00:00:00.000Z",
        });
      }
      const listening = monotonicClock.nowMs >= 1_000;
      return {
        port,
        status: listening ? "busy" : "free",
        listeners: listening ? [{ pid: 9000 }] : [],
        hints: [],
      };
    });
    requestStartupProbe.mockResolvedValue({ statusCode: 200, body: '{"status":"started"}' });
    callGateway.mockImplementation(gatewayHealthResponse());

    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      healthy: true,
      waitOutcome: "healthy",
      elapsedMs: 1_000,
      runtime: { status: "running", pid: 9000 },
    });
  });

  it.each(["service-command", "legacy lock", "late legacy lock"])(
    "retains startup grace when %s lookup fails",
    async (source) => {
      const error = new Error("owner lookup unavailable");
      if (source === "service-command") {
        readCommand.mockRejectedValue(error);
      } else {
        readCommand.mockResolvedValue(null);
        readActiveGatewayLockIdentity.mockRejectedValue(error);
        if (source === "late legacy lock") {
          readActiveGatewayLockIdentity.mockResolvedValueOnce(undefined);
        }
      }

      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_250,
      });

      expect(result).toMatchObject({ waitOutcome: "timeout", elapsedMs: 1_250 });
    },
  );

  it("preserves uncertain command cleanup from the initial runtime inspection", async () => {
    const error = new CommandProcessCleanupError();
    readRuntime.mockRejectedValueOnce(error);

    await expect(
      waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_250,
      }),
    ).rejects.toBe(error);
  });

  it.each([null, { programArguments: ["gateway", "--port", "18789"] }])(
    "does not wait for an absent Gateway without a matching installed service: %j",
    async (command) => {
      readCommand.mockResolvedValue(command);
      readRuntime.mockResolvedValueOnce({ status: "running" });
      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        localPortOverride: 19092,
        timeoutMs: 60_000,
      });
      expect(result).toBeUndefined();
      expect(monotonicClock.nowMs).toBe(0);
      expect(readRuntime).not.toHaveBeenCalled();
    },
  );

  it("still probes an unowned listener without an installed service", async () => {
    readCommand.mockResolvedValue(null);
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 8000 }],
      hints: [],
    });
    callGateway.mockImplementation(gatewayHealthResponse());

    const result = await waitForGatewayDiagnosticReadiness({
      config: { gateway: { auth: { mode: "none" } } },
    });

    expect(result).toMatchObject({ healthy: true, waitOutcome: "healthy" });
    expect(monotonicClock.nowMs).toBe(0);
  });

  it.each(["stopped", "unknown"])(
    "bounds a %s installed Gateway with the caller's shorter deadline",
    async (status) => {
      readRuntime.mockResolvedValue({ status });
      const result = await waitForGatewayDiagnosticReadiness({
        config: { gateway: { auth: { mode: "none" } } },
        timeoutMs: 1_250,
      });
      expect(result).toMatchObject({
        healthy: false,
        waitOutcome: "timeout",
        elapsedMs: 1_250,
        portUsage: { status: "free" },
      });
      expect(callGateway).not.toHaveBeenCalled();
    },
  );
});
