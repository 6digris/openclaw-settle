import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import { renderUpdateRunReport } from "../../infra/update-run-report.js";
import type { UpdateRunResult, UpdateStepResult } from "../../infra/update-runner.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";
import {
  cancelManagedServiceUpdateHandoffMock,
  captureUpdateRunPayload,
  detectRespawnSupervisorMock,
  initializeGatewayUpdateStatusMock,
  invokeUpdateRun,
  mockGlobalInstallSurface,
  normalizeUpdateChannelMock,
  recordLatestUpdateRestartSentinelMock,
  resolveUpdateInstallSurfaceMock,
  runGatewayUpdateMock,
  runGatewayUpdatePreflightMock,
  runPostCoreFinalizeAfterGatewayUpdateMock,
  scheduleGatewaySigusr1RestartMock,
  sentinelState,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

async function previewFailureReport(runId: string) {
  const params = { action: "preview", attemptId: runId };
  const respond = vi.fn<RespondFn>();
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: "failure-evidence", method: "update.report", params },
    params,
    respond,
    hasCurrentClientAuthority: () => true,
    client: {
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
        role: "operator",
        scopes: ["operator.admin"],
      },
      internal: { operatorRoleActor: { kind: "system" } },
    },
    isWebchatConnect: () => false,
    context: createDirectChatContext(),
  };
  const { updateHandlers } = await import("./update.js");
  await expectDefined(updateHandlers["update.report"], "report handler")(options);
  return respond;
}

async function captureFailure() {
  const payload = expectDefined(await captureUpdateRunPayload(), "update response");
  const result = expectDefined(payload.result, "failed update result");
  expect(payload).toMatchObject({ ok: false, restart: null });
  expect(result.status).toBe("error");
  expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();

  // Reopen the real store before projecting the RPC's failure into either report.
  closeOpenClawStateDatabaseForTest();
  const run = expectDefined(getUpdateRun(payload.runId), "persisted failed update");
  expect(run).toMatchObject({ status: "failed", phase: "finished", reason: result.reason });
  const localReport = renderUpdateRunReport(run).lines.join("\n");
  const respond = await previewFailureReport(payload.runId);
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    true,
    expect.objectContaining({ status: "ready", attemptId: payload.runId }),
  );
  const preview = respond.mock.calls[0]?.[1];
  if (!isRecord(preview) || typeof preview.body !== "string") {
    throw new Error("Missing failure report preview");
  }
  return { result, run, localReport, publicReport: preview.body };
}

