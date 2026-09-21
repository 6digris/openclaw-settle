import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunRecoveryCapture,
  recordUpdateRunStep,
} from "./update-run-ledger.js";

const dirs = createTempDirTracker();
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

it.each([1, 16])(
  "retains %i exact recovery receipts outside diagnostic redaction and eviction",
  (count) => {
    const state = dirs.make("update-receipt-ledger-");
    const options = { env: { OPENCLAW_STATE_DIR: state }, redactPaths: [state] };
    const run = createUpdateRun({ trigger: "cli" }, options);
    const configWrites = Array.from({ length: count }, (_, index) => ({
      path: path.join(state, `config-${index}.json`),
      beforeHash: "b".repeat(64),
      afterHash: "c".repeat(64),
      contiguous: true,
    }));
    const assertCurrent = vi.fn();
    recordUpdateRunRecoveryCapture(
      run.runId,
      { manifestSha256: "a".repeat(64), configWrites },
      assertCurrent,
      options,
    );
    // A subsequent ordinary update must not truncate or redact recovery authority.
    recordUpdateRunStep(
      run.runId,
      {
        step: "doctor",
        status: "completed",
        detail: `Read ${state}/config-0.json; token=synthetic-test-token`,
      },
      options,
    );
    const stored = getUpdateRun(run.runId, options)!;
    expect(assertCurrent).toHaveBeenCalled();
    expect(stored.origin.updateRecoveryCapture?.configWrites).toEqual(
      configWrites.toSorted((left, right) => left.path.localeCompare(right.path)),
    );
    expect(stored.origin.updateRecoveryCapture?.manifestSha256).toBe("a".repeat(64));
    expect(stored.steps.at(-1)?.detail).not.toContain(state);
    expect(stored.steps.at(-1)?.detail).not.toContain("synthetic-test-token");
  },
);

it("refuses oversized recovery receipts without replacing prior recorded recovery", () => {
  const state = dirs.make("update-receipt-budget-");
  const options = { env: { OPENCLAW_STATE_DIR: state } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const entry = {
    path: path.join(state, "config.json"),
    beforeHash: "b".repeat(64),
    afterHash: "c".repeat(64),
    contiguous: true,
  };
  recordUpdateRunRecoveryCapture(
    run.runId,
    { manifestSha256: "a".repeat(64), configWrites: [entry] },
    () => {},
    options,
  );
  const prior = getUpdateRun(run.runId, options);
  expect(() =>
    recordUpdateRunRecoveryCapture(
      run.runId,
      {
        manifestSha256: "a".repeat(64),
        configWrites: Array.from({ length: 128 }, (_, index) => ({
          ...entry,
          path: path.join(state, `config-${index}.json`),
        })),
      },
      () => {},
      options,
    ),
  ).toThrow("recovery receipts exceed the origin byte limit");
  expect(getUpdateRun(run.runId, options)).toEqual(prior);
});

it.each([16382, 16383, 16384, 16385])(
  "admits exactly in-budget receipts and refuses overflow at %i bytes",
  (bytes) => {
    const state = dirs.make("update-receipt-exact-budget-");
    const options = { env: { OPENCLAW_STATE_DIR: state } };
    const run = createUpdateRun({ trigger: "cli", origin: { doctorHint: "optional" } }, options);
    const configWrites = Array.from({ length: 8 }, (_, index) => ({
      path: `/config-${index}-`,
      beforeHash: "b".repeat(64),
      afterHash: "c".repeat(64),
      contiguous: true,
    }));
    const capture = {
      manifestSha256: "a".repeat(64),
      configWrites,
      status: "pending" as const,
    };
    const { doctorHint: _doctorHint, ...retained } = run.origin;
    const origin = { ...retained, updateRecoveryCapture: capture };
    let padding = bytes - Buffer.byteLength(JSON.stringify(origin));
    for (const entry of configWrites) {
      const added = Math.min(padding, 4096 - entry.path.length);
      entry.path += "x".repeat(added);
      padding -= added;
    }
    expect(padding).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(origin))).toBe(bytes);
    const record = () => recordUpdateRunRecoveryCapture(run.runId, capture, () => {}, options);
    if (bytes > 16384) {
      expect(record).toThrow("recovery receipts exceed the origin byte limit");
      expect(getUpdateRun(run.runId, options)).toEqual(run);
    } else {
      record();
      const stored = getUpdateRun(run.runId, options)!;
      expect(stored.origin.updateRecoveryCapture).toEqual(capture);
      expect(Buffer.byteLength(JSON.stringify(stored.origin))).toBe(bytes);
      expect(stored.origin.doctorHint).toBeUndefined();
    }
  },
);
