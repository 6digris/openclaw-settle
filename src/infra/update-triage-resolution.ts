import { resolveGatewayRestartProbeContext } from "../cli/daemon-cli/restart-health-probe.js";
import { verifyPreviousGatewayForUpdate } from "../cli/update-cli/update-command-verification.js";
import type { TriageUpdateFailure } from "../commands/triage-update.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { collectPackageDistContentInventoryErrors } from "./package-dist-inventory.js";
import { readPackageVersion } from "./package-json.js";
import { collectGitRuntimeErrors } from "./update-git-runtime.js";
import { collectInstalledGlobalPackageErrors } from "./update-global.js";
import type { UpdateRepairValidation } from "./update-repair-protocol.js";
import { findActiveUpdateRun, getUpdateRun, listUpdateRuns } from "./update-run-reader.js";

const failureFamilies = {
  package: ["global-install-failed", "runtime-verification-failed"],
  acquisition: [
    "fetch-failed",
    "no-release-tag",
    "no-target-sha",
    "target-metadata-preflight",
    "dirty",
    "clean-check-failed",
    "preflight-remote-failed",
    "preflight-revlist-failed",
    "preflight-worktree-failed",
    "preflight-no-candidates",
    "preflight-no-good-commit",
    "preflight-insufficient-space",
    "preflight-node-runtime-incompatible",
  ],
  checkout: [
    "checkout-failed",
    "doctor-entry-missing",
    "ui-assets-missing",
    "ui-build-failed",
    "head-verification-failed",
    "target-sha-mismatch",
  ],
  schema: ["database-schema-preflight"],
  doctor: [
    "doctor-failed",
    "repair-requires-config-change",
    "finalize:doctor",
    "post-update-plugins",
  ],
  service: [
    "managed-service-preflight",
    "service-revalidation-failed",
    "restart-unhealthy",
    "version-mismatch",
    "build-id-mismatch",
    "plugin-errors",
    "channel-errors",
    "readyz-unhealthy",
    "service-not-running",
  ],
};

const nextUpdate = "Next step: run `openclaw update status --json`, then retry `openclaw update`.";

function unresolved(message: string, stop = true): UpdateRepairValidation {
  const summary = `${message} ${nextUpdate}`;
  return { ok: false, score: -1, summary, ...(stop ? { stopReason: summary } : {}) };
}

/** Saved diagnostics are not a recovery receipt; only the updater can settle its failure. */
export async function validateTriageUpdateResolution(params: {
  failure: TriageUpdateFailure;
  installRoot: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  validateDoctor: () => Promise<UpdateRepairValidation>;
}): Promise<UpdateRepairValidation> {
  const { failure, installRoot, env, signal } = params;
  signal.throwIfAborted();
  const runId = "result" in failure ? failure.result.runId : undefined;
  const options = { env };
  const original = runId ? getUpdateRun(runId, options) : undefined;
  const target = original?.target;
  if (!original || !target?.version || !target.kind || (target.kind === "git" && !target.sha)) {
    return unresolved("Cannot establish the update target.");
  }
  const reason = "result" in failure ? failure.result.reason : undefined;
  const family = Object.entries(failureFamilies).find(
    ([, reasons]) => reason !== undefined && reasons.includes(reason),
  )?.[0];
  if (!family) {
    return unresolved(
      `No resolution predicate for update failure ${reason ?? "without a recorded reason"}.`,
    );
  }

  // Do not reinterpret a terminal failed row. A later owner completion is the
  // evidence for acquisition, schema admission, finalization, and recovery.
  const completion = listUpdateRuns({ limit: 1 }, options)[0];
  if (findActiveUpdateRun(options)) {
    return unresolved("An update is still running; wait for its owner to finish.");
  }
  if (
    !completion ||
    completion.finishedAtMs === null ||
    completion.createdAtMs < original.createdAtMs ||
    completion.target.kind !== target.kind ||
    completion.target.version !== target.version ||
    completion.target.sha !== target.sha ||
    (completion.status !== "succeeded" && completion.status !== "rolled-back")
  ) {
    return unresolved(
      `The updater has not recorded a completed resolution of the ${family} failure for ${target.version}.`,
    );
  }
  const rolledBack = completion.status === "rolled-back";
  const expected = rolledBack ? original.before : target;
  if (
    !expected.version ||
    completion.after.version !== expected.version ||
    (target.kind === "git" && (!expected.sha || completion.after.sha !== expected.sha)) ||
    (rolledBack &&
      !completion.steps.some(
        (step) => step.step === "package rollback" && step.status === "completed",
      ))
  ) {
    return unresolved("The updater has not verified the requested version or package rollback.");
  }
  signal.throwIfAborted();
  const installedVersion = await readPackageVersion(installRoot);
  if (installedVersion !== expected.version) {
    return unresolved(
      `Expected installed version ${expected.version}; found ${installedVersion ?? "no installed version"}.`,
    );
  }
  const doctor = await params.validateDoctor();
  signal.throwIfAborted();
  if (!doctor.ok) {
    return { ...doctor, summary: `${doctor.summary} ${nextUpdate}` };
  }
  let errors: string[];
  if (target.kind === "git") {
    const head = await runUtf8CommandWithTimeout(["git", "-C", installRoot, "rev-parse", "HEAD"], {
      signal,
      env,
      input: "",
      killProcessTree: true,
      maxOutputBytes: 4096,
      terminateOnOutputLimit: true,
    });
    if (
      head.code !== 0 ||
      head.termination !== "exit" ||
      head.outputLimitExceeded ||
      head.stdout.trim() !== expected.sha
    ) {
      return unresolved("The checkout does not match the updater's recorded commit.");
    }
    errors = await collectGitRuntimeErrors({ root: installRoot, sha: expected.sha ?? null });
  } else {
    errors = await collectInstalledGlobalPackageErrors({
      packageRoot: installRoot,
      expectedVersion: expected.version,
    });
    errors.push(...(await collectPackageDistContentInventoryErrors(installRoot)));
  }
  signal.throwIfAborted();
  if (errors.length) {
    return {
      ...unresolved(
        `Installed runtime verification failed: ${errors.slice(0, 3).join("; ")}`,
        false,
      ),
      score: -errors.length,
    };
  }
  const { config } = await resolveGatewayRestartProbeContext(env);
  const serviceVerified = await verifyPreviousGatewayForUpdate({
    root: installRoot,
    config,
    env,
    opts: {},
    signal,
    expectedVersion: expected.version,
    requirePluginHealth: reason === "plugin-errors" || reason === "post-update-plugins",
  });
  signal.throwIfAborted();
  if (!serviceVerified) {
    return unresolved(
      "The managed Gateway's installation, running version, and readiness are not verified.",
    );
  }
  if ((await readPackageVersion(installRoot)) !== expected.version) {
    return unresolved("The installed version changed during verification.");
  }
  signal.throwIfAborted();
  if (
    findActiveUpdateRun(options) ||
    listUpdateRuns({ limit: 1 }, options)[0]?.runId !== completion.runId
  ) {
    return unresolved("The update owner changed during verification.");
  }
  return {
    ok: true,
    score: 0,
    summary: `${rolledBack ? "Rollback" : "Update"} to ${expected.version} recorded by the updater; installed runtime and managed Gateway readiness verified.`,
  };
}
