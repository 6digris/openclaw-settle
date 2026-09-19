import { afterEach, expect, it, vi } from "vitest";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunPhase,
} from "../infra/update-run-ledger.js";
import * as reader from "../infra/update-run-reader.js";
import {
  beginGatewayRestartSignalAdmission,
  beginGatewayUpdateSettlementAdmission,
  isGatewaySubordinateWorkAdmissionClosed,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  beginGatewayUpdateStartupAdmission,
  refreshGatewayUpdateStartupAdmission,
} from "./update-startup-admission.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});

it("waits for the exact successor run, not another terminal run or a missing ledger row", async () => {
  await withOpenClawTestState({ layout: "state-only", scenario: "minimal" }, async (state) => {
    const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
    recordUpdateRunPhase(run.runId, "activating", undefined, { env: state.env });
    const startup = beginGatewayUpdateStartupAdmission()!;
    try {
      expect(isGatewayWorkAdmissionClosed()).toBe(true);
      expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(true);
      expect(tryBeginGatewayRootWorkAdmission("agent:late-writer")).toBeNull();
      const read = vi.spyOn(reader, "getUpdateRun").mockReturnValueOnce(undefined);
      expect(refreshGatewayUpdateStartupAdmission()).toBe(true);
      read.mockRestore();
      const other = createUpdateRun({ trigger: "cli" }, { env: state.env });
      finishUpdateRun(other.runId, { status: "succeeded" }, { env: state.env });
      expect(refreshGatewayUpdateStartupAdmission()).toBe(true);
      finishUpdateRun(run.runId, { status: "succeeded" }, { env: state.env });
      expect(refreshGatewayUpdateStartupAdmission()).toBe(false);
      await startup.settled;
      const work = tryBeginGatewayRootWorkAdmission("agent:after-settlement");
      expect(work).not.toBeNull();
      work?.release();
    } finally {
      startup.close();
    }
  });
});

it("cannot reopen a newer restart fence when update settlement releases", () => {
  const update = beginGatewayUpdateSettlementAdmission("exact-update");
  const restart = beginGatewayRestartSignalAdmission()!;
  update.release();
  expect(isGatewayWorkAdmissionClosed()).toBe(true);
  restart.rollback();
  expect(isGatewayWorkAdmissionClosed()).toBe(false);
});
