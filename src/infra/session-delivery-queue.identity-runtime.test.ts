import { afterEach, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { upsertDeliveryQueueEntry } from "./delivery-queue-sqlite.js";
import {
  drainPendingSessionDelivery,
  recoverPendingSessionDeliveries,
  type DeliverSessionDeliveryFn,
} from "./session-delivery-queue-recovery.js";
import {
  schedulePendingSessionDeliveries,
  scheduleSessionDelivery,
  startSessionDeliveryRuntime,
} from "./session-delivery-queue-runtime.js";
import {
  enqueueSessionDelivery,
  loadPendingSessionDeliveries,
  loadPendingSessionDelivery,
  markSessionDeliverySettlement,
} from "./session-delivery-queue-storage.js";
import {
  SessionDeliveryDeferredError,
  type QueuedSessionDelivery,
} from "./session-delivery-queue.records.js";
import { withSessionDeliveryQueue } from "./session-delivery-queue.test-helpers.js";

afterEach(() => vi.useRealTimers());
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

it.each(["single", "bulk"])(
  "joins a refused diagnostic after %s reload loses authority",
  async (mode) => {
    await withSessionDeliveryQueue(async (stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        { kind: "systemEvent", sessionKey: "main", text: "unchanged" },
        queueContext,
      );
      const entry = await loadPendingSessionDelivery(id, queueContext);
      if (!entry) {
        throw new Error("missing event fixture");
      }
      const retireAfterLoad = async () => {
        await closeOpenClawStateDatabaseByPathAsync(queueContext.admission.databasePath);
        return entry;
      };
      const log = logger();
      const deliver = vi.fn<DeliverSessionDeliveryFn>(async () => {});
      const stop = startSessionDeliveryRuntime({
        queueContext,
        deliver,
        log,
        reloadPending: retireAfterLoad,
        listPending: async () => [await retireAfterLoad()],
      });
      try {
        if (mode === "single") {
          await expect(scheduleSessionDelivery(id, queueContext)).resolves.toBe(true);
        } else {
          await expect(schedulePendingSessionDeliveries()).resolves.toBeUndefined();
        }
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining("failed to admit"));
        expect(deliver).not.toHaveBeenCalled();
      } finally {
        await stop();
      }
      const fresh = captureOpenClawStateWorkerContext({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      expect(await loadPendingSessionDelivery(id, fresh)).toEqual(entry);
    });
  },
);

it("does not rearm a row that loses executable identity after it was scheduled", async () => {
  await withSessionDeliveryQueue(async (stateDir, queueContext) => {
    const id = await enqueueSessionDelivery(
      { kind: "systemEvent", sessionKey: "agent:ops:main", text: "retained" },
      queueContext,
    );
    const pending = await loadPendingSessionDelivery(id, queueContext);
    if (!pending) {
      throw new Error("missing queued fixture");
    }
    vi.useFakeTimers();
    const deliver = vi.fn<DeliverSessionDeliveryFn>(async () => {
      throw new SessionDeliveryDeferredError("unresolved target");
    });
    const drain = vi.fn(drainPendingSessionDelivery);
    const stop = startSessionDeliveryRuntime({ queueContext, deliver, drain, log: logger() });
    try {
      await scheduleSessionDelivery(id, queueContext);
      const replacement: QueuedSessionDelivery = { ...pending, sessionKey: "main" };
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: replacement,
        stateDir,
        updatePendingOnly: true,
      });
      await vi.advanceTimersByTimeAsync(0);
      await drain.mock.results[0]?.value;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(drain).toHaveBeenCalledOnce();
      expect(deliver).not.toHaveBeenCalled();
    } finally {
      await stop();
      vi.useRealTimers();
    }
  });
});

