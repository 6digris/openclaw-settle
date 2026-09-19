import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { bindDeliveryQueueEntry } from "./delivery-queue-sqlite-bound.js";
import {
  prepareClaimedSessionDelivery,
  prepareSessionDelivery,
  resolveSessionDeliveryIdentityBlock,
  SESSION_DELIVERY_QUEUE_NAME,
  SessionDeliveryAcknowledgementFinalizeError,
  SessionDeliveryAttemptStartError,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
  type SessionDeliverySettledOutcome,
} from "./session-delivery-queue.records.js";
import type {
  SessionDeliveryAgentRunUpdate,
  SessionDeliveryWorkerOperations,
} from "./session-delivery-queue.worker-contract.js";

function executeSessionDelivery<Key extends keyof SessionDeliveryWorkerOperations>(
  context: OpenClawStateWorkerContext,
  command: { type: Key; input: SessionDeliveryWorkerOperations[Key]["input"] },
): Promise<SessionDeliveryWorkerOperations[Key]["output"]> {
  // A settled write remains authoritative if its captured owner closes while returning the result.
  return runOpenClawStateWorkerOperation(context, (scope) => scope.execute(command));
}

function prepareEntry(
  entry: QueuedSessionDelivery,
  mode: "insert" | "update",
): ReturnType<typeof bindDeliveryQueueEntry> {
  // Preserve the JSON persistence boundary before the transport serializes its input.
  return bindDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry,
    ...(mode === "insert" ? { insertOnly: true } : { updatePendingOnly: true }),
  });
}

export async function enqueueSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  context: OpenClawStateWorkerContext,
): Promise<string> {
  const entry = prepareSessionDelivery(params);
  await executeSessionDelivery(context, {
    type: "sessionDelivery.enqueue",
    input: prepareEntry(entry, "insert"),
  });
  return entry.id;
}

export async function enqueueClaimedSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  initialAttemptLeaseMs: number,
  context: OpenClawStateWorkerContext,
): Promise<SessionDeliveryWorkerOperations["sessionDelivery.enqueueClaimed"]["output"]> {
  return executeSessionDelivery(context, {
    type: "sessionDelivery.enqueueClaimed",
    input: prepareEntry(prepareClaimedSessionDelivery(params, initialAttemptLeaseMs), "insert"),
  });
}

export async function releaseSessionDeliveryClaim(
  id: string,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return executeSessionDelivery(context, { type: "sessionDelivery.releaseClaim", input: { id } });
}

export async function deferSessionDelivery(
  id: string,
  delayMs: number,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return executeSessionDelivery(context, { type: "sessionDelivery.defer", input: { id, delayMs } });
}

export async function advanceSessionDeliveryAgentRun(
  id: string,
  updates: SessionDeliveryAgentRunUpdate | undefined,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return executeSessionDelivery(context, {
    type: "sessionDelivery.advanceAgentRun",
    input: { id, updates },
  });
}

export async function mergeSessionDeliveryPreparedMediaBlocks(
  id: string,
  mediaUrl: string,
  blocks: Array<Record<string, unknown>>,
  context: OpenClawStateWorkerContext,
): Promise<Array<Record<string, unknown>>> {
  const result = await executeSessionDelivery(context, {
    type: "sessionDelivery.mergePreparedMedia",
    input: { id, mediaUrl, blocksJson: JSON.stringify(blocks) },
  });
  return result.source === "input" ? blocks : result.blocks;
}

export async function markSessionDeliveryAttemptStarted(
  entry: QueuedSessionDelivery,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  try {
    await executeSessionDelivery(context, {
      type: "sessionDelivery.markAttemptStarted",
      input: prepareEntry(
        { ...entry, deliveryStartedAt: entry.deliveryStartedAt ?? Date.now() },
        "update",
      ),
    });
  } catch (error) {
    throw new SessionDeliveryAttemptStartError(
      `Session delivery ${entry.id} could not persist attempt ownership`,
      { cause: error },
    );
  }
}

export async function markSessionDeliverySettlement(
  entry: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  try {
    await executeSessionDelivery(context, {
      type: "sessionDelivery.markSettlement",
      input: prepareEntry(
        {
          ...entry,
          settlementOutcome: outcome,
          ...(outcome === "recovered"
            ? { acknowledgedAt: entry.acknowledgedAt ?? Date.now() }
            : {}),
        },
        "update",
      ),
    });
  } catch (error) {
    throw new SessionDeliveryAcknowledgementFinalizeError(entry.id, { cause: error });
  }
}

export async function completeSessionDelivery(
  id: string,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  try {
    await executeSessionDelivery(context, { type: "sessionDelivery.complete", input: { id } });
  } catch (error) {
    throw new SessionDeliveryAcknowledgementFinalizeError(id, { cause: error });
  }
}

export async function failSessionDelivery(
  id: string,
  error: string,
  context: OpenClawStateWorkerContext,
  options?: { releaseAttemptOwnership?: boolean },
): Promise<void> {
  return executeSessionDelivery(context, {
    type: "sessionDelivery.fail",
    input: { id, error, ...options },
  });
}

export async function loadPendingSessionDelivery(
  id: string,
  context: OpenClawStateWorkerContext,
): Promise<QueuedSessionDelivery | null> {
  const entry = await executeSessionDelivery(context, {
    type: "sessionDelivery.load",
    input: { id },
  });
  context.admission.assertCurrent();
  return entry;
}

export async function loadPendingSessionDeliveries(
  context: OpenClawStateWorkerContext,
): Promise<QueuedSessionDelivery[]> {
  const entries = await executeSessionDelivery(context, {
    type: "sessionDelivery.list",
    input: undefined,
  });
  context.admission.assertCurrent();
  return entries;
}

/** Scheduling admission never hides pending custody from inventory and retention readers. */
export async function admitSessionDeliveryExecution(
  entry: QueuedSessionDelivery,
  context: OpenClawStateWorkerContext,
): Promise<QueuedSessionDelivery | null> {
  if (!resolveSessionDeliveryIdentityBlock(entry)) {
    return entry;
  }
  const result = await executeSessionDelivery(context, {
    type: "sessionDelivery.recordIdentityBlock",
    input: { entry },
  });
  context.admission.assertCurrent();
  return result.blocked ? null : result.entry;
}

export async function readBlockedSessionDeliverySummary(context: OpenClawStateWorkerContext) {
  return executeSessionDelivery(context, {
    type: "sessionDelivery.blockedSummary",
    input: undefined,
  });
}

export async function moveSessionDeliveryToFailed(
  id: string,
  context: OpenClawStateWorkerContext,
): Promise<void> {
  return executeSessionDelivery(context, { type: "sessionDelivery.moveToFailed", input: { id } });
}
