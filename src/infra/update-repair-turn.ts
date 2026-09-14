import { z } from "zod";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { truncateUtf8Suffix } from "../utils/utf8-truncate.js";
import type { runUpdateRepairTurn } from "./update-repair-agent.runtime.js";
import type { UpdateRepairTarget, UpdateRepairTurnRunner } from "./update-repair-protocol.js";

const resultLineSchema = z.object({
  status: z.enum(["fixed", "partial", "not-fixed"]),
  summary: z.string().max(1024),
});

export function repairSummary(text: string, target: UpdateRepairTarget): string {
  const lastLine = text.trim().split(/\r?\n/u).at(-1) ?? "";
  let summary = text.trim() || "The agent returned no repair result.";
  if (lastLine.startsWith("REPAIR_RESULT:")) {
    try {
      const parsed = resultLineSchema.safeParse(
        JSON.parse(lastLine.slice("REPAIR_RESULT:".length)),
      );
      if (parsed.success) {
        summary = parsed.data.summary;
      }
    } catch {
      // Missing/garbled declarations are not fixed; only the oracle proves success.
    }
  }
  const redacted = redactSupportString(
    summary,
    { env: process.env, stateDir: target.stateDir },
    { maxLength: Number.MAX_SAFE_INTEGER },
  );
  return truncateUtf8Suffix(redacted, 1024);
}

export async function runLocalUpdateRepairTurn(params: Parameters<typeof runUpdateRepairTurn>[0]) {
  const runtime = await import("./update-repair-agent.runtime.js");
  const outcome = await runtime.withUpdateRepairEnvironment(params.target, () =>
    runtime.runUpdateRepairTurn(params),
  );
  if (outcome.status === "unavailable") {
    return outcome;
  }
  return {
    status: "completed" as const,
    model: outcome.envelope.model ?? params.route.model,
    provider: outcome.envelope.provider ?? params.route.provider,
    toolCalls: outcome.toolCalls,
    summary: repairSummary(
      outcome.envelope.final || outcome.envelope.error?.message || "",
      params.target,
    ),
    timedOut: outcome.envelope.status === "timeout",
  };
}

/** Manual triage retains its route; unattended turns prepare it in the target process. */
export function createLocalUpdateRepairTurn(target: UpdateRepairTarget): UpdateRepairTurnRunner {
  let selected:
    | Awaited<
        ReturnType<typeof import("./update-repair-agent.runtime.js").prepareUpdateRepairInference>
      >
    | undefined;
  return async (params) => {
    const deadline = Date.now() + params.wallClockMs;
    const runtime = await import("./update-repair-agent.runtime.js");
    params.isCurrent();
    selected ??= await runtime.withUpdateRepairEnvironment(target, () =>
      runtime.prepareUpdateRepairInference(params.signal, Math.max(1, deadline - Date.now())),
    );
    params.isCurrent();
    if (!selected.ok) {
      return { status: "unavailable", reason: repairSummary(selected.reason, target) };
    }
    const { route, modelFallbacks } = selected;
    const timeoutMs = Math.min(params.timeoutMs, deadline - Date.now());
    if (timeoutMs <= 0) {
      throw new Error("wall-clock-budget");
    }
    params.onRoute({ model: route.model, provider: route.provider });
    const controller = new AbortController();
    const signal = AbortSignal.any([params.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(new Error("per-turn-budget")), timeoutMs);
    try {
      const outcome = await runLocalUpdateRepairTurn({
        ...params,
        target,
        route,
        modelFallbacks,
        timeoutMs,
        signal,
        isCurrent: () => {
          signal.throwIfAborted();
          return params.isCurrent();
        },
      });
      return outcome.status === "completed"
        ? { ...outcome, timedOut: outcome.timedOut || controller.signal.aborted }
        : outcome;
    } finally {
      clearTimeout(timer);
    }
  };
}
