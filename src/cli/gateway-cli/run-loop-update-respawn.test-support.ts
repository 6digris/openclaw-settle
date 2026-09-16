/** Registers update replacement and handoff cases in the run-loop signal fixture. */
import { EventEmitter } from "node:events";
import { withTimeout } from "@openclaw/fs-safe/advanced";
import { expect, it, vi, type Mock } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayServer } from "../../gateway/server-public.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";

type ManagedUpdateOwner = NonNullable<GatewayRestartIntent["successorOwner"]>;
type GatewayStart = Parameters<typeof import("./run-loop.js").runGatewayLoop>[0]["start"];
type ExitRuntime = { log: Mock; error: Mock; exit: Mock<(code: number) => void> };
type UpdateRespawnFixtures = {
  peekGatewaySigusr1RestartReason: Mock<() => string | undefined>;
  respawnGatewayProcessForUpdate: Mock<
    (opts?: { env?: NodeJS.ProcessEnv }) => {
      mode: "spawned" | "disabled" | "failed";
      pid?: number;
      detail?: string;
      child?: { kill: () => void };
    }
  >;
  restartGatewayProcessWithFreshPid: Mock<
    (opts?: { env?: NodeJS.ProcessEnv }) => {
      mode: "supervised" | "disabled" | "failed";
      detail?: string;
      exitCode?: number;
      handoffSpawned?: Promise<boolean>;
    }
  >;
  withIsolatedSignals: (
    run: (helpers: {
      captureSignal: (signal: "SIGTERM" | "SIGINT" | "SIGUSR1") => () => void;
    }) => Promise<void>,
  ) => Promise<void>;
  createSignaledStart: (close: GatewayServer["close"]) => {
    start: Mock<GatewayStart>;
    started: Promise<void>;
  };
  createRuntimeWithExitSignal: () => { runtime: ExitRuntime; exited: Promise<number> };
  runLoopWithStart: (params: {
    start: Mock<GatewayStart>;
    runtime: ExitRuntime;
    lockPort?: number;
    waitForHealthyChild?: (port: number, pid?: number, host?: string) => Promise<boolean>;
  }) => Promise<unknown>;
  waitForStart: (started: Promise<void>) => Promise<void>;
  waitForLoopCondition: (predicate: () => boolean, message: string) => Promise<void>;
  createSignaledLoopHarness: () => Promise<{
    start: Mock<GatewayStart>;
    runtime: ExitRuntime;
    exited: Promise<number>;
  }>;
  markUpdateRestartSentinelFailure: Mock<(reason: string) => Promise<null>>;
  writeGatewayRestartHandoffSync: { mockReturnValueOnce: (value: null) => unknown };
  consumeGatewaySigusr1RestartIntent: Mock<() => GatewayRestartIntent | null>;
  managedUpdateSuccessorOwner: ManagedUpdateOwner;
  isForegroundUpdateHandoff: Mock<(identity: ManagedUpdateOwner) => boolean>;
  hasManagedProviderLocalServices: Mock<() => boolean>;
  stopManagedProviderLocalServices: Mock<() => Promise<void>>;
  cancelManagedServiceUpdateHandoff: Mock<
    (identity: ManagedUpdateOwner) => Promise<false | "restored-in-process" | "restart-after-exit">
  >;
  acquireGatewayLock: Mock<
    (opts?: { port?: number }) => Promise<{ release: Mock<() => Promise<void>> }>
  >;
  completeForegroundUpdateHandoffAfterClose: Mock<
    typeof import("../../infra/update-managed-service-handoff.js").completeForegroundUpdateHandoffAfterClose
  >;
  killProcessTree: Mock;
  consumeGatewayRestartIntentPayloadSync: Mock<
    () => { reason?: string; force?: boolean; waitMs?: number } | null
  >;
  commitManagedServiceUpdateHandoff: Mock<
    (identity: ManagedUpdateOwner, outcome?: "update" | "restore") => Promise<boolean>
  >;
  setPlatform: (platform: string) => void;
  expectRestartHandoffCall: (expected: {
    restartKind: "full-process" | "update-process";
    reason: string | undefined;
    supervisorMode: "external" | "launchd";
  }) => void;
  originalPlatformDescriptor: PropertyDescriptor | undefined;
};

