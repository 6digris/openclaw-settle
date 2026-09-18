import {
  createAgentHarnessAttemptDeadlineController,
  type AgentHarnessAttemptTimeout,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS } from "./attempt-timeouts.js";

export type CodexAttemptTimeout = AgentHarnessAttemptTimeout;

/** Applies Codex's settlement budget to the shared attempt deadline lifecycle. */
export function createCodexAttemptDeadlineController(
  params: Omit<
    Parameters<typeof createAgentHarnessAttemptDeadlineController>[0],
    "settlementTimeoutMs"
  >,
) {
  return createAgentHarnessAttemptDeadlineController({
    ...params,
    settlementTimeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
  });
}
