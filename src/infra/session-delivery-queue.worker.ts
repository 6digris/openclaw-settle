import { isDeepStrictEqual } from "node:util";
import { computeBackoff } from "../../packages/retry/src/index.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  loadDeliveryQueueEntryInDatabase,
  upsertBoundDeliveryQueueEntryInDatabase,
  inflateDeliveryQueueRow,
  type DeliveryQueueDatabase,
} from "./delivery-queue-sqlite-bound.js";
import {
  completeDeliveryQueueEntryInDatabase,
  deliveryQueueEntryNotFoundError,
  getDeliveryQueueEntryOwnersInDatabase,
  loadDeliveryQueueEntriesInDatabase,
  prepareDeliveryQueueTerminalEntry,
  terminalizePendingDeliveryQueueEntryInDatabase,
  updateDeliveryQueueEntryInDatabase,
} from "./delivery-queue-sqlite.kernel.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "./kysely-sync.js";
import {
  SESSION_DELIVERY_QUEUE_NAME,
  resolveSessionDeliveryIdentityBlock,
  type QueuedSessionDelivery,
} from "./session-delivery-queue.records.js";
import type { SessionDeliveryWorkerOperations } from "./session-delivery-queue.worker-contract.js";
import { runSqliteDeferredTransactionSync } from "./sqlite-transaction.js";
import type { SqliteWorkerCommand } from "./sqlite-worker-contract.js";

function readSessionDelivery(
  database: OpenClawStateDatabase,
  id: string,
): QueuedSessionDelivery | null {
  const entry = loadDeliveryQueueEntryInDatabase(
    database,
    SESSION_DELIVERY_QUEUE_NAME,
    id,
    "pending",
  );
  // SAFETY: The session namespace retains the canonical session-delivery payload contract.
  return entry as QueuedSessionDelivery | null;
}

