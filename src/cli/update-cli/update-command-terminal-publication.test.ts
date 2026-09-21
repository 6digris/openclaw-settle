import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { publishSettledUpdateCommandResult } from "./update-command-terminal-publication.js";

const terminal = vi.hoisted(() => ({ settle: vi.fn(), publish: vi.fn() }));
vi.mock("./update-command-terminal.js", () => ({
  resolveSettledUpdateCommandResult: terminal.settle,
  publishUpdateCommandTerminalResult: terminal.publish,
}));

const result: UpdateRunResult = { status: "ok", mode: "git", steps: [], durationMs: 0 };
const params = { opts: {}, root: "/synthetic-update", startedAt: 0 };
type ReportingState = {
  notify?: (result: UpdateRunResult) => Promise<void>;
  rolledBack: boolean;
  pendingRestartAtMs?: number;
  completedDowntimeMs?: number;
};
beforeEach(() => {
  vi.clearAllMocks();
  terminal.publish.mockImplementation((_params, value: UpdateRunResult) => value);
});

it("reads notification and completed downtime after settlement finishes", async () => {
  const settlement = createDeferred<{
    result: UpdateRunResult;
    settlementFailed: boolean;
  }>();
  terminal.settle.mockReturnValueOnce(settlement.promise);
  const notify = vi.fn(async () => undefined);
  let current: ReportingState = { rolledBack: false, pendingRestartAtMs: 10 };
  const publication = publishSettledUpdateCommandResult(params, {
    pendingResult: result,
    readReportingState: () => current,
  });
  current = { notify, rolledBack: true, completedDowntimeMs: 40 };
  settlement.resolve({ result, settlementFailed: false });
  await publication;
  expect(notify).toHaveBeenCalledOnce();
  expect(terminal.publish).toHaveBeenCalledWith(
    params,
    expect.objectContaining({ status: "ok" }),
    { rolledBack: true, downtimeMs: 40, captured: undefined },
    undefined,
  );
});

it("refreshes rollback and downtime after notification without reevaluating outage completion", async () => {
  terminal.settle.mockResolvedValueOnce({ result, settlementFailed: false });
  const current: ReportingState = { rolledBack: false, completedDowntimeMs: 20 };
  current.notify = async () => {
    await Promise.resolve();
    current.rolledBack = true;
    current.completedDowntimeMs = 50;
    current.pendingRestartAtMs = 100;
  };
  await publishSettledUpdateCommandResult(params, {
    pendingResult: result,
    readReportingState: () => current,
  });
  expect(terminal.publish).toHaveBeenCalledWith(
    params,
    expect.objectContaining({ status: "ok" }),
    { rolledBack: true, downtimeMs: 50, captured: undefined },
    undefined,
  );
});

it.each([
  undefined,
  { serviceRestartSafe: false, reason: "state-migration-started" },
  {
    serviceRestartSafe: true,
    packageRollbackVerified: true,
    version: "2026.9.3",
    service: "healthy",
  },
] satisfies Array<UpdateRunResult["recovery"]>)(
  "publishes unsafe recovery after failed settlement despite prior recovery %j",
  async (recovery) => {
    const pending: UpdateRunResult = { ...result, status: "error", recovery };
    terminal.settle.mockResolvedValueOnce({ result: pending, settlementFailed: true });
    const notify = vi.fn(async () => undefined);
    const published = await publishSettledUpdateCommandResult(params, {
      pendingResult: pending,
      readReportingState: () => ({ notify, rolledBack: true, completedDowntimeMs: 40 }),
    });
    expect(published.recovery).toEqual({
      serviceRestartSafe: false,
      reason: "runtime-verification-failed",
    });
    expect(notify).toHaveBeenCalledWith(published);
    expect(terminal.publish).toHaveBeenCalledWith(
      params,
      published,
      { rolledBack: false, downtimeMs: undefined, captured: undefined },
      undefined,
    );
    expect(pending.recovery).toEqual(recovery);
  },
);

it("preserves verified recovery after successful settlement", async () => {
  const recovery: UpdateRunResult["recovery"] = {
    serviceRestartSafe: true,
    packageRollbackVerified: true,
    version: "2026.9.3",
    service: "healthy",
  };
  const pending: UpdateRunResult = { ...result, status: "error", recovery };
  terminal.settle.mockResolvedValueOnce({ result: pending, settlementFailed: false });
  const published = await publishSettledUpdateCommandResult(params, {
    pendingResult: pending,
    readReportingState: () => ({ rolledBack: true, completedDowntimeMs: 40 }),
  });
  expect(published.recovery).toEqual(recovery);
  expect(terminal.publish).toHaveBeenCalledWith(
    params,
    published,
    { rolledBack: true, downtimeMs: 40, captured: undefined },
    undefined,
  );
});
