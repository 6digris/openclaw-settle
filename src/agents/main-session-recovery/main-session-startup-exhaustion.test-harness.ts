import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import {
  replaceSessionEntry,
  type loadSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { SessionEntryFixture } from "../subagent-test-fixtures.test-helpers.js";
import { scheduleRestartAbortedMainSessionRecovery } from "./main-session-restart-recovery.js";

type StartupExhaustionFixture = {
  tmpDir: string;
  gatewayRuntime: GatewayRecoveryRuntime;
  loadSessionEntry: (scope: Parameters<typeof loadSessionEntry>[0]) => SessionEntry | undefined;
  makeMainSessionFixture: (
    overrides: SessionEntryFixture & { agentId?: string; sessionKey?: string },
  ) => Promise<{ storePath: string }>;
  makePendingFinalDelivery: () => NonNullable<SessionEntry["pendingFinalDelivery"]>;
};

export function registerStartupExhaustionRecoveryCases(
  getFixture: () => StartupExhaustionFixture,
): () => Promise<void> {
  let stopFinalStartupRecovery: (() => Promise<void>) | undefined;

  function scheduleFinalStartupRecovery(
    params: Parameters<typeof scheduleRestartAbortedMainSessionRecovery>[0],
    expectedTargets: number,
  ) {
    const reconciliationStarted = createDeferred();
    const reconciliations: Promise<unknown>[] = [];
    const admit = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
    const admissionSpy = vi
      .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
      .mockImplementation(<T>(run: () => Promise<T>, origin?: string, signal?: AbortSignal) => {
        const pending = admit(run, origin, signal);
        if (origin === "main-session:target-recovery") {
          reconciliations.push(pending);
          reconciliationStarted.resolve();
        }
        return pending;
      });
    const recovery = scheduleRestartAbortedMainSessionRecovery(params);
    let stopping: Promise<void> | undefined;
    const stop = () => {
      // Unwind a timed-out waiter too, so its enclosing environment scope can close.
      reconciliationStarted.reject(
        new Error("Recovery stopped before final reconciliation started"),
      );
      stopping ??= recovery.stop().finally(() => {
        admissionSpy.mockRestore();
        stopFinalStartupRecovery = undefined;
      });
      return stopping;
    };
    stopFinalStartupRecovery = stop;
    return {
      stop,
      async waitForExhaustion() {
        await reconciliationStarted.promise;
        // The scheduler registers the whole final-target batch synchronously. Join
        // every actual target, including unexpected extras, before checking rows.
        const outcomes = await Promise.allSettled(reconciliations);
        expect(outcomes).toHaveLength(expectedTargets);
        for (const outcome of outcomes) {
          expect(outcome.status).toBe("fulfilled");
        }
      },
    };
  }

  it("tombstones when the final startup retry consumes the last charge", async () => {
    const {
      tmpDir,
      gatewayRuntime,
      loadSessionEntry,
      makeMainSessionFixture,
      makePendingFinalDelivery,
    } = getFixture();
    const { storePath } = await makeMainSessionFixture({
      mainRestartRecovery: {
        cycleId: "cycle-final-startup-attempt",
        revision: 1,
        chargedAttempts: 2,
      },
      pendingFinalDelivery: makePendingFinalDelivery(),
    });
    vi.mocked(callGateway)
      .mockImplementationOnce(async () => {
        await replaceSessionEntry({ sessionKey: "agent:main:fresh", storePath }, {
          sessionId: "fresh-session",
          updatedAt: Date.now(),
          status: "running",
          abortedLastRun: true,
          mainRestartRecovery: {
            cycleId: "cycle-fresh-exhausted",
            revision: 1,
            chargedAttempts: 3,
          },
        } as SessionEntry);
        throw new Error("final ambiguous dispatch failure");
      })
      .mockResolvedValueOnce({ runId: "run-resumed" });

    const recovery = scheduleFinalStartupRecovery(
      {
        getConfig: () => ({ agents: { entries: { main: { default: true } } } }),
        delayMs: 0,
        maxRetries: 1,
        stateDir: tmpDir,
        gatewayRuntime,
      },
      1,
    );
    try {
      await recovery.waitForExhaustion();
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        status: "failed",
        mainRestartRecovery: { tombstone: expect.any(Object) },
      });
      expect(callGateway).toHaveBeenCalledTimes(2);
      const freshEntry = loadSessionEntry({ sessionKey: "agent:main:fresh", storePath });
      expect(freshEntry).toMatchObject({
        sessionId: "fresh-session",
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: { chargedAttempts: 3 },
      });
      expect(freshEntry?.mainRestartRecovery?.tombstone).toBeUndefined();
    } finally {
      await recovery.stop();
    }
  });

  it("observes final exhaustion in distinct stores for the same logical session", async () => {
    const {
      tmpDir,
      gatewayRuntime,
      loadSessionEntry,
      makeMainSessionFixture,
      makePendingFinalDelivery,
    } = getFixture();
    await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
      const sessionKey = "agent:ops:main";
      const targets: Parameters<typeof loadSessionEntry>[0][] = [];
      for (const [index, directory] of ["ops", " ops "].entries()) {
        const fixture = await makeMainSessionFixture({
          agentId: directory,
          sessionKey,
          sessionId: `ops-session-${index}`,
          mainRestartRecovery: {
            cycleId: `cycle-ops-${index}`,
            revision: 1,
            chargedAttempts: 2,
          },
          pendingFinalDelivery: makePendingFinalDelivery(),
        });
        targets.push({ agentId: "ops", sessionKey, storePath: fixture.storePath });
      }
      vi.mocked(callGateway).mockImplementation(async ({ method }) => {
        if (method === "agent") {
          throw new Error("final ambiguous dispatch failure");
        }
        return { status: "timeout" };
      });
      const recovery = scheduleFinalStartupRecovery(
        {
          getConfig: () => ({ agents: { entries: { ops: { default: true } } } }),
          delayMs: 0,
          maxRetries: 1,
          stateDir: tmpDir,
          gatewayRuntime,
        },
        targets.length,
      );
      try {
        await recovery.waitForExhaustion();
        for (const target of targets) {
          const entry = loadSessionEntry(target);
          expect(entry?.mainRestartRecovery?.chargedAttempts).toBe(3);
          expect(entry?.mainRestartRecovery?.reservation).toBeUndefined();
        }
        for (const [index, target] of targets.entries()) {
          expect(loadSessionEntry(target)).toMatchObject({
            sessionId: `ops-session-${index}`,
            status: "failed",
            abortedLastRun: false,
            mainRestartRecovery: { tombstone: expect.any(Object) },
          });
        }
        expect(
          vi.mocked(callGateway).mock.calls.filter(([call]) => call.method === "agent"),
        ).toHaveLength(2);
      } finally {
        await recovery.stop();
      }
    });
  });

  return async () => {
    await stopFinalStartupRecovery?.();
  };
}