export function registerUpdateRespawnTests({
  peekGatewaySigusr1RestartReason,
  respawnGatewayProcessForUpdate,
  restartGatewayProcessWithFreshPid,
  withIsolatedSignals,
  createSignaledStart,
  createRuntimeWithExitSignal,
  runLoopWithStart,
  waitForStart,
  waitForLoopCondition,
  createSignaledLoopHarness,
  markUpdateRestartSentinelFailure,
  writeGatewayRestartHandoffSync,
  consumeGatewaySigusr1RestartIntent,
  managedUpdateSuccessorOwner,
  isForegroundUpdateHandoff,
  hasManagedProviderLocalServices,
  stopManagedProviderLocalServices,
  cancelManagedServiceUpdateHandoff,
  acquireGatewayLock,
  completeForegroundUpdateHandoffAfterClose,
  killProcessTree,
  consumeGatewayRestartIntentPayloadSync,
  commitManagedServiceUpdateHandoff,
  setPlatform,
  expectRestartHandoffCall,
  originalPlatformDescriptor,
}: UpdateRespawnFixtures): void {
  it("hard-respawns update restarts and exits only after the replacement becomes healthy", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue("update.run");
    respawnGatewayProcessForUpdate.mockReturnValueOnce({
      mode: "spawned",
      pid: 7777,
      child: { kill: vi.fn() },
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const waitForHealthyChild = vi.fn(async () => true);
      const close = vi.fn(async () => {});
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      await runLoopWithStart({ start, runtime, lockPort: 18789, waitForHealthyChild });
      await waitForStart(started);
      const sigusr1 = captureSignal("SIGUSR1");

      sigusr1();

      await expect(exited).resolves.toBe(0);
      expect(waitForHealthyChild).toHaveBeenCalledWith(18789, 7777, "127.0.0.1");
      expect(respawnGatewayProcessForUpdate).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledTimes(1);
      expect(markUpdateRestartSentinelFailure).not.toHaveBeenCalled();
      expect(writeGatewayRestartHandoffSync).not.toHaveBeenCalled();
    });
  });

  it("joins cancellation before restoring unchanged runtime when foreground provider cleanup fails", async () => {
    const cancellation = createDeferred<"restored-in-process">();
    consumeGatewaySigusr1RestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: managedUpdateSuccessorOwner,
    });
    isForegroundUpdateHandoff.mockReturnValue(true);
    hasManagedProviderLocalServices.mockReturnValue(true);
    stopManagedProviderLocalServices.mockRejectedValueOnce(new Error("provider cleanup failed"));
    cancelManagedServiceUpdateHandoff.mockReturnValueOnce(cancellation.promise);
    const lockRelease = vi.fn(async () => {});
    acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, runtime, exited } = await createSignaledLoopHarness();
      const stop = captureSignal("SIGINT");
      try {
        captureSignal("SIGUSR1")();
        await waitForLoopCondition(
          () => cancelManagedServiceUpdateHandoff.mock.calls.length === 1,
          "failed provider cleanup did not cancel its updater",
        );
        expect(lockRelease).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledOnce();
        expect(completeForegroundUpdateHandoffAfterClose).not.toHaveBeenCalled();
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        cancellation.resolve("restored-in-process");
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "cancelled update did not restore the unchanged Gateway",
        );
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
        );
        expect(lockRelease).toHaveBeenCalledOnce();
        expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
        expect(completeForegroundUpdateHandoffAfterClose).not.toHaveBeenCalled();
        expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith(
          "restart-local-service-stop-failed",
        );
        stop();
        await expect(exited).resolves.toBe(0);
      } finally {
        cancellation.resolve("restored-in-process");
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        if (runtime.exit.mock.calls.length === 0) {
          stop();
        }
        await exited;
      }
    });
  });

  it.each([
    "healthy",
    "unsafe",
    "failed-spawn",
    "disabled",
    "unhealthy",
    "unresponsive",
    "exited",
  ] as const)(
    "joins the foreground updater before a fresh successor and never resumes migrated runtime: %s",
    async (outcome) => {
      const updater = createDeferred<{ respawn: boolean }>();
      consumeGatewaySigusr1RestartIntent.mockReturnValueOnce({
        reason: "update.run",
        successorOwner: managedUpdateSuccessorOwner,
      });
      isForegroundUpdateHandoff.mockReturnValue(true);
      completeForegroundUpdateHandoffAfterClose.mockReturnValueOnce(updater.promise);
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
      const respawnChild = Object.assign(new EventEmitter(), {
        pid: 7777,
        exitCode: outcome === "exited" ? 1 : null,
        signalCode: null,
        kill: vi.fn(),
      });
      const child =
        outcome === "unresponsive" || outcome === "exited" ? respawnChild : { kill: vi.fn() };
      killProcessTree.mockClear();
      respawnGatewayProcessForUpdate.mockReturnValueOnce(
        outcome === "failed-spawn"
          ? { mode: "failed", detail: "fixture failure" }
          : outcome === "disabled"
            ? { mode: "disabled" }
            : { mode: "spawned", pid: 7777, child },
      );
      hasManagedProviderLocalServices.mockReturnValue(true);
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn(async () => {});
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const waitForHealthyChild = vi.fn(async () => outcome === "healthy");
        await runLoopWithStart({ start, runtime, lockPort: 18789, waitForHealthyChild });
        await waitForStart(started);
        const stop = captureSignal("SIGINT");
        try {
          captureSignal("SIGUSR1")();
          await waitForLoopCondition(
            () => completeForegroundUpdateHandoffAfterClose.mock.calls.length === 1,
            "foreground updater did not receive its closed witness",
          );
          expect(close).toHaveBeenCalledOnce();
          expect(lockRelease).toHaveBeenCalledOnce();
          expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
          expect(runtime.exit).not.toHaveBeenCalled();
          const consumedIntents = consumeGatewayRestartIntentPayloadSync.mock.calls.length;
          captureSignal("SIGUSR1")();
          captureSignal("SIGTERM")();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(consumeGatewayRestartIntentPayloadSync).toHaveBeenCalledTimes(consumedIntents);
          updater.resolve({ respawn: outcome !== "unsafe" });
          await expect(withTimeout(exited, 4_000)).resolves.toBe(outcome === "healthy" ? 0 : 1);
          expect(start).toHaveBeenCalledOnce();
          expect(acquireGatewayLock).toHaveBeenCalledOnce();
          expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
          expect(commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
          expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
          expect(markUpdateRestartSentinelFailure).not.toHaveBeenCalled();
          expect(writeGatewayRestartHandoffSync).not.toHaveBeenCalled();
          if (outcome === "unsafe") {
            expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
          } else {
            expect(respawnGatewayProcessForUpdate).toHaveBeenCalledOnce();
          }
          if (outcome === "unhealthy") {
            expect(child.kill).toHaveBeenCalledOnce();
          }
          if (outcome === "unresponsive") {
            expect(killProcessTree).toHaveBeenCalledExactlyOnceWith(7777, {
              detached: true,
              graceMs: 1_000,
            });
            expect(respawnChild.listenerCount("exit")).toBe(0);
          }
          if (outcome === "exited") {
            expect(killProcessTree).not.toHaveBeenCalled();
          }
        } finally {
          respawnChild.emit("exit", 1, null);
          updater.resolve({ respawn: false });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          if (runtime.exit.mock.calls.length === 0) {
            stop();
          }
          await exited;
        }
      });
    },
  );

  it.each(["update.run", "update.auto"] as const)(
    "writes a handoff before exiting for supervised %s restarts",
    async (reason) => {
      vi.clearAllMocks();
      peekGatewaySigusr1RestartReason.mockReturnValue(reason);
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
      });
      try {
        setPlatform("freebsd");
        process.env.OPENCLAW_SUPERVISOR_MODE = "external";
        await withIsolatedSignals(async ({ captureSignal }) => {
          const { runtime, exited } = await createSignaledLoopHarness();
          const sigusr1 = captureSignal("SIGUSR1");

          sigusr1();

          await expect(exited).resolves.toBe(0);
          expect(runtime.exit).toHaveBeenCalledWith(0);
          expectRestartHandoffCall({
            restartKind: "update-process",
            reason,
            supervisorMode: "external",
          });
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        });
      } finally {
        delete process.env.OPENCLAW_SUPERVISOR_MODE;
        if (originalPlatformDescriptor) {
          Object.defineProperty(process, "platform", originalPlatformDescriptor);
        }
      }
    },
  );

  it("falls back in-process when a launchd update handoff fails to spawn", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue("update.run");
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
      handoffSpawned: Promise.resolve(false),
    });
    try {
      setPlatform("darwin");
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");
        const sigint = captureSignal("SIGINT");

        vi.useFakeTimers();
        sigusr1();
        await vi.advanceTimersByTimeAsync(1500);

        expect(start).toHaveBeenCalledTimes(2);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith(
          "restart-handoff-unavailable",
        );

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      vi.useRealTimers();
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("keeps running when an external update restart handoff cannot be persisted", async () => {
    vi.clearAllMocks();
    peekGatewaySigusr1RestartReason.mockReturnValue("update.run");
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
    });
    writeGatewayRestartHandoffSync.mockReturnValueOnce(null);

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const sigusr1 = captureSignal("SIGUSR1");
        const sigint = captureSignal("SIGINT");

        sigusr1();
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "external update handoff failure did not restart in-process",
        );

        expect(runtime.exit).not.toHaveBeenCalled();
        expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith(
          "restart-handoff-unavailable",
        );

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
    }
  });
}
