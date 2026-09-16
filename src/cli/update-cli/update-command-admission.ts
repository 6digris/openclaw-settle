// Entry admission is kept separate from mutation and settlement orchestration.
import { tryResolveInvocationCwd, type UpdateCommandOptions } from "./shared.js";
import { withUpdateAdmissionReporting } from "./update-command-result.js";
import { prepareUpdateCommand, resolveUpdateCommandAdmissionEnv } from "./update-command-run.js";
import { resolveServiceRefreshEnv, withUpdateInProgressEnv } from "./update-command-service-env.js";
import type { UpdateCommandRecoveryState } from "./update-command-service.js";
// Entry admission is kept separate from mutation and settlement orchestration.

export async function runUpdateCommandAdmission(
  inputOpts: UpdateCommandOptions,
  operations: {
    initialize: (
      opts: UpdateCommandOptions,
      prepared: Awaited<ReturnType<typeof prepareUpdateCommand>>,
      state: UpdateCommandRecoveryState,
      cwd: string | undefined,
      env: NodeJS.ProcessEnv,
    ) => Promise<void>;
    run: (
      opts: UpdateCommandOptions,
      prepared: Awaited<ReturnType<typeof prepareUpdateCommand>>,
      state: UpdateCommandRecoveryState,
      cwd: string | undefined,
    ) => Promise<void>;
  },
  defaultStepTimeoutMs: number,
): Promise<void> {
  const invocationCwd = tryResolveInvocationCwd();
  const recoveryState: UpdateCommandRecoveryState = {
    triageTarget: { env: resolveServiceRefreshEnv(process.env, invocationCwd) },
  };
  // Rejected arguments and handoffs must not open or recover persistent state.
  const prepared = await withUpdateAdmissionReporting(inputOpts, () =>
    withUpdateInProgressEnv(invocationCwd, () => prepareUpdateCommand(inputOpts)),
  );
  // Post-core children report phase results; the outer updater owns the run ledger.
  if (prepared.postCoreUpdateResume) {
    return await withUpdateInProgressEnv(invocationCwd, async () => {
      const { resumePostCoreUpdate } = await import("./update-execution.runtime.js");
      await resumePostCoreUpdate({
        root: prepared.discoveredRoot,
        channel: prepared.postCoreUpdateChannel,
        opts: inputOpts,
        timeoutMs: prepared.timeoutMs ?? defaultStepTimeoutMs,
      });
    });
  }
  return await withUpdateAdmissionReporting(inputOpts, async () => {
    const env = await resolveUpdateCommandAdmissionEnv({
      opts: inputOpts,
      root: prepared.servicePlan?.rootRedirect?.root ?? prepared.discoveredRoot,
      invocationCwd,
      pkgOwnership: prepared.pkgOwnership,
    });
    const { updateStateNeedsInitialization } = await import("./update-command-initialization.js");
    if (await updateStateNeedsInitialization(env)) {
      return await operations.initialize(inputOpts, prepared, recoveryState, invocationCwd, env);
    }
    return await operations.run(inputOpts, prepared, recoveryState, invocationCwd);
  });
}
