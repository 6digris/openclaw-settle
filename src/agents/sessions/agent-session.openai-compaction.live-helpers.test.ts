import { describe, expect, it } from "vitest";
import { resolveCheckpointFixtureContextTokens } from "./agent-session.openai-compaction.live-helpers.js";

describe("checkpoint fixture pressure", () => {
  it.each([5_000, 6_000])(
    "rejects seed usage %i that does not cross the unchanged floor threshold",
    (usage) => {
      expect(() => resolveCheckpointFixtureContextTokens(usage)).toThrow(
        `Checkpoint fixture did not create compaction pressure: seed=${usage}, window=8000, reserve=2000`,
      );
    },
  );
  it.each([
    [6_001, 8_000],
    [7_000, 8_024],
    [20_000, 21_024],
  ])(
    "keeps the original window construction for pressure-producing usage %i",
    (usage, expectedWindow) => {
      expect(resolveCheckpointFixtureContextTokens(usage)).toBe(expectedWindow);
    },
  );
});
