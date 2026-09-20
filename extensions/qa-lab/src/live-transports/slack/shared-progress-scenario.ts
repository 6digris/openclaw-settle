import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  isSharedProgressTerminalText,
  prepareSharedProgressFixtureConfig,
  sharedProgressWorkersAreHolding,
} from "../shared/shared-progress-fixture.js";
import type { SlackQaScenarioEnvironment } from "./scenario-environment.js";
import {
  collectSlackBlockText,
  isSutSlackMessage,
  listSlackMessages,
} from "./slack-live.observations.js";

// Opt-in lifecycle proof: the maintained adapter still owns credentials, capture,
// Gateway lifetime, and teardown. The fixture owns only model decisions.
export async function runSlackSharedProgressScenario(
  environment: SlackQaScenarioEnvironment,
  profile: "complete" | "cancel" | "restart" | "second-turn",
) {
  const { cfg } = await environment.configureScenario({
    configOverrides: {
      progress: { commentary: true, toolProgress: true, maxLines: 12 },
      replyToMode: "off",
    },
    buildRun: () => ({ expectReply: true, input: "", matchText: "" }),
  });
  const { run, endpoint, patch } = await prepareSharedProgressFixtureConfig(cfg);
  await environment.patchGatewayConfig(patch);
  await environment.context.waitForReady();
  const cursor = environment.getMessageWriteCursor();
  const startedAt = Date.now();
  const sent = await environment.context.postSlackMessage({
    text: `<@${environment.sutIdentity.userId}> SHARED_PROGRESS_PARENT run=${run}. Run the parent checklist and command, two real workers, yield, and report only delivered results.`,
  });
  const revisions: { messageId: string; elapsedMs: number; text: string; source: string }[] = [];
  const identities = new Map<string, string>();
  const seen = new Set<string>();
  const lifecycle: Record<string, unknown>[] = [];
  let cardId: string | undefined;
  let gatePassed = false;
  let terminalAt: number | undefined;
  let restartCursor: number | undefined;
  const steps = [
    "Run the parent command",
    "Wait for Maple and Cedar commands",
    "Summarize the delivered results",
  ];
  const checks: { name: string; ok: boolean }[] = [];
  const record = (ts: string, text: string, source: string) => {
    if (!identities.has(ts) && !text.includes(run)) {
      return;
    }
    const key = JSON.stringify([ts, text]);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    if (!identities.has(ts)) {
      identities.set(ts, `message-${identities.size + 1}`);
    }
    const messageId = identities.get(ts)!;
    revisions.push({ messageId, text, source, elapsedMs: Date.now() - startedAt });
    if (!cardId && steps.every((step) => text.includes(step))) {
      cardId = messageId;
    }
  };
  try {
    const deadline = startedAt + 240000;
    while (Date.now() < deadline) {
      if (restartCursor !== undefined) {
        for (const message of await environment.readMessageWrites(restartCursor)) {
          record(
            message.ts,
            [message.text, ...(message.blockText ?? [])].join("\n"),
            "accepted-slack-api-write-after-old-gateway-stopped",
          );
        }
      }
      const writes = await environment.readMessageWrites(cursor);
      for (const message of writes) {
        record(
          message.ts,
          [message.text, ...(message.blockText ?? [])].join("\n"),
          "accepted-slack-api-write",
        );
      }
      const held = revisions.find(
        (row) =>
          row.messageId === cardId &&
          ["Maple: synthetic completion hold", "Cedar: synthetic completion hold"].every((needle) =>
            row.text.includes(needle),
          ),
      );
      if (profile !== "complete" && !gatePassed && held) {
        if (await sharedProgressWorkersAreHolding(endpoint, run)) {
          await sleep(1000);
          const action: Record<string, unknown> = {
            type: profile === "restart" ? "restartGateway" : "send",
            startedAt: new Date().toISOString(),
            startedAtMs: Date.now() - startedAt,
            triggerMessageId: cardId,
            triggerElapsedMs: held.elapsedMs,
          };
          lifecycle.push(action);
          if (profile === "restart") {
            await environment.context.gateway.restartAfterStateMutation(async () => {
              action.stoppedAtMs = Date.now() - startedAt;
              restartCursor = environment.getMessageWriteCursor();
            });
            await environment.context.waitForReady();
          } else {
            await environment.context.postSlackMessage({
              text: `<@${environment.sutIdentity.userId}> SHARED_PROGRESS_${profile === "cancel" ? "CANCEL" : "SECOND"} run=${run}. ${profile === "cancel" ? "Cancel Maple and Cedar by observed taskId and report confirmed receipts." : "Run the independent second foreground command; do not claim the original workers completed."}`,
            });
          }
          action.completedAtMs = Date.now() - startedAt;
          gatePassed = true;
        }
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
      if (final && terminalAt === undefined) {
        terminalAt = Date.now();
      }
      if (terminalAt && Date.now() - terminalAt >= 60000) {
        break;
      }
      await sleep(500);
    }
    const stored = await listSlackMessages({
      channelId: environment.channelId,
      client: environment.context.sutReadClient,
      oldestTs: sent.ts,
    });
    const storedIds = new Set(
      stored
        .filter((message) => isSutSlackMessage(message, environment.sutIdentity))
        .map((message) => message.ts && identities.get(message.ts)),
    );
    for (const message of stored) {
      if (message.ts && isSutSlackMessage(message, environment.sutIdentity)) {
        record(
          message.ts,
          [message.text ?? "", ...collectSlackBlockText(message.blocks)].join("\n"),
          "slack-history-readback",
        );
      }
    }
    const card = revisions.filter((row) => row.messageId === cardId);
    const waiting = card.find((row) => row.text.includes(`SHARED_PROGRESS_WAIT run=${run}`));
    const terminal = card.find((row) => isSharedProgressTerminalText(row.text, profile));
    const storedCard = stored.find(
      (message) =>
        message.ts &&
        identities.get(message.ts) === cardId &&
        isSutSlackMessage(message, environment.sutIdentity),
    );
    const storedCardText = storedCard
      ? [storedCard.text ?? "", ...collectSlackBlockText(storedCard.blocks)].join("\n")
      : "";
    checks.push(
      { name: "original_checklist_card", ok: Boolean(cardId) },
      {
        name: "same_card_retains_wait_and_checklist",
        ok: Boolean(waiting && steps.every((step) => waiting.text.includes(step))),
      },
      {
        name: "worker_activity_after_yield",
        ok: Boolean(
          waiting &&
          card.some(
            (row) =>
              row.elapsedMs > waiting.elapsedMs &&
              /(?:Maple|Cedar).*public (?:preparation|command activity)/u.test(row.text),
          ),
        ),
      },
      { name: "card_still_stored", ok: storedIds.has(cardId) },
      {
        name: "terminal_workers_preserve_checklist",
        ok: Boolean(terminal && steps.every((step) => terminal.text.includes(step))),
      },
      {
        name: "stored_card_has_terminal_workers_and_checklist",
        ok:
          isSharedProgressTerminalText(storedCardText, profile) &&
          steps.every((step) => storedCardText.includes(step)),
      },
      { name: "separate_final_observed", ok: terminalAt !== undefined },
      {
        name: "sixty_second_observation_after_final",
        ok: terminalAt !== undefined && Date.now() - terminalAt >= 60000,
      },
      { name: "lifecycle_gate_completed", ok: profile === "complete" || gatePassed },
    );
    if (profile === "second-turn") {
      const second = revisions.find((row) => row.text.includes(`SHARED_SECOND_ACTIVE run=${run}`));
      checks.push({
        name: "second_turn_card_does_not_replace_old_card",
        ok: Boolean(second && second.messageId !== cardId),
      });
      checks.push({
        name: "second_turn_final_observed",
        ok: revisions.some((row) => row.text.includes(`SHARED_SECOND_FINAL run=${run}`)),
      });
    }
    if (profile === "restart") {
      checks.push({
        name: "old_card_reconciles_after_old_gateway_stopped",
        ok: card.some(
          (row) =>
            row.source === "accepted-slack-api-write-after-old-gateway-stopped" &&
            isSharedProgressTerminalText(row.text, profile),
        ),
      });
    }
    if (checks.some((check) => !check.ok)) {
      throw new Error(
        `Shared progress predicates failed: ${checks
          .filter((check) => !check.ok)
          .map((check) => check.name)
          .join(", ")}`,
      );
    }
    return {
      details:
        "Observed retained Slack card, real lifecycle action, separate final, and bounded observation; inspect shared-progress-evidence.json and provider receipts for the full result.",
    };
  } finally {
    await fs.writeFile(
      path.join(environment.outputDir, "shared-progress-evidence.json"),
      JSON.stringify(
        {
          run,
          profile,
          cardId,
          startedAt: new Date(startedAt).toISOString(),
          observationEndedAtMs: Date.now() - startedAt,
          driver: "maintained Slack QA driver bot",
          renderer: "portable chat.update (nativeTransport=false)",
          source:
            "successful Slack API writes plus final real history readback; not a visual capture or deletion-event recorder",
          lifecycle,
          revisions,
          checks,
        },
        null,
        2,
      ),
    );
  }
}