export function executeSessionDeliveryCommand(
  command: SqliteWorkerCommand<SessionDeliveryWorkerOperations>,
  database: OpenClawStateDatabase,
): SessionDeliveryWorkerOperations[keyof SessionDeliveryWorkerOperations]["output"] {
  const readStatus = (id: string) =>
    getDeliveryQueueEntryOwnersInDatabase(database, [SESSION_DELIVERY_QUEUE_NAME], id).get(
      SESSION_DELIVERY_QUEUE_NAME,
    )?.status;
  const update = (id: string, transform: (entry: QueuedSessionDelivery) => QueuedSessionDelivery) =>
    updateDeliveryQueueEntryInDatabase(database, SESSION_DELIVERY_QUEUE_NAME, id, (entry) =>
      // SAFETY: Only the session namespace reaches this payload transform.
      transform(entry as QueuedSessionDelivery),
    );

  switch (command.type) {
    case "sessionDelivery.enqueue":
      upsertBoundDeliveryQueueEntryInDatabase(command.input, database);
      return;
    case "sessionDelivery.enqueueClaimed": {
      const id = command.input.row.id;
      const claimed = upsertBoundDeliveryQueueEntryInDatabase(command.input, database);
      try {
        return { id, claimed, status: claimed ? "pending" : (readStatus(id) ?? "completed") };
      } catch {
        // A failed status read cannot undo the ownership established by the insert conflict.
        return { id, claimed, status: "unknown" };
      }
    }
    case "sessionDelivery.releaseClaim":
      update(command.input.id, (entry) => ({ ...entry, availableAt: Date.now() }));
      return;
    case "sessionDelivery.defer": {
      const { id, delayMs } = command.input;
      update(id, (entry) => ({
        ...entry,
        availableAt: Date.now() + Math.max(0, delayMs),
      }));
      return;
    }
    case "sessionDelivery.advanceAgentRun": {
      const { id, updates } = command.input;
      update(id, (entry) =>
        entry.kind !== "agentTurn"
          ? entry
          : {
              ...entry,
              agentRunAttempt: (entry.agentRunAttempt ?? 0) + 1,
              deliveryStartedAt: undefined,
              ...(updates?.message ? { message: updates.message } : {}),
              ...(updates?.expectedMediaUrls
                ? { expectedMediaUrls: updates.expectedMediaUrls }
                : {}),
              ...(updates?.suppressTextDelivery === true
                ? { suppressTextDelivery: true as const }
                : {}),
            },
      );
      return;
    }
    case "sessionDelivery.mergePreparedMedia": {
      const { id, mediaUrl, blocksJson } = command.input;
      let result: SessionDeliveryWorkerOperations["sessionDelivery.mergePreparedMedia"]["output"] =
        {
          source: "input",
        };
      update(id, (entry) => {
        if (entry.kind !== "agentTurn") {
          return entry;
        }
        const stored = entry.preparedMediaBlocks?.[mediaUrl];
        // SAFETY: The host serialized the caller's typed block array before worker admission.
        const blocks = stored ?? (JSON.parse(blocksJson) as Array<Record<string, unknown>>);
        if (stored != null) {
          result = { source: "stored", blocks: stored };
        }
        return {
          ...entry,
          preparedMediaBlocks: { ...entry.preparedMediaBlocks, [mediaUrl]: blocks },
        };
      });
      return result;
    }
    case "sessionDelivery.markAttemptStarted": {
      if (!upsertBoundDeliveryQueueEntryInDatabase(command.input, database)) {
        throw new Error(`Session delivery ${command.input.row.id} is no longer pending`);
      }
      return;
    }
    case "sessionDelivery.markSettlement": {
      const id = command.input.row.id;
      try {
        if (
          upsertBoundDeliveryQueueEntryInDatabase(command.input, database) ||
          readStatus(id) === "completed"
        ) {
          return;
        }
        throw new Error(`Session delivery ${id} is no longer pending`);
      } catch (error) {
        try {
          if (readStatus(id) === "completed") {
            return;
          }
        } catch {
          // Preserve the original failure when completion cannot be established.
        }
        throw error;
      }
    }
    case "sessionDelivery.complete": {
      const { id } = command.input;
      try {
        completeDeliveryQueueEntryInDatabase(database, SESSION_DELIVERY_QUEUE_NAME, id);
      } catch (error) {
        try {
          if (readStatus(id) === "completed") {
            return;
          }
        } catch {
          // Preserve the original failure when completion cannot be established.
        }
        throw error;
      }
      return;
    }
    case "sessionDelivery.fail": {
      const { id, error, releaseAttemptOwnership } = command.input;
      update(id, (entry) => {
        const retryCount = entry.retryCount + 1;
        const now = Date.now();
        return {
          ...entry,
          retryCount,
          ...(entry.kind === "agentTurn"
            ? { lastChargedAgentRunAttempt: entry.agentRunAttempt ?? 0 }
            : {}),
          ...(releaseAttemptOwnership === true ? { deliveryStartedAt: undefined } : {}),
          lastAttemptAt: now,
          ...(entry.kind === "agentTurn" && entry.owner?.kind === "subagent_completion"
            ? {
                availableAt:
                  now +
                  computeBackoff(
                    { initialMs: 15_000, factor: 2, maxMs: 5 * 60_000, jitter: 0.2 },
                    retryCount,
                  ),
              }
            : {}),
          lastError: error,
        };
      });
      return;
    }
    case "sessionDelivery.load":
      return readSessionDelivery(database, command.input.id);
    case "sessionDelivery.list": {
      const entries = loadDeliveryQueueEntriesInDatabase(database, SESSION_DELIVERY_QUEUE_NAME);
      // SAFETY: All returned rows belong to the canonical session-delivery namespace.
      return entries as QueuedSessionDelivery[];
    }
    case "sessionDelivery.recordIdentityBlock":
      return runOpenClawStateWriteTransaction(
        ({ db }) => {
          const query = getNodeSqliteKysely<DeliveryQueueDatabase>(db);
          const row = executeSqliteQueryTakeFirstSync(
            db,
            query
              .selectFrom("delivery_queue_entries")
              .selectAll()
              .where("queue_name", "=", SESSION_DELIVERY_QUEUE_NAME)
              .where("id", "=", command.input.entry.id)
              .where("status", "=", "pending"),
          );
          const current =
            // SAFETY: The session namespace is decoded by its canonical queue codec.
            (row ? inflateDeliveryQueueRow(row) : null) as QueuedSessionDelivery | null;
          const reason = current ? resolveSessionDeliveryIdentityBlock(current) : undefined;
          if (
            !row ||
            !current ||
            !reason ||
            !isDeepStrictEqual(current, command.input.entry) ||
            row.last_error === reason
          ) {
            return { entry: current, blocked: Boolean(reason) };
          }
          executeSqliteQuerySync(
            db,
            query
              .updateTable("delivery_queue_entries")
              .set({ last_error: reason })
              .where("queue_name", "=", SESSION_DELIVERY_QUEUE_NAME)
              .where("id", "=", row.id)
              .where("status", "=", "pending")
              .where("entry_json", "=", row.entry_json)
              .where("last_error", "is", row.last_error),
          );
          return {
            entry: { ...current, lastError: reason },
            blocked: true,
          };
        },
        { database },
        { operationLabel: "record blocked session delivery identity" },
      );
    case "sessionDelivery.blockedSummary":
      return runSqliteDeferredTransactionSync(database.db, () => {
        const query = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
        const ids: string[] = [];
        for (const row of iterateSqliteQuerySync(
          database.db,
          query
            .selectFrom("delivery_queue_entries")
            .select(["id", "session_key"])
            .where("queue_name", "=", SESSION_DELIVERY_QUEUE_NAME)
            .where("status", "=", "pending"),
        )) {
          if (!parseAgentSessionKey(row.session_key)) {
            ids.push(row.id);
          }
        }
        if (!ids.length) {
          return [];
        }
        const rows = iterateSqliteQuerySync(
          database.db,
          query
            .selectFrom("delivery_queue_entries")
            .selectAll()
            .where("queue_name", "=", SESSION_DELIVERY_QUEUE_NAME)
            .where("status", "=", "pending")
            .where("id", "in", sqliteStringSet(ids)),
        );
        let count = 0;
        let oldestEnqueuedAt = Number.POSITIVE_INFINITY;
        let reason: string | undefined;
        for (const row of rows) {
          // SAFETY: Only session rows enter this identity-only diagnostic.
          const entry = inflateDeliveryQueueRow(row) as QueuedSessionDelivery | null;
          const blocked = entry && resolveSessionDeliveryIdentityBlock(entry);
          if (entry && blocked) {
            count += 1;
            oldestEnqueuedAt = Math.min(oldestEnqueuedAt, entry.enqueuedAt);
            reason = blocked;
          }
        }
        return reason
          ? [{ queueName: SESSION_DELIVERY_QUEUE_NAME, count, oldestEnqueuedAt, reason }]
          : [];
      });
    case "sessionDelivery.moveToFailed": {
      const { id } = command.input;
      try {
        const entry = readSessionDelivery(database, id);
        if (!entry) {
          throw deliveryQueueEntryNotFoundError(SESSION_DELIVERY_QUEUE_NAME, id);
        }
        const result = terminalizePendingDeliveryQueueEntryInDatabase(
          database,
          prepareDeliveryQueueTerminalEntry({ queueName: SESSION_DELIVERY_QUEUE_NAME, id, entry }),
        );
        if (result.status !== "terminalized") {
          throw deliveryQueueEntryNotFoundError(SESSION_DELIVERY_QUEUE_NAME, id);
        }
      } catch (error) {
        try {
          if (readStatus(id) === "failed") {
            return;
          }
        } catch {
          // Preserve the original transition failure when durable state is unreadable.
        }
        throw error;
      }
    }
  }
}
