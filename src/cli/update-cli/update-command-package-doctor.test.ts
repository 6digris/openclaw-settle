import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  writeUpdatePostInstallDoctorResult,
  type UpdatePostInstallDoctorResult,
} from "../../infra/update-doctor-result.js";
import { inspectUpdateRunAbandonment } from "../../infra/update-run-activity.js";
import { adoptUpdateRun, createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import {
  ABANDONED_UPDATE_RUN_MS,
  UPDATE_RUN_HEARTBEAT_MS,
} from "../../infra/update-run-timeouts.js";
import * as processRunner from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { runPackageUpdateDoctor } from "./update-command-package.js";
import { createUpdateRunProgress } from "./update-command-run.js";

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createDoctorFixture() {
  const root = tempDirs.make("update-package-doctor-");
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(root);
  const env = {
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "entry.js"), "export {};\n");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.4" }));
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, "{}\n");
  return { root, env };
}

it("does not spawn Doctor when the installed runtime has no entrypoint", async () => {
  const { root, env } = await createDoctorFixture();
  await fs.rm(path.join(root, "dist", "entry.js"));
  const spawn = vi
    .spyOn(processRunner, "runCommandWithTimeout")
    .mockRejectedValue(new Error("Doctor must not spawn without an installed entrypoint."));

  await expect(
    runPackageUpdateDoctor({ root, timeoutMs: 1_000, progress: {}, managedServiceEnv: env }),
  ).resolves.toBeNull();
  expect(spawn).not.toHaveBeenCalled();
});

it.each(
  ([undefined, "include-ownership", "requester-revoked"] as const).flatMap((reason) =>
    [false, true].map((advisory) => ({ reason, advisory })),
  ),
)(
  "retains Doctor writer receipts and refusal $reason (advisory: $advisory)",
  async ({ reason, advisory }) => {
    const { root, env } = await createDoctorFixture();
    const receipt: UpdatePostInstallDoctorResult = advisory
      ? createDeferredConfiguredPluginRepairDoctorResult(["Configured plugin repair deferred."])
      : { status: reason ? "error" : "ok" };
    receipt.configChanges = [
      { kind: "key", key: "agents" },
      { kind: "migration", message: "Moved model allowlist." },
    ];
    if (reason) {
      receipt.configWriteRefusal = { reason, message: "Config writer refused.", keys: ["agents"] };
    }
    vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv, options) => {
      expect(argv).toContain("doctor");
      assert(typeof options === "object");
      const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
      assert(resultPath, "Missing Doctor result path");
      await writeUpdatePostInstallDoctorResult({ resultPath, result: receipt });
      return {
        code: advisory ? UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE : 0,
        stdout: "",
        stderr: "",
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
    const onStepComplete = vi.fn();
    const step = await runPackageUpdateDoctor({
      root,
      timeoutMs: 1_000,
      progress: { onStepComplete },
      managedServiceEnv: env,
    });

    assert(step);
    const expected = {
      exitCode: reason ? 1 : advisory ? UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE : 0,
      configChanges: receipt.configChanges,
      ...(reason
        ? { stderrTail: expect.stringContaining(`agents. ${reason}: Config writer refused.`) }
        : {}),
    };
    const expectedAdvisory =
      advisory && !reason
        ? expect.objectContaining({ kind: "package-post-install-doctor" })
        : undefined;
    expect(step).toMatchObject(expected);
    expect(step.configWriteRefusal).toEqual(receipt.configWriteRefusal);
    expect(step.advisory).toEqual(expectedAdvisory);
    expect(onStepComplete).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...expected,
        configWriteRefusal: receipt.configWriteRefusal,
        advisory: expectedAdvisory,
      }),
    );
  },
);

it("leaves the run ledger unchanged while the activation Doctor child is pending", async () => {
  const { root, env } = await createDoctorFixture();
  vi.useFakeTimers();
  const { runId } = createUpdateRun({ trigger: "control-ui" }, { env });
  expect(adoptUpdateRun(runId, { env }).origin.driver?.pid).toBe(process.pid);
  const spawned = createDeferredCore();
  const exited = createDeferredCore();
  const onStepComplete = vi.fn();
  const progress = createUpdateRunProgress({ runId, env }, { onStepComplete });
  vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (_argv, options) => {
    spawned.resolve();
    await exited.promise;
    assert(typeof options === "object");
    const resultPath = options.env?.[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
    assert(resultPath, "Missing Doctor result path");
    await writeUpdatePostInstallDoctorResult({ resultPath, result: { status: "ok" } });
    return { code: 0, stdout: "", stderr: "", signal: null, killed: false, termination: "exit" };
  });
  const running = runPackageUpdateDoctor({
    root,
    timeoutMs: ABANDONED_UPDATE_RUN_MS * 2,
    managedServiceEnv: env,
    progress,
  });

  try {
    await spawned.promise;
    const admitted = getUpdateRun(runId, { env });
    expect(admitted?.steps.at(-1)).toMatchObject({
      step: "openclaw doctor",
      status: "in_progress",
    });
    await vi.advanceTimersByTimeAsync(ABANDONED_UPDATE_RUN_MS + UPDATE_RUN_HEARTBEAT_MS);
    const observed = getUpdateRun(runId, { env });
    expect(observed).toEqual(admitted);
    assert(observed);
    expect(inspectUpdateRunAbandonment(observed)).toBeUndefined();
    expect(onStepComplete).not.toHaveBeenCalled();
  } finally {
    exited.resolve();
    await running;
  }
  await expect(running).resolves.toMatchObject({ exitCode: 0 });
  expect(onStepComplete).toHaveBeenCalledOnce();
  expect(getUpdateRun(runId, { env })).toMatchObject({
    status: "running",
    steps: expect.arrayContaining([
      expect.objectContaining({ step: "openclaw doctor", status: "completed" }),
    ]),
  });
});
