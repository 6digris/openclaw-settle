import { describe, expect, it } from "vitest";
import { validateDiagnosticsVitalsParams, validateDiagnosticsVitalsResult } from "../index.js";

const processMemory = { rssBytes: 5120, heapUsedBytes: 3072, heapTotalBytes: 4096 };

describe("diagnostics.vitals wire contract", () => {
  it("accepts a memory sample before the first event-loop window completes", () => {
    expect(validateDiagnosticsVitalsParams({})).toBe(true);
    expect(validateDiagnosticsVitalsResult({ processMemory })).toBe(true);
  });

  it.each([{ includeChannelSummary: false }, { agentId: "main" }, { limit: 100 }])(
    "rejects inventory options %j",
    (params) => {
      expect(validateDiagnosticsVitalsParams(params)).toBe(false);
    },
  );

  it.each([
    {},
    { processMemory, tasks: {} },
    { processMemory: { ...processMemory, rssBytes: -1 } },
    { processMemory: { ...processMemory, heapUsedBytes: "3072" } },
  ])("rejects malformed or expanded snapshots %j", (result) => {
    expect(validateDiagnosticsVitalsResult(result)).toBe(false);
  });
});
