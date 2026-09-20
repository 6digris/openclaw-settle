/**
 * Publishes ClickClack's native ephemeral agent.progress signal for one
 * OpenClaw turn. ClickClack renders this as its compact "Agent is
 * responding" status and the detailed progress lines above the composer.
 */
import {
  buildChannelProgressDraftLine,
  isCompleteAgentPreamble,
} from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";

export type ClickClackItemEventPayload = Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0];

type ClickClackProgressClient = {
  publishEphemeral(params: {
    workspaceId: string;
    channelId?: string;
    conversationId?: string;
    type: "agent.progress";
    payload?: Record<string, unknown>;
  }): Promise<void>;
};

type ClickClackProgressTarget = {
  workspaceId: string;
  channelId?: string;
  conversationId?: string;
};

function normalizedKind(payload: ClickClackItemEventPayload): string {
  const kind = payload.kind?.trim().toLowerCase();
  if (
    !kind ||
    kind === "preamble" ||
    kind === "analysis" ||
    kind === "thinking" ||
    kind === "reasoning" ||
    kind === "missing"
  ) {
    return "commentary";
  }
  return kind;
}

function progressText(payload: ClickClackItemEventPayload): string {
  if (payload.kind !== "preamble" && payload.title) {
    return payload.title;
  }
  const line = buildChannelProgressDraftLine({
    event: "item",
    itemId: payload.itemId,
    toolCallId: payload.toolCallId,
    itemKind: payload.kind,
    title: payload.title,
    name: payload.name,
    phase: payload.phase,
    status: payload.status,
    summary: payload.summary,
    progressText: payload.progressText,
    meta: payload.meta,
    commandBearing: payload.commandBearing,
  })?.text?.trim();
  if (line) {
    return line;
  }
  return (
    payload.progressText?.trim() ||
    payload.summary?.trim() ||
    payload.title?.trim() ||
    payload.name?.trim() ||
    payload.meta?.trim() ||
    payload.status?.trim() ||
    "Working"
  );
}

function isFinal(payload: ClickClackItemEventPayload): boolean {
  const phase = payload.phase?.trim().toLowerCase();
  const status = payload.status?.trim().toLowerCase();
  return phase === "end" || status === "completed" || status === "failed" || status === "blocked";
}

type AnonymousLine = { id: string; active: boolean };

function createLineIdResolver(): (payload: ClickClackItemEventPayload) => string {
  const anonymousLinesByKind = new Map<string, AnonymousLine[]>();
  let anonymousSequence = 0;

  return (payload) => {
    const identity = payload.itemId?.trim() || payload.toolCallId?.trim();
    if (identity) {
      return `item:${identity}`;
    }

    const kind = normalizedKind(payload);
    const anonymousLines = anonymousLinesByKind.get(kind) ?? [];
    const phase = payload.phase?.trim().toLowerCase();
    const existingAnonymous =
      phase === "start" ? undefined : anonymousLines.toReversed().find((line) => line.active);
    const line =
      existingAnonymous ??
      (() => {
        const created = { id: `item:${kind}:${++anonymousSequence}`, active: true };
        anonymousLines.push(created);
        anonymousLinesByKind.set(kind, anonymousLines);
        return created;
      })();
    if (isFinal(payload)) {
      line.active = false;
    }
    return line.id;
  };
}

export type ClickClackProgressPublication = "delivered" | "skipped" | "failed";

export type ClickClackAgentProgressPublisher = {
  start(text?: string, assertCurrent?: () => void, options?: { running?: boolean }): void;
  onItemEvent(payload: ClickClackItemEventPayload, assertCurrent?: () => void): false;
  /** Resolves only when this item's frame is accepted, excluded, or fails; queueing is not delivery. */
  publishItem(
    payload: ClickClackItemEventPayload,
    assertCurrent: () => void,
  ): Promise<ClickClackProgressPublication>;
  setStatus(text: string, assertCurrent: () => void, options?: { running?: boolean }): void;
  flush(): Promise<void>;
  finalize(): Promise<void>;
};

type ProgressLine = {
  id: string;
  kind: string;
  text: string;
  status?: string;
  tool_name?: string;
};
type ProgressLineFrame = {
  op: "append" | "update" | "finalize";
  line: ProgressLine;
};
type ProgressFrame = ProgressLineFrame | { op: "clear" };

type QueuedProgressFrame = {
  lineId?: string;
  payload: ProgressFrame;
  assertCurrent?: () => void;
  settle?: (result: ClickClackProgressPublication) => void;
};

const CLICKCLACK_PROGRESS_UPDATE_INTERVAL_MS = 100;
const CLICKCLACK_PROGRESS_FINALIZE_GRACE_MS = 1_000;

