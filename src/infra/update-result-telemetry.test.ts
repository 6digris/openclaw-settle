import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { buildUpdateResultPayload } from "./update-result-payload.js";
import * as outcomeTelemetry from "./update-result-telemetry.js";
import { sendUpdateResultTelemetry } from "./update-result-telemetry.js";
import {
  createUpdateRun,
  finishUpdateRun,
  finishInterruptedUpdateBeforeActivation,
  recordUpdateRunPhase,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";
import type { UpdateRunRecord } from "./update-run-record.js";

const dirs = createTempDirTracker();
const consent = { telemetry: { enabled: true, updateResults: true } };
function fixture(enabled = true) {
  const directory = dirs.make("update-result-");
  const configPath = path.join(directory, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify(enabled ? consent : { telemetry: { enabled: true } }),
  );
  return { env: { OPENCLAW_STATE_DIR: directory, OPENCLAW_CONFIG_PATH: configPath }, configPath };
}
function result(): UpdateRunRecord {
  return {
    runId: "8c68d9fc-135a-4fc2-9407-61ce04bd63c8",
    createdAtMs: 1000,
    updatedAtMs: 31000,
    trigger: "cli",
    phase: "finished",
    status: "succeeded",
    reason: null,
    origin: {},
    target: { version: "2026.9.19", installationMethod: "npm-global", channel: "stable" },
    before: { version: "2026.9.4" },
    after: { version: "2026.9.19" },
    steps: [],
    verification: {
      runningVersion: "2026.9.19",
      serviceRunning: true,
      versionMatch: true,
      readyz: true,
      channelsReady: true,
      settled: true,
      pluginErrors: [],
      rollbackOutcome: { status: "not-needed", reason: "unused" },
    },
    repair: [],
    confirmedAtMs: 31000,
    finishedAtMs: 31000,
    downtimeMs: null,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

describe("identifier-free update result projection", () => {
  it("matches the companion receiver synthetic wire fixture", () => {
    expect(buildUpdateResultPayload(result(), "linux", "x64")).toEqual({
      schema: 2,
      event: "update_result",
      outcome: "succeeded",
      fromVersion: "2026.9.4",
      targetVersion: "2026.9.19",
      resultingVersion: "2026.9.19",
      runningVersion: "2026.9.19",
      platform: "linux",
      arch: "x64",
      installMethod: "npm-global",
      channel: "stable",
      duration: "under-1m",
      postCheck: "passed",
      failedStage: "none",
      errorCategory: "none",
      errorCode: "none",
      rollback: "not-needed",
      recovery: "unknown",
    });
  });
  it("produces identical bytes when excluded diagnostics and identities change", () => {
    const first = result();
    const second = result();
    const marker = "private-marker.example /home/private token raw stderr git@private:repo";
    second.runId = marker;
    second.trigger = "chat";
    second.origin = {
      driver: { host: marker, pid: 1234, startIdentity: "123" },
      sessionKey: marker,
      campaignId: marker,
      requester: { channel: marker, accountId: marker, senderId: marker },
      deliveryContext: { channel: marker, to: marker, accountId: marker, threadId: marker },
      doctorHint: marker,
      nextAction: marker,
    };
    second.reason = marker;
    second.before.sha = marker;
    second.before.buildId = marker;
    second.after.sha = marker;
    second.after.buildId = marker;
    second.target.sha = marker;
    second.target.tag = marker;
    second.steps = [
      {
        step: marker,
        status: "failed",
        detail: marker,
        failureFacts: [
          {
            check: marker,
            code: marker,
            message: marker,
            affectedKey: marker,
            pluginId: marker,
            errorName: marker,
            location: marker,
          },
        ],
      },
    ];
    second.verification.runningBuildId = marker;
    second.verification.doctorHint = marker;
    second.verification.pid = 4321;
    second.verification.port = 9999;
    second.verification.rollbackOutcome = { status: "not-needed", reason: marker };
    second.repair = [
      { attempt: 1, status: "succeeded", startedAtMs: 123, summary: marker, reason: marker },
    ];
    expect(JSON.stringify(buildUpdateResultPayload(second))).toBe(
      JSON.stringify(buildUpdateResultPayload(first)),
    );
  });
  it.each([
    "feature/private",
    "2026.9.19+private",
    "2026.9.19-private",
    "host.example",
    "deadbeef",
    "v2026.9.19",
    "2026.9.19\n",
  ])("rejects private version %s everywhere", (version) => {
    const run = result();
    run.before.version = version;
    run.target.version = version;
    run.after.version = version;
    run.verification.runningVersion = version;
    expect(buildUpdateResultPayload(run)).toMatchObject({
      fromVersion: "unknown",
      targetVersion: "unknown",
      resultingVersion: "unknown",
      runningVersion: "unknown",
    });
  });
  it("distinguishes installed, running, target, failed postchecks, and terminal errors", () => {
    const run = result();
    run.status = "rolled-back";
    run.after.version = "2026.9.4";
    run.verification.runningVersion = "2026.9.3";
    run.verification.readyz = false;
    run.steps = [
      {
        step: "validating",
        status: "failed",
        failureFacts: [{ check: "private", code: "EACCES", message: "private" }],
      },
    ];
    expect(buildUpdateResultPayload(run)).toMatchObject({
      outcome: "rolled-back",
      targetVersion: "2026.9.19",
      resultingVersion: "2026.9.4",
      runningVersion: "2026.9.3",
      postCheck: "failed",
      failedStage: "validating",
      errorCode: "EACCES",
      errorCategory: "permission",
    });
    run.verification = {};
    expect(buildUpdateResultPayload(run)).toMatchObject({
      runningVersion: "unknown",
      postCheck: "unknown",
    });
    run.status = "running";
    expect(buildUpdateResultPayload(run)).toBeUndefined();
  });
});

describe("outcome admission and at-most-once claims", () => {
  it("does not backfill pre-consent runs or reinterpret feature-only consent", () => {
    const options = fixture(false);
    const run = createUpdateRun({ trigger: "cli" }, options);
    expect(readConfigMachineState("telemetry.updateResults", options)).toBeUndefined();
    fs.writeFileSync(options.configPath, JSON.stringify(consent));
    finishUpdateRun(run.runId, { status: "failed" }, options);
    expect(readConfigMachineState("telemetry.updateResults", options)).toBeUndefined();
  });
  it.each(["succeeded", "failed", "rolled-back"] as const)(
    "claims %s once across duplicate drivers, independently of the daily cache",
    (status) => {
      const options = fixture();
      writeConfigMachineState(
        "telemetry.updateCheck",
        { lastPingAt: Date.now(), latestVersion: "2026.9.19" },
        options,
      );
      const run = createUpdateRun({ trigger: "cli" }, options);
      recordUpdateRunPhase(run.runId, "validating", {}, options);
      recordUpdateRunStep(
        run.runId,
        { step: "warning:retry", status: "failed", detail: "private" },
        options,
      );
      expect(
        readConfigMachineState<{ attempted: string[] }>("telemetry.updateResults", options)
          ?.attempted,
      ).toEqual([]);
      finishUpdateRun(run.runId, { status }, options);
      finishUpdateRun(run.runId, { status: "succeeded" }, options);
      expect(readConfigMachineState("telemetry.updateResults", options)).toMatchObject({
        eligible: [],
        attempted: [run.runId],
      });
    },
  );
  it("drops revoked and rate-limited outcomes without retry or startup replay", () => {
    const options = fixture();
    const run = createUpdateRun({ trigger: "cli" }, options);
    fs.writeFileSync(
      options.configPath,
      JSON.stringify({ telemetry: { enabled: false, updateResults: true } }),
    );
    finishUpdateRun(run.runId, { status: "failed" }, options);
    fs.writeFileSync(options.configPath, JSON.stringify(consent));
    finishUpdateRun(run.runId, { status: "failed" }, options);
    const next = createUpdateRun({ trigger: "cli" }, options);
    finishUpdateRun(next.runId, { status: "succeeded" }, options);
    const limited = createUpdateRun({ trigger: "cli" }, options);
    finishUpdateRun(limited.runId, { status: "succeeded" }, options);
    expect(readConfigMachineState("telemetry.updateResults", options)).toMatchObject({
      eligible: [],
      attempted: [next.runId],
    });
  });
  it("drops a revoked invalid config result permanently", () => {
    const options = fixture();
    const run = createUpdateRun({ trigger: "cli" }, options);
    fs.writeFileSync(options.configPath, "invalid JSON {");
    finishUpdateRun(run.runId, { status: "failed" }, options);
    fs.writeFileSync(options.configPath, JSON.stringify(consent));
    finishUpdateRun(run.runId, { status: "failed" }, options);
    expect(readConfigMachineState("telemetry.updateResults", options)).toMatchObject({
      eligible: [],
      attempted: [],
    });
  });
  it("bounds outstanding eligibility and excludes previews", () => {
    const options = fixture();
    for (let i = 0; i < 20; i++) {
      createUpdateRun({ trigger: "api" }, options);
    }
    const state = readConfigMachineState<{ eligible: string[] }>(
      "telemetry.updateResults",
      options,
    );
    expect(state?.eligible).toHaveLength(16);
    const preview = createUpdateRun({ trigger: "cli", preview: true }, options);
    expect(
      readConfigMachineState<{ eligible: string[] }>("telemetry.updateResults", options)?.eligible,
    ).not.toContain(preview.runId);
  });
  it("preserves repair success instead of reporting an earlier warning", () => {
    const options = fixture();
    const run = createUpdateRun({ trigger: "cli" }, options);
    recordUpdateRunStep(
      run.runId,
      { step: "staging", status: "failed", failureFacts: [{ check: "staging", code: "ENOSPC" }] },
      options,
    );
    recordUpdateRunVerification(
      run.runId,
      { serviceRunning: true, runningVersion: "2026.9.19" },
      options,
    );
    const finished = finishUpdateRun(run.runId, { status: "succeeded" }, options);
    expect(buildUpdateResultPayload(finished)).toMatchObject({
      outcome: "succeeded",
      errorCode: "none",
      failedStage: "none",
      postCheck: "unknown",
    });
  });
});

describe("bounded transport", () => {
  it("reports a settled pre-activation interruption without needing a Gateway", () => {
    const options = fixture();
    const send = vi.spyOn(outcomeTelemetry, "sendUpdateResultTelemetry").mockResolvedValue();
    const run = createUpdateRun({ trigger: "cli" }, options);
    finishInterruptedUpdateBeforeActivation(run, () => {}, options);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      outcome: "failed",
      postCheck: "unknown",
      runningVersion: "unknown",
    });
    finishUpdateRun(run.runId, { status: "failed" }, options);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("dispatches only after terminal commit and does not wait for network settlement", () => {
    const options = fixture();
    let settle: (() => void) | undefined;
    const send = vi.spyOn(outcomeTelemetry, "sendUpdateResultTelemetry").mockImplementation(() => {
      expect(readConfigMachineState("telemetry.updateResults", options)).toMatchObject({
        eligible: [],
      });
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    });
    const run = createUpdateRun({ trigger: "cli" }, options);
    recordUpdateRunStep(run.runId, { step: "warning:retry", status: "failed" }, options);
    expect(send).not.toHaveBeenCalled();
    expect(finishUpdateRun(run.runId, { status: "failed" }, options).status).toBe("failed");
    expect(send).toHaveBeenCalledTimes(1);
    closeOpenClawStateDatabaseForTest();
    finishUpdateRun(run.runId, { status: "succeeded" }, options);
    expect(send).toHaveBeenCalledTimes(1);
    settle?.();
  });
  it.each([
    { DO_NOT_TRACK: "1" },
    { DO_NOT_TRACK: "true" },
    { OPENCLAW_NO_AUTO_UPDATE: "1" },
    { CI: "true" },
    { OPENCLAW_NIX_MODE: "1" },
  ])(
    "sends zero requests with suppression %j even to a configured receiver",
    async (suppression) => {
      const options = fixture();
      const fetchImpl = vi.fn<typeof fetch>();
      await sendUpdateResultTelemetry(buildUpdateResultPayload(result())!, {
        env: {
          ...options.env,
          ...suppression,
          OPENCLAW_TELEMETRY_ENDPOINT: "http://localhost/synthetic",
        },
        fetchImpl,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { telemetry: { enabled: true } },
    { telemetry: { enabled: false, updateResults: true } },
    { ...consent, update: { checkOnStart: false } },
  ])("sends zero requests for disabled consent/policy %j", async (config) => {
    const options = fixture();
    fs.writeFileSync(options.configPath, JSON.stringify(config));
    const fetchImpl = vi.fn<typeof fetch>();
    await sendUpdateResultTelemetry(buildUpdateResultPayload(result())!, {
      env: options.env,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("swallows a bounded abort without retry or telemetry recursion", async () => {
    const signal = AbortSignal.abort();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      init?.signal?.throwIfAborted();
      return new Response();
    });
    await expect(
      sendUpdateResultTelemetry(buildUpdateResultPayload(result())!, {
        fetchImpl,
        getConsent: () => true,
      }),
    ).resolves.toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(3000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("uses only fixed headers and the configured endpoint, without waiting for a daily check", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const payload = buildUpdateResultPayload(result())!;
    await sendUpdateResultTelemetry(payload, {
      env: { OPENCLAW_TELEMETRY_ENDPOINT: "http://localhost/synthetic" },
      fetchImpl,
      getConsent: () => true,
    });
    expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
      "http://localhost/synthetic",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
        redirect: "error",
        credentials: "omit",
        headers: { "Content-Type": "application/json", "User-Agent": "openclaw-update-result/1" },
      }),
    );
  });
  it("rechecks consent at network admission and never falls back on endpoint failure", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("private raw network exception"));
    const payload = buildUpdateResultPayload(result())!;
    await sendUpdateResultTelemetry(payload, { fetchImpl, getConsent: () => false });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      sendUpdateResultTelemetry(payload, {
        env: { OPENCLAW_TELEMETRY_ENDPOINT: "http://localhost/unavailable" },
        fetchImpl,
        getConsent: () => true,
      }),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
