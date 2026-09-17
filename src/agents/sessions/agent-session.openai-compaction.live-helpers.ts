import { shouldCompact } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { resolveEffectiveCompactionReserveTokens } from "../agent-compaction-constants.js";
import { DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR } from "../agent-settings.js";

/** Require measured pressure before the live checkpoint probe submits its next turn. */
export function resolveCheckpointFixtureContextTokens(seedContextTokens: number): number {
  const contextTokens = Math.max(8_000, seedContextTokens + 1_024);
  const reserveTokens = resolveEffectiveCompactionReserveTokens({
    contextTokenBudget: contextTokens,
    reserveTokens: DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR,
  });
  if (
    !shouldCompact(seedContextTokens, contextTokens, {
      enabled: true,
      reserveTokens,
      keepRecentTokens: 1_024,
    })
  ) {
    throw new Error(
      `Checkpoint fixture did not create compaction pressure: seed=${seedContextTokens}, ` +
        `window=${contextTokens}, reserve=${reserveTokens}. No checkpoint turn was submitted.`,
    );
  }
  return contextTokens;
}
