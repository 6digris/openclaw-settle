import { expect, it, vi } from "vitest";
import { formatDeliveryQueueHealthLine } from "../commands/health-format.js";
import { buildDeliveryQueueHealthSummary } from "../gateway/health/delivery-queue.js";
import { backfillDeliveryQueueEntriesFromEntryJson } from "../state/openclaw-state-db-legacy-backfills.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  captureDeliveryQueueStateContext,
  upsertDeliveryQueueEntry,
} from "./delivery-queue-sqlite.js";
import { recoverPendingSessionDeliveries } from "./session-delivery-queue-recovery.js";
import {
  enqueueSessionDelivery,
  loadPendingSessionDelivery,
  readBlockedSessionDeliverySummary,
  admitSessionDeliveryExecution,
  failSessionDelivery,
} from "./session-delivery-queue-storage.js";
import type { QueuedSessionDelivery } from "./session-delivery-queue.records.js";
import { withSessionDeliveryQueue } from "./session-delivery-queue.test-helpers.js";

it("retains blocked payload bytes, references, and actionable health through restart and maintenance", async () => {
  await withSessionDeliveryQueue(async (stateDir, queueContext) => {
    const id = await enqueueSessionDelivery(
      {
        kind: "agentTurn",
        sessionKey: "main",
        message: "private result 🦞\u0000 end",
        messageId: "legacy",
        expectedMediaUrls: ["/synthetic/retained.png"],
        preparedMediaBlocks: {
          "/synthetic/retained.png": [{ type: "image", attachmentId: "retained" }],
        },
        completionRetention: "permanent",
      },
      queueContext,
    );
    const database = openOpenClawStateDatabase({ path: queueContext.admission.databasePath });
    const snapshot = () =>
      database.db
        .prepare("SELECT * FROM delivery_queue_entries WHERE queue_name = 'session' AND id = ?")
        .get(id);
    const before = snapshot();
    const pending = await loadPendingSessionDelivery(id, queueContext);
    if (!pending) {
      throw new Error("missing pending fixture");
    }
    expect(await admitSessionDeliveryExecution(pending, queueContext)).toBeNull();
    const annotated = snapshot();
    expect(annotated).toEqual({
      ...before,
      last_error: expect.stringContaining("send a new message"),
    });
    const recorded = await loadPendingSessionDelivery(id, queueContext);
    if (!recorded) {
      throw new Error("lost blocked fixture");
    }
    expect(await admitSessionDeliveryExecution(recorded, queueContext)).toBeNull();
    expect(snapshot()).toEqual(annotated);
    runOpenClawStateWriteTransaction(({ db }) => backfillDeliveryQueueEntriesFromEntryJson(db), {
      database,
    });
    expect(snapshot()).toEqual({
      ...before,
      last_error: expect.stringContaining("send a new message"),
    });
    await closeOpenClawStateDatabaseByPathAsync(queueContext.admission.databasePath);
    const reopened = captureOpenClawStateWorkerContext({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const after = await loadPendingSessionDelivery(id, reopened);
    expect(after).toMatchObject({
      ...pending,
      lastError: expect.stringContaining("send a new message"),
    });
    const deliver = vi.fn(async () => {});
    await recoverPendingSessionDeliveries({
      queueContext: reopened,
      deliver,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(deliver).not.toHaveBeenCalled();
    const blocked = await readBlockedSessionDeliverySummary(reopened);
    expect(blocked).toEqual([
      {
        queueName: "session",
        count: 1,
        oldestEnqueuedAt: pending.enqueuedAt,
        reason: expect.stringContaining("send a new message"),
      },
    ]);
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const health = await buildDeliveryQueueHealthSummary([], {
        stateContext: captureDeliveryQueueStateContext(stateDir),
      });
      expect(health).toMatchObject({ failed: [], blocked });
      expect(
        formatDeliveryQueueHealthLine({
          ok: true,
          ts: 0,
          durationMs: 0,
          channels: {},
          channelOrder: [],
          channelLabels: {},
          heartbeatSeconds: 0,
          defaultAgentId: "ops",
          agents: [],
          sessions: { path: stateDir, count: 0, recent: [] },
          deliveryQueues: health,
        }),
      ).toContain("blocked pending deliveries — session: 1");
    });
  });
});

it.each(["target repaired", "payload replaced"])(
  "does not annotate a stale snapshot after its %s",
  async (change) => {
    await withSessionDeliveryQueue(async (stateDir, queueContext) => {
      const id = await enqueueSessionDelivery(
        { kind: "systemEvent", sessionKey: "main", agentId: "ops", text: "original" },
        queueContext,
      );
      const expected = await loadPendingSessionDelivery(id, queueContext);
      if (!expected || expected.kind !== "systemEvent") {
        throw new Error("missing event fixture");
      }
      const current = {
        ...expected,
        ...(change === "target repaired"
          ? { sessionKey: "agent:ops:old-home" }
          : { text: "replacement" }),
      };
      upsertDeliveryQueueEntry({
        queueName: "session",
        entry: current,
        stateDir,
        updatePendingOnly: true,
      });
      const database = openOpenClawStateDatabase({ path: queueContext.admission.databasePath });
      const snapshot = () =>
        database.db
          .prepare("SELECT * FROM delivery_queue_entries WHERE queue_name = 'session' AND id = ?")
          .get(id);
      const before = snapshot();
      expect(await admitSessionDeliveryExecution(expected, queueContext)).toEqual(
        change === "target repaired" ? current : null,
      );
      expect(snapshot()).toEqual(before);
      expect(await loadPendingSessionDelivery(id, queueContext)).toEqual(current);
    });
  },
);

it("derives admission independently of old retry diagnostics restored by maintenance", async () => {
  await withSessionDeliveryQueue(async (stateDir, queueContext) => {
    const id = await enqueueSessionDelivery(
      {
        kind: "systemEvent",
        sessionKey: "main",
        agentId: "ops",
        text: "original",
        completionRetention: "permanent",
      },
      queueContext,
    );
    await failSessionDelivery(id, "older lookup failure", queueContext);
    const original = await loadPendingSessionDelivery(id, queueContext);
    if (!original) {
      throw new Error("missing event fixture");
    }
    const database = openOpenClawStateDatabase({ path: queueContext.admission.databasePath });
    const payload = () =>
      database.db.prepare("SELECT entry_json FROM delivery_queue_entries WHERE id = ?").get(id);
    const before = payload();
    expect(await admitSessionDeliveryExecution(original, queueContext)).toBeNull();
    runOpenClawStateWriteTransaction(({ db }) => backfillDeliveryQueueEntriesFromEntryJson(db), {
      database,
    });
    const restored = await loadPendingSessionDelivery(id, queueContext);
    expect(restored?.lastError).toBe("older lookup failure");
    if (!restored) {
      throw new Error("lost event fixture");
    }
    expect(await admitSessionDeliveryExecution(restored, queueContext)).toBeNull();
    expect(payload()).toEqual(before);
    const diagnostic = (await loadPendingSessionDelivery(id, queueContext))?.lastError;
    const newMessage: QueuedSessionDelivery = {
      ...original,
      id: "new-message",
      sessionKey: "agent:ops:main",
      lastError: diagnostic,
    };
    upsertDeliveryQueueEntry({
      queueName: "session",
      stateDir,
      entry: newMessage,
    });
    const fresh = await loadPendingSessionDelivery("new-message", queueContext);
    if (!fresh) {
      throw new Error("missing new message fixture");
    }
    expect(await admitSessionDeliveryExecution(fresh, queueContext)).toEqual(fresh);
  });
});

it("refuses diagnostic writes from a retired database admission", async () => {
  await withSessionDeliveryQueue(async (stateDir, queueContext) => {
    const id = await enqueueSessionDelivery(
      { kind: "systemEvent", sessionKey: "global", text: "unowned" },
      queueContext,
    );
    const pending = await loadPendingSessionDelivery(id, queueContext);
    if (!pending) {
      throw new Error("missing event fixture");
    }
    await closeOpenClawStateDatabaseByPathAsync(queueContext.admission.databasePath);
    await expect(admitSessionDeliveryExecution(pending, queueContext)).rejects.toThrow();
    const fresh = captureOpenClawStateWorkerContext({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    expect(await loadPendingSessionDelivery(id, fresh)).toEqual(pending);
  });
});
