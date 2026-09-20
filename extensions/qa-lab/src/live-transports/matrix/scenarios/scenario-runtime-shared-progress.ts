import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  prepareSharedProgressFixtureConfig,
  sharedProgressWorkersAreHolding,
} from "../../shared/shared-progress-fixture.js";
import type { MatrixQaObservedEvent } from "../substrate/events.js";
import {
  advanceMatrixQaActorCursor,
  primeMatrixQaDriverScenarioClient,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

type ProgressRevision = {
  messageId: string;
  eventId: string;
  replacesEventId?: string;
  elapsedMs: number;
  originServerTs?: number;
  text: string;
  source: "matrix-sync-message" | "matrix-sync-m.replace";
};

export async function runMatrixSharedProgressScenario(
  context: MatrixQaScenarioContext,
  profile: "complete" | "cancel" | "restart" | "second-turn",
): Promise<MatrixQaScenarioExecution> {
  if (
    !context.gatewayCall ||
    !context.patchGatewayConfig ||
    !context.restartGateway ||
    !context.restartGatewayAfterStateMutation ||
    !context.outputDir ||
    !context.sutAccountId
  ) {
    throw new Error(
      "Matrix shared progress requires the maintained Gateway config/restart and artifact owners",
    );
  }
  // SAFETY: The owned Gateway's config.get returns its already validated OpenClaw configuration.
  const snapshot = (await context.gatewayCall("config.get", {})) as { config?: OpenClawConfig };
  if (!snapshot.config) {
    throw new Error("Matrix config.get returned no configuration");
  }
  const { run, endpoint, patch } = await prepareSharedProgressFixtureConfig(snapshot.config);
  await context.patchGatewayConfig(
    {
      ...patch,
      channels: {
        matrix: {
          accounts: {
            [context.sutAccountId]: {
              replyToMode: "off",
              threadReplies: "off",
              streaming: {
                mode: "progress",
                progress: { commentary: true, toolProgress: true, commandText: "raw" },
                preview: { toolProgress: true },
              },
            },
          },
        },
      },
    },
    { replacePaths: ["agents", "tools"], restartDelayMs: 0 },
  );
  await context.restartGateway();

  const { client, startSince } = await primeMatrixQaDriverScenarioClient(context);
  let since = startSince;
  const startedAt = Date.now();
  const identities = new Map<string, string>();
  const label = (id: string) => {
    if (!identities.has(id)) {
      identities.set(id, `event-${identities.size + 1}`);
    }
    return identities.get(id)!;
  };
  const revisions: ProgressRevision[] = [];
  const redactions: { eventId: string; redactsEventId: string; elapsedMs: number }[] = [];
  const lifecycle: Record<string, unknown>[] = [];
  const checks: { name: string; ok: boolean }[] = [];
  const steps = [
    "Run the parent command",
    "Wait for Maple and Cedar commands",
    "Summarize the delivered results",
  ];
  const seen = new Set<string>();
  const originalEvents = new Set<string>();
  let cardId: string | undefined;
  let gatePassed = false;
  let finalAt: number | undefined;
  const record = (event: MatrixQaObservedEvent) => {
    if (seen.has(event.eventId)) {
      return;
    }
    seen.add(event.eventId);
    if (event.redactsEventId && identities.has(event.redactsEventId)) {
      redactions.push({
        eventId: label(event.eventId),
        redactsEventId: label(event.redactsEventId),
        elapsedMs: Date.now() - startedAt,
      });
      return;
    }
    if (event.kind !== "message" && event.kind !== "notice") {
      return;
    }
    // Each Matrix edit is a new event. Only its outer m.replace target identifies
    // the retained card; the normalized relatesTo field describes logical threading.
    const originalId = event.replacesEventId ?? event.eventId;
    if (!identities.has(originalId) && !event.body?.includes(run)) {
      return;
    }
    const messageId = label(originalId);
    if (!event.replacesEventId) {
      originalEvents.add(messageId);
    }
    const revision: ProgressRevision = {
      messageId,
      eventId: label(event.eventId),
      ...(event.replacesEventId ? { replacesEventId: label(event.replacesEventId) } : {}),
      elapsedMs: Date.now() - startedAt,
      originServerTs: event.originServerTs,
      text: event.body ?? "",
      source: event.replacesEventId ? "matrix-sync-m.replace" : "matrix-sync-message",
    };
    revisions.push(revision);
    if (!cardId && steps.every((step) => revision.text.includes(step))) {
      cardId = messageId;
    }
  };
  let driverEventId: string | undefined;
  try {
    driverEventId = await client.sendTextMessage({
      body: `${context.sutUserId} SHARED_PROGRESS_PARENT run=${run}. Run the parent checklist and command, two real workers, yield, and report only delivered results.`,
      mentionUserIds: [context.sutUserId],
      roomId: context.roomId,
    });
    const deadline = startedAt + 240000;
    while (Date.now() < deadline) {
      const observed = await client.waitForOptionalRoomEvent({
        observedEvents: context.observedEvents,
        predicate: (event) => event.roomId === context.roomId && event.sender === context.sutUserId,
        roomId: context.roomId,
        since,
        timeoutMs: Math.min(1000, deadline - Date.now()),
      });
      since = observed.since ?? since;
      if (observed.matched) {
        record(observed.event);
      }
      const held = revisions.find(
        (row) =>
          row.messageId === cardId &&
          ["Maple: synthetic completion hold", "Cedar: synthetic completion hold"].every((needle) =>
            row.text.includes(needle),
          ),
      );
      if (
        profile !== "complete" &&
        !gatePassed &&
        held &&
        (await sharedProgressWorkersAreHolding(endpoint, run))
      ) {
        await sleep(1000);
        const action: Record<string, unknown> = {
          type: profile === "restart" ? "restartGateway" : "send",
          startedAt: new Date().toISOString(),
          startedAtMs: Date.now() - startedAt,
          triggerMessageId: cardId,
          triggerElapsedMs: held.elapsedMs,
          triggerReplacementEventId: held.eventId,
        };
        lifecycle.push(action);
        if (profile === "restart") {
          await context.restartGatewayAfterStateMutation(async () => {
            action.stoppedAtMs = Date.now() - startedAt;
          });
        } else {
          const eventId = await client.sendTextMessage({
            body: `${context.sutUserId} SHARED_PROGRESS_${profile === "cancel" ? "CANCEL" : "SECOND"} run=${run}. ${profile === "cancel" ? "Cancel Maple and Cedar by observed taskId and report confirmed receipts." : "Run the independent second foreground command without claiming the original workers completed."}`,
            mentionUserIds: [context.sutUserId],
            roomId: context.roomId,
          });
          action.sentEventId = label(eventId);
        }
        action.completedAtMs = Date.now() - startedAt;
        gatePassed = true;
      }
      const final =
        revisions.find(
          (row) =>
            row.messageId !== cardId &&
            row.text.includes(
              `SHARED_PROGRESS_${profile === "cancel" ? "CANCELLED" : "FINAL"} run=${run}`,
            ),
        ) ??
        (profile === "restart"
          ? revisions.find(
              (row) =>
                row.messageId !== cardId &&
                row.text.includes(`SHARED_PROGRESS_INTERRUPTED run=${run}`),
            )
          : undefined);
      if (final && finalAt === undefined) {
        finalAt = Date.now();
      }
      if (finalAt !== undefined && Date.now() - finalAt >= 60000) {
        break;
      }
    }
    const card = revisions.filter((row) => row.messageId === cardId);
    const waiting = card.find((row) => row.text.includes(`SHARED_PROGRESS_WAIT run=${run}`));
    const terminalStatuses =
      profile === "cancel"
        ? "cancelled"
        : profile === "restart"
          ? "succeeded|cancelled|failed|lost|timed_out"
          : "succeeded";
    const terminal = card.find((row) =>
      ["Maple", "Cedar"].every((name) =>
        new RegExp(`${name} \\((?:${terminalStatuses})\\)`, "u").test(
          row.text.replace(/[*`]/gu, ""),
        ),
      ),
    );
    checks.push(
      {
        name: "original_card_creation_observed",
        ok: cardId !== undefined && originalEvents.has(cardId),
      },
      {
        name: "matrix_edits_reference_original_event",
        ok: card.some((row) => row.replacesEventId === cardId && row.eventId !== cardId),
      },
      {
        name: "waiting_retains_checklist",
        ok: Boolean(waiting && steps.every((step) => waiting.text.includes(step))),
      },
      {
        name: "worker_activity_after_yield_same_event",
        ok: Boolean(
          waiting &&
          card.some(
            (row) =>
              row.elapsedMs > waiting.elapsedMs &&
              /(?:Maple|Cedar).*public (?:preparation|command activity)/u.test(row.text),
          ),
        ),
      },
      {
        name: "terminal_workers_preserve_checklist",
        ok: Boolean(terminal && steps.every((step) => terminal.text.includes(step))),
      },
      {
        name: "original_event_not_redacted",
        ok: Boolean(cardId && !redactions.some((row) => row.redactsEventId === cardId)),
      },
      { name: "separate_parent_final_observed", ok: finalAt !== undefined },
      {
        name: "sixty_second_observation_after_final",
        ok: finalAt !== undefined && Date.now() - finalAt >= 60000,
      },
      { name: "lifecycle_gate_completed", ok: profile === "complete" || gatePassed },
    );
    if (profile === "restart") {
      checks.push({
        name: "original_event_replaced_after_old_gateway_stopped",
        ok: card.some(
          (row) =>
            row.replacesEventId === cardId &&
            (row.originServerTs ?? 0) > startedAt + Number(lifecycle[0]?.stoppedAtMs),
        ),
      });
    }
    if (profile === "second-turn") {
      const second = revisions.find((row) => row.text.includes(`SHARED_SECOND_ACTIVE run=${run}`));
      checks.push({
        name: "second_foreground_has_distinct_original_event",
        ok: Boolean(second && second.messageId !== cardId && originalEvents.has(second.messageId)),
      });
      checks.push({
        name: "second_foreground_final_observed",
        ok: revisions.some((row) => row.text.includes(`SHARED_SECOND_FINAL run=${run}`)),
      });
      checks.push({
        name: "old_workers_never_replace_second_card",
        ok: Boolean(
          second &&
          !revisions.some(
            (row) =>
              row.messageId === second.messageId &&
              row.elapsedMs > second.elapsedMs &&
              row.text.includes(`SHARED_PROGRESS_WAIT run=${run}`),
          ),
        ),
      });
    }
    if (checks.some((check) => !check.ok)) {
      throw new Error(
        `Matrix shared progress predicates failed: ${checks
          .filter((check) => !check.ok)
          .map((check) => check.name)
          .join(", ")}`,
      );
    }
    return {
      details:
        "Observed real Tuwunel /sync lifecycle: retained original-event m.replace edits, real workers/yield, separate final and bounded observation; see shared-progress-evidence.json and actual provider receipts.",
    };
  } finally {
    advanceMatrixQaActorCursor({
      actorId: "driver",
      syncState: context.syncState,
      nextSince: since,
      startSince,
    });
    await fs.writeFile(
      path.join(context.outputDir, "shared-progress-evidence.json"),
      JSON.stringify(
        {
          run,
          profile,
          cardId,
          driverEventId: driverEventId ? label(driverEventId) : undefined,
          startedAt: new Date(startedAt).toISOString(),
          observationEndedAtMs: Date.now() - startedAt,
          driver: "maintained Matrix QA driver account and real disposable Tuwunel homeserver",
          renderer:
            "Matrix message/notice with m.replace referencing the original event; not native-client screenshot proof",
          identity:
            "eventId is each wire event; messageId/replacesEventId label the original m.replace target, not the logical thread relation",
          lifecycle,
          revisions,
          redactions,
          checks,
        },
        null,
        2,
      ),
    );
  }
}
