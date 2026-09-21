import { beforeEach, expect, it, vi } from "vitest";
import { LEGACY_UPDATE_RUN_EXPIRED_REASON } from "./update-run-legacy-expiry.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import { readUpdateRunStatus } from "./update-run-status.js";

const mocks = vi.hoisted(() => ({
  findActiveUpdateRun: vi.fn<typeof import("./update-run-ledger.js").findActiveUpdateRun>(),
  listUpdateRuns: vi.fn<typeof import("./update-run-ledger.js").listUpdateRuns>(),
  reconcileAbandonedUpdateRuns: vi.fn(),
}));
vi.mock("./update-run-ledger.js", () => mocks);
vi.mock("./update-run-activity.js", () => ({
  inspectUpdateRunAbandonment: vi.fn(),
  staleUpdateRunGuidance: vi.fn(),
}));

function record(runId: string): UpdateRunRecord {
  return {
    runId,
    createdAtMs: 1,
    updatedAtMs: 2,
    trigger: "cli",
    phase: "finished",
    status: "failed",
    reason: null,
    origin: {},
    target: {},
    before: {},
    after: {},
    steps: [],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: 2,
    downtimeMs: null,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

it.each([
  { acknowledged: false, unprotected: false },
  { acknowledged: false, unprotected: true },
  { acknowledged: true, unprotected: false },
  { acknowledged: true, unprotected: true },
])(
  "keeps expiry acknowledgment independent of current-run protection ($acknowledged/$unprotected)",
  ({ acknowledged, unprotected }) => {
    const expired = {
      ...record("11111111-1111-4111-8111-111111111111"),
      reason: LEGACY_UPDATE_RUN_EXPIRED_REASON,
    };
    if (acknowledged) {
      expired.steps.push({ step: "reconcile:acknowledged", status: "completed" });
    }
    const current = record("22222222-2222-4222-8222-222222222222");
    if (unprotected) {
      current.origin.unprotectedGatewayUpdate = {
        owner: { host: "fixture-host", pid: 123, startIdentity: "456" },
      };
    }
    mocks.listUpdateRuns.mockImplementation((options) =>
      options?.reason === LEGACY_UPDATE_RUN_EXPIRED_REASON ? [expired] : [current],
    );
    const result = readUpdateRunStatus();
    expect(result.advisories?.map(({ reason }) => reason) ?? []).toEqual([
      ...(!acknowledged ? [LEGACY_UPDATE_RUN_EXPIRED_REASON] : []),
      ...(unprotected ? ["unprotected-gateway-update"] : []),
    ]);
    expect(result.lastRun).toBe(current);
    expect(mocks.reconcileAbandonedUpdateRuns).toHaveBeenCalledExactlyOnceWith({
      legacyOnly: true,
    });
  },
);