export function createClickClackAgentProgressPublisher(params: {
  client: ClickClackProgressClient;
  target: ClickClackProgressTarget;
  turnId: string;
  agentLabel?: string;
  onError?: (error: unknown) => void;
}): ClickClackAgentProgressPublisher {
  let sequence = 0;
  const queue: QueuedProgressFrame[] = [];
  const queuedLines = new Map<string, QueuedProgressFrame>();
  let drainPromise: Promise<void> | undefined;
  let lineDrainTimer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let cleared = false;
  const seenLines = new Set<string>();
  // ClickClack upserts all content-bearing line operations by ID, including
  // unknown updates. Keep attempted content so an ACK-lost write is safe to re-offer.
  const retainedLines = new Map<string, ProgressLineFrame>();
  let rebuildPending = false;
  let discardedLineGeneration = 0;
  const resolveLineId = createLineIdResolver();

  const publishFrame = async (
    payload: ProgressFrame,
    assertCurrent?: () => void,
  ): Promise<void> => {
    assertCurrent?.();
    await params.client.publishEphemeral({
      ...params.target,
      type: "agent.progress",
      payload: { turn_id: params.turnId, seq: ++sequence, ...payload },
    });
    assertCurrent?.();
  };

  const drain = (): Promise<void> => {
    if (drainPromise) {
      return drainPromise;
    }
    drainPromise = (async () => {
      while (queue.length > 0) {
        const frame = queue.shift();
        if (!frame) {
          continue;
        }
        if (frame.lineId && queuedLines.get(frame.lineId) === frame) {
          queuedLines.delete(frame.lineId);
        }
        try {
          frame.assertCurrent?.();
          const payload = frame.payload;
          if (payload.op === "clear") {
            retainedLines.clear();
            rebuildPending = true;
            await publishFrame(payload, frame.assertCurrent);
            rebuildPending = false;
          } else {
            const prior = retainedLines.get(payload.line.id);
            const op = payload.op === "finalize" ? "finalize" : prior ? "update" : "append";
            if (payload.line.text) {
              retainedLines.set(payload.line.id, {
                op: payload.op === "finalize" || prior?.op === "finalize" ? "finalize" : "update",
                line: payload.line,
              });
            } else {
              retainedLines.delete(payload.line.id);
              // Empty updates retain prior text in ClickClack. Clear the turn
              // and restore its surviving lines to actually retract one item.
              rebuildPending = true;
            }
            if (rebuildPending) {
              const generation = discardedLineGeneration;
              await publishFrame({ op: "clear" }, frame.assertCurrent);
              for (const retained of retainedLines.values()) {
                if (generation !== discardedLineGeneration) {
                  throw new Error("ClickClack progress finalization grace expired");
                }
                await publishFrame(retained, frame.assertCurrent);
              }
              // A failed or superseded clear/replay remains pending; the next
              // current observation reconciles it before acknowledging any item.
              rebuildPending = false;
            } else {
              await publishFrame({ ...payload, op }, frame.assertCurrent);
            }
          }
          frame.settle?.("delivered");
        } catch (error) {
          frame.settle?.("failed");
          try {
            params.onError?.(error);
          } catch {
            // Progress reporting must never affect the agent turn.
          }
        }
      }
    })().finally(() => {
      drainPromise = undefined;
      if (queue.length > 0) {
        void drain();
      }
    });
    return drainPromise;
  };

  const enqueue = (payload: ProgressFrame, assertCurrent?: () => void): void => {
    queue.push({ payload, assertCurrent });
    void drain();
  };

  const flushQueuedLines = (): void => {
    for (const [lineId, frame] of queuedLines) {
      queuedLines.delete(lineId);
      queue.push(frame);
    }
    void drain();
  };

  const discardQueuedLines = (): void => {
    discardedLineGeneration += 1;
    for (const frame of queuedLines.values()) {
      frame.settle?.("failed");
    }
    for (const frame of queue) {
      if (frame.lineId) {
        frame.settle?.("failed");
      }
    }
    queuedLines.clear();
    const controlFrames = queue.filter((frame) => !frame.lineId);
    queue.splice(0, queue.length, ...controlFrames);
  };

  const waitForDrainWithinFinalizeGrace = async (pending: Promise<void>): Promise<boolean> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let drained = false;
    try {
      await Promise.race([
        pending.then(() => {
          drained = true;
        }),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, CLICKCLACK_PROGRESS_FINALIZE_GRACE_MS);
        }),
      ]);
      return drained;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  };

  const scheduleLineDrain = (): void => {
    if (lineDrainTimer) {
      return;
    }
    lineDrainTimer = setTimeout(() => {
      lineDrainTimer = undefined;
      flushQueuedLines();
    }, CLICKCLACK_PROGRESS_UPDATE_INTERVAL_MS);
  };

  const enqueueLine = (
    lineId: string,
    payload: ProgressLineFrame,
    assertCurrent?: () => void,
    settle?: (result: ClickClackProgressPublication) => void,
  ): void => {
    const queued = queuedLines.get(lineId);
    if (queued) {
      // Preserve an initial append while the request is in flight, but keep
      // only the newest line contents. A completion must still win so the
      // client can mark the line finalized when both arrive in one window.
      const op =
        payload.op === "finalize"
          ? "finalize"
          : queued.payload.op === "append"
            ? "append"
            : payload.op;
      queued.settle?.("failed");
      queued.payload = { ...payload, op };
      queued.assertCurrent = assertCurrent;
      queued.settle = settle;
      return;
    }
    const frame = { lineId, payload, assertCurrent, settle };
    queuedLines.set(lineId, frame);
    scheduleLineDrain();
  };

  const pushItem = (
    payload: ClickClackItemEventPayload,
    assertCurrent?: () => void,
    settle?: (result: ClickClackProgressPublication) => void,
  ) => {
    if (!started || cleared) {
      settle?.("failed");
      return;
    }
    assertCurrent?.();
    if (
      payload.suppressChannelProgress ||
      (payload.kind === "preamble" && !isCompleteAgentPreamble(payload))
    ) {
      settle?.("skipped");
      return;
    }
    const id = resolveLineId(payload);
    if (payload.hideFromChannelProgress) {
      const known = seenLines.delete(id);
      if (known || settle) {
        // An observing consumer retains possibly-published IDs until removal
        // acknowledges, so a blocked retraction must be safe to offer again.
        enqueueLine(
          id,
          { op: "update", line: { id, kind: normalizedKind(payload), text: "" } },
          assertCurrent,
          settle,
        );
      }
      return;
    }
    const final = isFinal(payload);
    const kind = normalizedKind(payload);
    const retractsExistingCommentary =
      kind === "commentary" &&
      seenLines.has(id) &&
      payload.progressText !== undefined &&
      payload.progressText.trim() === "";
    if (retractsExistingCommentary && queuedLines.get(id)?.payload.op === "append") {
      queuedLines.get(id)?.settle?.("failed");
      queuedLines.delete(id);
      seenLines.delete(id);
      settle?.("skipped");
      return;
    }
    const line: ProgressLine = {
      id,
      kind,
      text: retractsExistingCommentary ? "" : progressText(payload),
      status: payload.status?.trim() || (final ? "blocked" : "running"),
    };
    if (payload.name?.trim()) {
      line.tool_name = payload.name.trim();
    }
    enqueueLine(
      id,
      {
        op: final ? "finalize" : seenLines.has(id) ? "update" : "append",
        line,
      },
      assertCurrent,
      settle,
    );
    seenLines.add(id);
  };

  return {
    start(text, assertCurrent, options) {
      if (started && !(cleared && assertCurrent)) {
        return;
      }
      assertCurrent?.();
      // Only a fresh task-owner assertion may resume a temporarily unavailable
      // native observation; retain the original correlation and sequence.
      if (cleared) {
        cleared = false;
        seenLines.clear();
      }
      started = true;
      enqueue(
        {
          op: "append",
          line: {
            id: "turn",
            kind: "commentary",
            text:
              text ??
              (params.agentLabel ? `${params.agentLabel} is responding` : "Agent is responding"),
            ...(options?.running === false ? {} : { status: "running" }),
          },
        },
        assertCurrent,
      );
    },
    setStatus(text, assertCurrent, options) {
      if (!started || cleared) {
        return;
      }
      assertCurrent();
      enqueueLine(
        "turn",
        {
          op: "update",
          line: {
            id: "turn",
            kind: "commentary",
            text,
            ...(options?.running === true ? { status: "running" } : {}),
          },
        },
        assertCurrent,
      );
    },
    async flush() {
      if (lineDrainTimer) {
        clearTimeout(lineDrainTimer);
        lineDrainTimer = undefined;
      }
      flushQueuedLines();
      let currentDrain = drainPromise;
      while (currentDrain) {
        await currentDrain;
        currentDrain = drainPromise;
      }
    },
    onItemEvent(payload, assertCurrent) {
      pushItem(payload, assertCurrent);
      return false;
    },
    publishItem(payload, assertCurrent) {
      const result = createDeferred<ClickClackProgressPublication>();
      pushItem(payload, assertCurrent, result.resolve);
      return result.promise;
    },
    async finalize() {
      if (!started || cleared) {
        return;
      }
      cleared = true;
      if (lineDrainTimer) {
        clearTimeout(lineDrainTimer);
        lineDrainTimer = undefined;
      }
      flushQueuedLines();
      enqueue({ op: "clear" });
      const drained = await waitForDrainWithinFinalizeGrace(drain());
      if (!drained) {
        // Once the durable reply has been sent and the grace period expires,
        // stale detail frames no longer help the user. Keep only control frames
        // so the background queue reaches the best-effort clear promptly.
        discardQueuedLines();
      }
    },
  };
}