describe("Gateway update failure evidence", () => {
  it("retains initialization cause and elapsed time through the durable reports", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_234);
    initializeGatewayUpdateStatusMock.mockImplementationOnce(async () => {
      clock.mockReturnValue(4_321);
      throw new Error("Update inspection failed", {
        cause: Object.assign(new Error("Connection refused; token=fixture-secret"), {
          code: "ECONNREFUSED",
        }),
      });
    });
    try {
      const { result, run, localReport, publicReport } = await captureFailure();
      expect(result).toMatchObject({
        mode: "unknown",
        reason: "unexpected-error",
        before: { version: "1.0.0" },
        durationMs: 3_087,
        steps: [
          {
            name: "preflight",
            failureFacts: [{ check: "preflight", code: "Error" }],
          },
        ],
      });
      expect(run.steps.find((step) => step.step === "preflight")).toMatchObject({
        status: "failed",
        failureFacts: result.steps[0]?.failureFacts,
      });
      for (const text of [JSON.stringify(result), localReport, publicReport]) {
        expect(text).toContain("ECONNREFUSED");
        expect(text).toContain("Connection refused");
        expect(text).not.toContain("fixture-secret");
      }
      expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  it("retains the known installation when surface inspection throws", async () => {
    resolveUpdateInstallSurfaceMock.mockRejectedValueOnce(
      Object.assign(new Error("Installation inspection denied"), { code: "EACCES" }),
    );
    const { result, localReport, publicReport } = await captureFailure();
    expect(result).toMatchObject({
      root: "/tmp/openclaw",
      mode: "git",
      before: { version: "1.0.0" },
      steps: [{ failureFacts: [{ check: "preflight", code: "EACCES" }] }],
    });
    expect(localReport).toContain("Installation inspection denied");
    expect(publicReport).toContain("Failing check preflight (EACCES)");
    expect(publicReport).not.toContain("Installation inspection denied");
    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
  });

  it("records managed git preflight exceptions before starting a handoff", async () => {
    normalizeUpdateChannelMock.mockReturnValue("dev");
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    runGatewayUpdatePreflightMock.mockRejectedValueOnce(
      Object.assign(new Error("Git preflight could not read candidate metadata"), { code: "EIO" }),
    );
    const { result, localReport, publicReport } = await captureFailure();
    expect(runGatewayUpdatePreflightMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      root: "/tmp/openclaw",
      mode: "git",
      reason: "unexpected-error",
      steps: [{ failureFacts: [{ check: "preflight", code: "EIO" }] }],
    });
    expect(localReport).toContain("Git preflight could not read candidate metadata");
    expect(publicReport).toContain("Failing check preflight (EIO)");
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
  });

  it("preserves progress-owned failure facts when the runner subsequently throws", async () => {
    const failureFacts = [{ check: "build", code: "ENOSPC", message: "No space left on device." }];
    runGatewayUpdateMock.mockImplementationOnce(async ({ progress } = {}) => {
      const step = { name: "build", command: "pnpm build", index: 1, total: 1 };
      progress?.onStepStart?.(step);
      progress?.onStepComplete?.({ ...step, exitCode: 1, durationMs: 25, failureFacts });
      throw Object.assign(new Error("Could not complete update result"), { code: "EIO" });
    });
    const { result, run, localReport, publicReport } = await captureFailure();
    expect(result).toMatchObject({
      mode: "git",
      root: "/tmp/openclaw",
      steps: [{ failureFacts: [{ check: "staging", code: "EIO" }] }],
    });
    expect(run.steps.find((step) => step.step === "build")).toMatchObject({
      status: "failed",
      failureFacts,
    });
    expect(localReport).toContain("No space left on device.");
    expect(localReport).toContain("Could not complete update result");
    expect(publicReport).toContain("No space left on device");
    expect(publicReport).toContain("Failing check build (ENOSPC)");
    expect(publicReport).toContain("Failing check staging (EIO)");
    expect(runPostCoreFinalizeAfterGatewayUpdateMock).not.toHaveBeenCalled();
  });

  it.each(["staging", "validating"] as const)(
    "attributes a failed %s ledger transition to the phase being entered",
    async (phase) => {
      const ledger = await import("../../infra/update-run-ledger.js");
      const recordPhase = ledger.recordUpdateRunPhase;
      let transitionFailed = false;
      const write = vi.spyOn(ledger, "recordUpdateRunPhase").mockImplementation((...args) => {
        if (args[1] === phase && !transitionFailed) {
          transitionFailed = true;
          throw Object.assign(new Error(`${phase} transition could not be recorded`), {
            code: "EIO",
          });
        }
        return recordPhase(...args);
      });
      try {
        const { result, run, localReport, publicReport } = await captureFailure();
        expect(transitionFailed).toBe(true);
        expect(result.reason).toBe("unexpected-error");
        expect(result.steps.at(-1)).toMatchObject({
          name: phase,
          failureFacts: [{ check: phase, code: "EIO" }],
        });
        expect(run.steps.find((step) => step.step === phase)).toMatchObject({
          status: "failed",
          failureFacts: [{ check: phase, code: "EIO" }],
        });
        expect(localReport).toContain(`${phase} transition could not be recorded`);
        expect(publicReport).toContain(`Failing check ${phase} (EIO)`);
        expect(runGatewayUpdateMock).toHaveBeenCalledTimes(phase === "staging" ? 0 : 1);
        expect(runPostCoreFinalizeAfterGatewayUpdateMock).not.toHaveBeenCalled();
      } finally {
        write.mockRestore();
      }
    },
  );

  it("retains the returned result when post-core finalizer setup throws", async () => {
    const returned: UpdateRunResult = {
      status: "ok",
      mode: "git",
      root: "/tmp/openclaw",
      before: { version: "1.0.0", sha: "a".repeat(40) },
      after: { version: "2.0.0", sha: "b".repeat(40), buildId: "candidate-build" },
      steps: [{ name: "build", command: "pnpm build", cwd: "", durationMs: 100, exitCode: 0 }],
      durationMs: 100,
    };
    runGatewayUpdateMock.mockResolvedValueOnce(returned);
    runPostCoreFinalizeAfterGatewayUpdateMock.mockRejectedValueOnce(
      Object.assign(new Error("Candidate CLI entrypoint is unavailable"), { code: "ENOENT" }),
    );
    const { result, run, localReport, publicReport } = await captureFailure();
    expect(runPostCoreFinalizeAfterGatewayUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ result: returned }),
    );
    expect(result).toMatchObject({
      mode: returned.mode,
      root: returned.root,
      before: returned.before,
      after: returned.after,
      reason: "unexpected-error",
      steps: [returned.steps[0], { failureFacts: [{ check: "validating", code: "ENOENT" }] }],
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(returned.durationMs);
    expect(run).toMatchObject({ before: returned.before, after: returned.after });
    expect(localReport).toContain("Candidate CLI entrypoint is unavailable");
    expect(publicReport).toContain("Failing check validating (ENOENT)");
    expect(publicReport).toContain("2.0.0");
    expect(returned.status).toBe("ok");
    expect(returned.steps).toHaveLength(1);
  });

  it("retains the managed handoff error without changing its refusal reason", async () => {
    mockGlobalInstallSurface();
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    startManagedServiceUpdateHandoffMock.mockRejectedValueOnce(
      Object.assign(new Error("Managed helper executable is unavailable"), { code: "ENOENT" }),
    );
    const { result, localReport, publicReport } = await captureFailure();
    expect(result).toMatchObject({
      reason: "managed-service-handoff-failed",
      mode: "npm",
      root: "/tmp/openclaw-global",
      before: { version: "1.0.0" },
      steps: [{ failureFacts: [{ check: "managed-service", code: "ENOENT" }] }],
    });
    expect(localReport).toContain("Managed helper executable is unavailable");
    expect(publicReport).toContain("Failing check managed-service (ENOENT)");
    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
  });

  it("keeps a post-acceptance ledger failure distinct from the accepted handoff", async () => {
    mockGlobalInstallSurface();
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    const ledger = await import("../../infra/update-run-ledger.js");
    const write = vi.spyOn(ledger, "recordUpdateRunStep").mockImplementationOnce(() => {
      throw Object.assign(new Error("Accepted handoff could not be recorded"), { code: "EIO" });
    });
    try {
      const payload = expectDefined(await captureUpdateRunPayload(), "handoff ledger response");
      expect(startManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(write).toHaveBeenNthCalledWith(
        1,
        payload.runId,
        expect.objectContaining({ step: "managed-service update handoff", status: "completed" }),
      );
      expect(payload).toMatchObject({
        ok: true,
        restart: null,
        sentinel: { persisted: true },
        handoff: { status: "started" },
        result: {
          status: "error",
          reason: "managed-service-handoff-failed",
          steps: [{ failureFacts: [{ check: "managed-service", code: "EIO" }] }],
        },
      });
      expect(sentinelState.capturedPayload).toBeDefined();
      expect(transferManagedServiceUpdateHandoffMock).toHaveBeenCalledOnce();
      expect(recordLatestUpdateRestartSentinelMock.mock.invocationCallOrder[0]).toBeLessThan(
        expectDefined(
          transferManagedServiceUpdateHandoffMock.mock.invocationCallOrder[0],
          "ownership transfer",
        ),
      );
      expect(cancelManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      closeOpenClawStateDatabaseForTest();
      const run = expectDefined(getUpdateRun(payload.runId), "persisted handoff ledger failure");
      expect(run.status).toBe("running");
      expect(run.steps.find((step) => step.step === "managed-service")).toMatchObject({
        status: "failed",
        failureFacts: [{ check: "managed-service", code: "EIO" }],
      });
      expect(renderUpdateRunReport(run).lines.join("\n")).toContain(
        "Accepted handoff could not be recorded",
      );
      // Accepted custody still owns the active run; it is not a terminal public report.
      const preview = await previewFailureReport(payload.runId);
      expect(preview).toHaveBeenCalledExactlyOnceWith(false, undefined, {
        code: "INVALID_REQUEST",
        message: "This failed update attempt is stale or unavailable.",
      });
      expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });

  it.each([
    ["phase", "restored-in-process", false],
    ["accepted-row", "restored-in-process", false],
    ["phase", false, false],
    ["accepted-row", "throws", false],
    ["phase", "restart-after-exit", false],
    ["phase", false, true],
    ["accepted-row", "throws", true],
  ] as const)(
    "joins owned cancellation after final %s projection fails, with cancellation %s and warning throws %s",
    async (failure, cancellation, warningThrows) => {
      mockGlobalInstallSurface();
      detectRespawnSupervisorMock.mockReturnValue("launchd");
      const original = Object.assign(new Error("Final update result could not be recorded"), {
        code: "EIO",
      });
      const ledger = await import("../../infra/update-run-ledger.js");
      const recordPhase = ledger.recordUpdateRunPhase;
      const recordStep = ledger.recordUpdateRunStep;
      const events: string[] = [];
      let acceptedWrites = 0;
      const phaseWrite = vi.spyOn(ledger, "recordUpdateRunPhase").mockImplementation((...args) => {
        if (
          failure === "phase" &&
          args[1] === "requested" &&
          startManagedServiceUpdateHandoffMock.mock.calls.length === 1
        ) {
          events.push("projection-failed");
          throw original;
        }
        return recordPhase(...args);
      });
      const stepWrite = vi.spyOn(ledger, "recordUpdateRunStep").mockImplementation((...args) => {
        const written = recordStep(...args);
        if (args[1].step === "managed-service update handoff") {
          acceptedWrites += 1;
          if (failure === "accepted-row" && acceptedWrites === 2) {
            // Coordinator release can throw after the row has already committed.
            events.push("projection-failed");
            throw original;
          }
        }
        return written;
      });
      const finish = vi.spyOn(ledger, "finishUpdateRun");
      const sentinel = await import("../../infra/restart-sentinel.js");
      const sentinelWrite = vi.spyOn(sentinel, "writeRestartSentinel");
      const cancelling = createDeferredCore();
      const releaseCancellation = createDeferredCore();
      cancelManagedServiceUpdateHandoffMock.mockImplementationOnce(async () => {
        events.push("cancel-started");
        cancelling.resolve();
        await releaseCancellation.promise;
        events.push("cancel-finished");
        if (cancellation === "throws") {
          throw new Error("Cancellation control pipe failed");
        }
        return cancellation;
      });
      const context = createDirectChatContext();
      if (warningThrows) {
        vi.mocked(context.logGateway.warn).mockImplementationOnce(() => {
          throw new Error("Warning sink failed");
        });
      }
      const respond = vi.fn<RespondFn>();
      const { updateHandlers } = await import("./update.js");
      const handler = expectDefined(updateHandlers["update.run"], "update handler");
      const rejected = Promise.resolve(
        handler({
          req: { type: "req", id: "projection-failure", method: "update.run", params: {} },
          params: {},
          client: null,
          isWebchatConnect: () => false,
          respond,
          context,
        }),
      ).then(
        () => {
          events.push("resolved");
        },
        (error: unknown) => {
          events.push("rejected");
          return error;
        },
      );
      try {
        await Promise.race([cancelling.promise, rejected]);
        expect(events).toEqual(["projection-failed", "cancel-started"]);
        const started = expectDefined(
          startManagedServiceUpdateHandoffMock.mock.calls[0]?.[0],
          "accepted helper",
        );
        expect(cancelManagedServiceUpdateHandoffMock).toHaveBeenCalledExactlyOnceWith({
          kind: "managed-update-handoff",
          handoffId: started.handoffId,
          installRoot: started.root,
        });
        releaseCancellation.resolve();
        expect(await rejected).toBe(original);
        expect(events).toEqual([
          "projection-failed",
          "cancel-started",
          "cancel-finished",
          "rejected",
        ]);
        expect(acceptedWrites).toBe(failure === "phase" ? 1 : 2);
        expect(respond).not.toHaveBeenCalled();
        expect(finish).not.toHaveBeenCalled();
        expect(sentinelWrite).not.toHaveBeenCalled();
        expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
        expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
        if (cancellation === "restored-in-process") {
          expect(context.logGateway.warn).not.toHaveBeenCalled();
        } else {
          expect(context.logGateway.warn).toHaveBeenCalledExactlyOnceWith(
            "update.run result persistence failed; handoff cancellation is unconfirmed",
          );
        }
        closeOpenClawStateDatabaseForTest();
        expect(getUpdateRun(expectDefined(started.runId, "accepted run"))).toMatchObject({
          status: "running",
          steps: [
            { step: "requested", status: "in_progress" },
            { step: "managed-service update handoff", status: "completed" },
          ],
        });
      } finally {
        releaseCancellation.resolve();
        await rejected;
        phaseWrite.mockRestore();
        stepWrite.mockRestore();
        finish.mockRestore();
        sentinelWrite.mockRestore();
      }
    },
  );

  it("preserves an unmanaged projection error without cancelling another owner", async () => {
    const original = new Error("Unmanaged update result could not be recorded");
    runGatewayUpdateMock.mockResolvedValueOnce({
      status: "error",
      mode: "git",
      reason: "build-failed",
      steps: [],
      durationMs: 100,
    });
    const ledger = await import("../../infra/update-run-ledger.js");
    const recordPhase = ledger.recordUpdateRunPhase;
    const write = vi.spyOn(ledger, "recordUpdateRunPhase").mockImplementation((...args) => {
      if (args[1] === "requested" && runGatewayUpdateMock.mock.calls.length === 1) {
        throw original;
      }
      return recordPhase(...args);
    });
    const finish = vi.spyOn(ledger, "finishUpdateRun");
    const respond = vi.fn();
    try {
      await expect(invokeUpdateRun({}, respond)).rejects.toBe(original);
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(cancelManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(transferManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
      expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
      expect(finish).not.toHaveBeenCalled();
      expect(sentinelState.capturedPayload).toBeUndefined();
      expect(respond).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      finish.mockRestore();
    }
  });

  it("projects result-only facts, snapshot capacity and config refusal without progress events", async () => {
    const snapshot: UpdateStepResult = {
      name: "snapshot",
      command: "",
      cwd: "",
      durationMs: 10,
      exitCode: 0,
      snapshotCapacity: {
        reason: "state-volume",
        sqliteBytes: 1_024,
        pluginBytes: 512,
        requiredBytes: 4_096,
        candidates: [{ kind: "state-volume", directory: "/tmp/snapshot", availableBytes: 8_192 }],
        selection: { kind: "state-volume", directory: "/tmp/snapshot" },
      },
    };
    const doctor: UpdateStepResult = {
      name: "doctor",
      command: "",
      cwd: "",
      durationMs: 10,
      exitCode: null,
      failureFacts: [{ check: "doctor", code: "EACCES", message: "Config write refused." }],
      configWriteRefusal: {
        reason: "config-input-changed",
        message: "Config changed after update validation.",
        keys: ["browser"],
      },
    };
    runGatewayUpdateMock.mockResolvedValueOnce({
      status: "error",
      mode: "git",
      reason: "doctor-failed",
      steps: [snapshot, doctor],
      durationMs: 20,
    });
    const { result, run, localReport, publicReport } = await captureFailure();
    expect(result.steps).toEqual([snapshot, doctor]);
    expect(run.steps.find((step) => step.step === "snapshot")).toMatchObject({
      status: "completed",
      snapshotCapacity: snapshot.snapshotCapacity,
    });
    expect(run.steps.find((step) => step.step === "doctor")).toMatchObject({
      status: "failed",
      failureFacts: doctor.failureFacts,
      configWriteRefusal: doctor.configWriteRefusal,
    });
    expect(localReport).toContain("state-volume");
    expect(localReport).toContain("Config changed after update validation.");
    expect(localReport).toContain("browser");
    expect(publicReport).toContain("Failing check doctor (EACCES)");
  });

  it("keeps advisory, warning and config-change classification in the canonical projection", async () => {
    runGatewayUpdateMock.mockResolvedValueOnce({
      status: "ok",
      mode: "git",
      steps: [
        {
          name: "doctor",
          command: "",
          cwd: "",
          durationMs: 10,
          exitCode: 86,
          advisory: { kind: "recoverable-maintenance", message: "Optional repair deferred." },
          warnings: ["Optional repair deferred.", "Review plugin warnings."],
          failureFacts: [{ check: "doctor", code: "EIO", message: "Not a blocking failure." }],
          configChanges: [{ kind: "key", key: "browser" }],
        },
      ],
      durationMs: 10,
    });
    const payload = expectDefined(await captureUpdateRunPayload(), "advisory update response");
    expect(payload).toMatchObject({ ok: true, result: { status: "ok" } });
    closeOpenClawStateDatabaseForTest();
    const run = expectDefined(getUpdateRun(payload.runId), "persisted advisory update");
    const doctor = expectDefined(
      run.steps.find((step) => step.step === "doctor"),
      "advisory Doctor step",
    );
    expect(doctor.status).toBe("completed");
    expect(doctor.failureFacts).toBeUndefined();
    expect(run.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: "warning:doctor", detail: "Optional repair deferred." }),
        expect.objectContaining({ step: "warning:doctor:2", detail: "Review plugin warnings." }),
        expect.objectContaining({
          step: "doctor-config:doctor:0",
          configChange: { kind: "key", key: "browser" },
        }),
      ]),
    );
    expect(renderUpdateRunReport(run).lines.join("\n")).toContain(
      "Doctor changed config keys: browser.",
    );
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledOnce();
  });

  it.each(["ok", "skipped"] as const)(
    "keeps a non-handoff null-exit step failed when the overall result is %s",
    async (status) => {
      runGatewayUpdateMock.mockResolvedValueOnce({
        status,
        mode: "git",
        ...(status === "skipped" ? { reason: "already-current" } : {}),
        steps: [{ name: "build", command: "", cwd: "", durationMs: 10, exitCode: null }],
        durationMs: 10,
      });
      const payload = expectDefined(await captureUpdateRunPayload(), "null-exit update response");
      expect(payload).toMatchObject({ ok: status === "ok", result: { status } });
      expect(payload.handoff).toBeUndefined();
      closeOpenClawStateDatabaseForTest();
      const run = expectDefined(getUpdateRun(payload.runId), "persisted null-exit update");
      expect(run.status).toBe(status === "ok" ? "running" : "skipped");
      expect(run.steps.find((step) => step.step === "build")).toMatchObject({ status: "failed" });
      expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(status === "ok" ? 1 : 0);
      expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    },
  );

  it("keeps an accepted managed handoff with no child exit code completed", async () => {
    mockGlobalInstallSurface();
    detectRespawnSupervisorMock.mockReturnValue("launchd");
    const payload = expectDefined(await captureUpdateRunPayload(), "managed handoff response");
    expect(payload).toMatchObject({
      ok: true,
      result: {
        status: "skipped",
        reason: "managed-service-handoff-started",
        steps: [{ name: "managed-service update handoff", exitCode: null }],
      },
      handoff: { status: "started" },
    });
    closeOpenClawStateDatabaseForTest();
    const run = expectDefined(getUpdateRun(payload.runId), "persisted managed handoff");
    expect(run.status).toBe("running");
    const handoff = expectDefined(
      run.steps.find((step) => step.step === "managed-service update handoff"),
      "accepted handoff step",
    );
    expect(handoff.status).toBe("completed");
    expect(handoff.detail).toBeUndefined();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
  });
});