it.each(["systemEvent", "agentTurn"] as const)(
  "keeps immutable %s identity failures out of every automatic scheduling path",
  async (kind) => {
    await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        kind === "systemEvent"
          ? { kind, sessionKey: "main", agentId: "ops", text: "retained" }
          : { kind, sessionKey: "main", message: "retained", messageId: "legacy-message" },
        queueContext,
      );
      vi.useFakeTimers();
      const deliver = vi.fn<DeliverSessionDeliveryFn>(async () => {
        throw new SessionDeliveryDeferredError("no historical target");
      });
      const drain = vi.fn(drainPendingSessionDelivery);
      const stop = startSessionDeliveryRuntime({ queueContext, deliver, drain, log: logger() });
      try {
        await scheduleSessionDelivery(id, queueContext);
        await schedulePendingSessionDeliveries();
        await vi.advanceTimersByTimeAsync(0);
        await drain.mock.results[0]?.value;
        await vi.advanceTimersByTimeAsync(1_000);
        await drain.mock.results[1]?.value;
        expect(drain).not.toHaveBeenCalled();
        expect(deliver).not.toHaveBeenCalled();
        expect(await loadPendingSessionDelivery(id, queueContext)).toMatchObject({
          id,
          retryCount: 0,
          lastError: expect.stringContaining("send a new message"),
        });
      } finally {
        await stop();
        vi.useRealTimers();
      }
    });
  },
);

it("preserves runnable FIFO around blocked rows and finalizes an acknowledged alias", async () => {
  await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
    const first = await enqueueSessionDelivery(
      { kind: "systemEvent", sessionKey: "agent:ops:main", text: "first" },
      queueContext,
    );
    const blocked = await enqueueSessionDelivery(
      { kind: "systemEvent", sessionKey: "main", agentId: "ops", text: "blocked" },
      queueContext,
    );
    const acknowledged = await enqueueSessionDelivery(
      { kind: "systemEvent", sessionKey: "global", text: "already delivered" },
      queueContext,
    );
    const last = await enqueueSessionDelivery(
      { kind: "systemEvent", sessionKey: "agent:ops:main", text: "last" },
      queueContext,
    );
    const pending = await loadPendingSessionDelivery(acknowledged, queueContext);
    if (!pending) {
      throw new Error("missing acknowledged fixture");
    }
    await markSessionDeliverySettlement(pending, "recovered", queueContext);
    const deliver = vi.fn<DeliverSessionDeliveryFn>(async () => {});
    const onSettled = vi.fn(async () => {});
    await recoverPendingSessionDeliveries({ queueContext, deliver, onSettled, log: logger() });
    expect(deliver.mock.calls.map(([entry]) => entry.id)).toEqual([first, last]);
    expect(onSettled).toHaveBeenCalledWith(
      expect.objectContaining({ id: acknowledged }),
      "recovered",
      queueContext,
    );
    expect((await loadPendingSessionDeliveries(queueContext)).map((entry) => entry.id)).toEqual([
      blocked,
    ]);
  });
});

it("keeps captured target and execution evidence on existing recovery paths", async () => {
  await withSessionDeliveryQueue(async (_stateDir, queueContext) => {
    const started = await enqueueSessionDelivery(
      { kind: "agentTurn", sessionKey: "main", message: "started", messageId: "started" },
      queueContext,
    );
    const { markSessionDeliveryAttemptStarted } =
      await import("./session-delivery-queue-storage.js");
    const entry = await loadPendingSessionDelivery(started, queueContext);
    if (!entry) {
      throw new Error("missing started fixture");
    }
    await markSessionDeliveryAttemptStarted(entry, queueContext);
    const correlated = await enqueueSessionDelivery(
      {
        kind: "agentTurn",
        sessionKey: "global",
        message: "correlated",
        messageId: "correlated",
        owner: {
          kind: "subagent_completion",
          runId: "run",
          taskId: "task",
          generation: 1,
          deadlineAt: Date.now() + 30_000,
        },
      },
      queueContext,
    );
    const capturedTarget = await enqueueSessionDelivery(
      {
        kind: "agentTurn",
        sessionKey: "main",
        expectedSessionId: "recorded-generation",
        message: "retained target",
        messageId: "captured-target",
      },
      queueContext,
    );
    const deliver = vi.fn<DeliverSessionDeliveryFn>(async () => {
      throw new SessionDeliveryDeferredError("owner still reconciling");
    });
    await recoverPendingSessionDeliveries({ queueContext, deliver, log: logger() });
    expect(deliver.mock.calls.map(([delivery]) => delivery.id)).toEqual([
      started,
      correlated,
      capturedTarget,
    ]);
    expect(await loadPendingSessionDeliveries(queueContext)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: started,
          retryCount: 0,
          deliveryStartedAt: expect.any(Number),
        }),
        expect.objectContaining({ id: correlated, retryCount: 0 }),
        expect.objectContaining({
          id: capturedTarget,
          expectedSessionId: "recorded-generation",
          retryCount: 0,
        }),
      ]),
    );
  });
});
