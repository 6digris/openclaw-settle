import { flushDiagnosticsTimeline } from "../../infra/diagnostics-timeline.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import { flushLogger } from "../../logging/logger.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { GatewayRunSignalAction } from "./run-loop-request.js";

export async function flushGatewayLogsBeforeExit(
  logger: { warn: (message: string) => void },
  timeoutMs = 4_000,
) {
  flushDiagnosticsTimeline();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const flushed = await Promise.race([
    flushLogger().then(() => true),
    new Promise<false>((resolve) => {
      flushTimer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(flushTimer);
  if (!flushed) {
    logger.warn(`log flush did not settle within ${timeoutMs}ms; continuing shutdown`);
  }
}

const RESTART_DRAIN_STILL_PENDING_WARN_MS = 30_000;

// Blocker descriptions can contain task identities and request origins.
export function formatDrainCounts(snapshot: GatewayActiveWorkSnapshot): string {
  return Object.entries(snapshot.counts)
    .filter(([name, count]) => name !== "totalActive" && count > 0)
    .map(([name, count]) => `${name}=${count}`)
    .join(" ");
}

export function createGatewayDrainReporter(
  action: GatewayRunSignalAction,
  drainTimeoutMs: number | undefined,
  runtime: Pick<
    typeof import("./lifecycle.runtime.js"),
    "listActiveEmbeddedRunSessionIds" | "getDiagnosticSessionActivitySnapshot"
  >,
  logger: Pick<SubsystemLogger, "info" | "warn">,
  recordCounts: (counts: string) => void,
) {
  const drainBudget =
    drainTimeoutMs === undefined ? "without a timeout" : `with timeout ${drainTimeoutMs}ms`;
  let lastPendingWarningAt: number | undefined;
  return (snapshot: GatewayActiveWorkSnapshot) => {
    recordCounts(formatDrainCounts(snapshot) || "no active work");
    const now = Date.now();
    if (lastPendingWarningAt === undefined) {
      lastPendingWarningAt = now;
      if (!snapshot.idle) {
        logger.info(
          `draining active work before ${action} ${drainBudget}: ${formatDrainCounts(snapshot)}`,
        );
        const requestTimeoutMs = Math.max(
          0,
          ...runtime
            .listActiveEmbeddedRunSessionIds()
            .map(
              (sessionId) =>
                runtime.getDiagnosticSessionActivitySnapshot({ sessionId })
                  ?.activeModelCallRequestTimeoutMs ?? 0,
            ),
        );
        if (requestTimeoutMs > 0) {
          logger.info(
            `largest observed model request timeout is ${requestTimeoutMs}ms; shutdown drain budget remains ${drainBudget}`,
          );
        }
      }
    } else if (
      !snapshot.idle &&
      now - lastPendingWarningAt >= RESTART_DRAIN_STILL_PENDING_WARN_MS
    ) {
      lastPendingWarningAt = now;
      logger.warn(`still draining active work before ${action}: ${formatDrainCounts(snapshot)}`);
    }
  };
}
