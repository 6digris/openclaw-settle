import { afterEach, describe, expect, it, vi } from "vitest";
import { startGatewayRuntimeGenerationMonitor } from "./runtime-generation-monitor.js";

const RUNTIME_GENERATION_CHANGED_RESTART_REASON = "runtime.generation.changed";

function createScheduledRestart() {
  return {
    ok: true,
    pid: process.pid,
    signal: "SIGUSR1" as const,
    delayMs: 0,
    reason: RUNTIME_GENERATION_CHANGED_RESTART_REASON,
    mode: "emit" as const,
    coalesced: false,
    cooldownMsApplied: 0,
    emitHooksQueued: false,
  };
}

describe("startGatewayRuntimeGenerationMonitor", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start without immutable loaded build provenance", () => {
    expect(
      startGatewayRuntimeGenerationMonitor({
        log: { info: vi.fn(), warn: vi.fn() },
        installRoot: "/openclaw",
        loadedBuildId: null,
      }),
    ).toBeNull();
  });

  it("ignores incomplete builds and schedules one restart for a completed new generation", async () => {
    vi.useFakeTimers();
    const readGeneration = vi
      .fn<(buildInfoPath: string) => Promise<{ buildId: string } | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ buildId: "build-a" })
      .mockResolvedValue({ buildId: "build-b" });
    const scheduleRestart = vi.fn(() => createScheduledRestart());
    const log = { info: vi.fn(), warn: vi.fn() };
    const monitor = startGatewayRuntimeGenerationMonitor({
      log,
      intervalMs: 100,
      installRoot: "/openclaw",
      loadedBuildId: "build-a",
      readGeneration,
      isInstallPending: vi.fn(async () => false),
      isActivationManual: vi.fn(async () => false),
      scheduleRestart,
      attemptedBuildIds: new Set(),
    });

    await vi.advanceTimersByTimeAsync(400);

    expect(readGeneration).toHaveBeenCalledWith("/openclaw/dist/build-info.json");
    expect(scheduleRestart).toHaveBeenCalledExactlyOnceWith({
      delayMs: 0,
      preservePendingEmitHooksOnDeferralBypass: true,
      reason: RUNTIME_GENERATION_CHANGED_RESTART_REASON,
      skipCooldown: true,
    });
    expect(log.info).toHaveBeenCalledWith(
      "runtime generation changed (build-a -> build-b); scheduling fresh-process restart",
    );

    await vi.advanceTimersByTimeAsync(400);
    expect(scheduleRestart).toHaveBeenCalledTimes(1);
    await monitor?.stop();
  });

  it("does not schedule after stop while a read is in flight", async () => {
    vi.useFakeTimers();
    let resolveRead: ((value: { buildId: string } | null) => void) | undefined;
    const readGeneration = vi.fn(
      () =>
        new Promise<{ buildId: string } | null>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const scheduleRestart = vi.fn(() => createScheduledRestart());
    const monitor = startGatewayRuntimeGenerationMonitor({
      log: { info: vi.fn(), warn: vi.fn() },
      intervalMs: 100,
      installRoot: "/openclaw",
      loadedBuildId: "build-a",
      readGeneration,
      isInstallPending: vi.fn(async () => false),
      scheduleRestart,
      attemptedBuildIds: new Set(),
    });

    await vi.advanceTimersByTimeAsync(100);
    const stopped = monitor?.stop();
    resolveRead?.({ buildId: "build-b" });
    await stopped;

    expect(scheduleRestart).not.toHaveBeenCalled();
  });

  it("does not schedule after stop while the stable generation probe is in flight", async () => {
    vi.useFakeTimers();
    let resolveInstallPending: ((value: boolean) => void) | undefined;
    const isInstallPending = vi
      .fn<(installRoot: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveInstallPending = resolve;
          }),
      );
    const scheduleRestart = vi.fn(() => createScheduledRestart());
    const monitor = startGatewayRuntimeGenerationMonitor({
      log: { info: vi.fn(), warn: vi.fn() },
      intervalMs: 100,
      installRoot: "/openclaw",
      loadedBuildId: "build-a",
      readGeneration: vi.fn(async () => ({ buildId: "build-b" })),
      isInstallPending,
      isActivationManual: vi.fn(async () => false),
      scheduleRestart,
      attemptedBuildIds: new Set(),
    });

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(isInstallPending).toHaveBeenCalledTimes(2);
    const stopped = monitor?.stop();
    resolveInstallPending?.(false);
    await stopped;

    expect(scheduleRestart).not.toHaveBeenCalled();
  });

  it("does not schedule after stop while the activation-policy probe is in flight", async () => {
    vi.useFakeTimers();
    let resolveActivation: ((value: boolean) => void) | undefined;
    const isActivationManual = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveActivation = resolve;
        }),
    );
    const scheduleRestart = vi.fn(() => createScheduledRestart());
    const monitor = startGatewayRuntimeGenerationMonitor({
      log: { info: vi.fn(), warn: vi.fn() },
      intervalMs: 100,
      installRoot: "/openclaw",
      loadedBuildId: "build-a",
      readGeneration: vi.fn(async () => ({ buildId: "build-b" })),
      isInstallPending: vi.fn(async () => false),
      isActivationManual,
      scheduleRestart,
      attemptedBuildIds: new Set(),
    });

    await vi.advanceTimersByTimeAsync(200);
    const stopped = monitor?.stop();
    resolveActivation?.(false);
    await stopped;

    expect(scheduleRestart).not.toHaveBeenCalled();
  });

  it("requires an external restart when an unmanaged container cannot preserve its owner", async () => {
    vi.useFakeTimers();
    const scheduleRestart = vi.fn(() => createScheduledRestart());
    const log = { info: vi.fn(), warn: vi.fn() };
    const monitor = startGatewayRuntimeGenerationMonitor({
      log,
      intervalMs: 100,
      installRoot: "/openclaw",
      loadedBuildId: "build-a",
      readGeneration: vi.fn(async () => ({ buildId: "build-b" })),
      isInstallPending: vi.fn(async () => false),
      isActivationManual: vi.fn(async () => false),
      canScheduleAutomaticRestart: () => false,
      scheduleRestart,
      attemptedBuildIds: new Set(),
    });

    await vi.advanceTimersByTimeAsync(200);

    expect(scheduleRestart).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      "runtime generation build-b requires an external container restart",
    );
    await monitor?.stop();
  });

  it("honors manual activation and bounds retries across monitor lifecycles", async () => {
    vi.useFakeTimers();
    const scheduleRestart = vi.fn(() => createScheduledRestart());
    const attemptedBuildIds = new Set<string>();
    const log = { info: vi.fn(), warn: vi.fn() };
    const createMonitor = (manual = false) =>
      startGatewayRuntimeGenerationMonitor({
        log,
        intervalMs: 100,
        installRoot: "/openclaw",
        loadedBuildId: "build-a",
        readGeneration: vi.fn(async () => ({ buildId: "build-b" })),
        isInstallPending: vi.fn(async () => false),
        isActivationManual: vi.fn(async () => manual),
        scheduleRestart,
        attemptedBuildIds,
      });

    const manual = createMonitor(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(scheduleRestart).not.toHaveBeenCalled();
    await manual?.stop();

    const firstAttempt = createMonitor();
    await vi.advanceTimersByTimeAsync(200);
    expect(scheduleRestart).toHaveBeenCalledTimes(1);
    await firstAttempt?.stop();

    const inProcessSuccessor = createMonitor();
    await vi.advanceTimersByTimeAsync(200);
    expect(scheduleRestart).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "runtime generation build-b still requires a fresh process; run openclaw gateway restart",
    );
    await inProcessSuccessor?.stop();
  });

  it("waits for package lifecycle completion before scheduling a stable generation", async () => {
    vi.useFakeTimers();
    const isInstallPending = vi
      .fn<(installRoot: string) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const scheduleRestart = vi.fn(() => createScheduledRestart());
    const monitor = startGatewayRuntimeGenerationMonitor({
      log: { info: vi.fn(), warn: vi.fn() },
      intervalMs: 100,
      installRoot: "/openclaw",
      loadedBuildId: "build-a",
      readGeneration: vi.fn(async () => ({ buildId: "build-b" })),
      isInstallPending,
      isActivationManual: vi.fn(async () => false),
      scheduleRestart,
      attemptedBuildIds: new Set(),
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(isInstallPending).toHaveBeenCalledWith("/openclaw");
    expect(scheduleRestart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(scheduleRestart).toHaveBeenCalledTimes(1);
    await monitor?.stop();
  });
});
