import { beginDoctorMaintenance } from "../../commands/doctor-maintenance.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";

/** Public repair retains native service custody while fresh Doctors own database fences. */
export async function withUpdateFinalizationMaintenance<T>(
  params: {
    repair: boolean;
    root: string;
    runId: string;
    json?: boolean;
    recoveryPending: (error: unknown) => boolean;
  },
  operation: () => Promise<T>,
): Promise<T> {
  if (!params.repair) {
    return await operation();
  }
  let maintenance: Awaited<ReturnType<typeof beginDoctorMaintenance>>;
  let outcome: { value: T } | { error: unknown };
  try {
    await withCommandProcessScope(async () => {
      maintenance = await beginDoctorMaintenance({
        root: params.root,
        runId: params.runId,
        options: { repair: true, nonInteractive: true, json: params.json },
        runtime: { ...defaultRuntime, log: defaultRuntime.error },
      });
      // Capture and fresh Doctor acquire the canonical database owners separately.
      await maintenance?.releaseState();
    });
    outcome = { value: await operation() };
  } catch (error) {
    outcome = { error };
  }
  if (
    maintenance &&
    !(
      "error" in outcome &&
      (hasCommandProcessCleanupError(outcome.error) || params.recoveryPending(outcome.error))
    )
  ) {
    const owned = maintenance;
    const failures = "error" in outcome ? [outcome.error] : [];
    for (const restore of [
      async () =>
        owned.finish((await readConfigFileSnapshot({ skipPluginValidation: true })).config),
      ...("error" in outcome ? [() => owned.release()] : []),
    ]) {
      if (failures.some(hasCommandProcessCleanupError)) {
        break;
      }
      try {
        await withCommandProcessScope(restore);
      } catch (error) {
        if (!failures.includes(error)) {
          failures.push(error);
        }
      }
    }
    if (failures.length === 1) {
      outcome = { error: failures[0] };
    } else if (failures.length > 1) {
      outcome = {
        error: new AggregateError(failures, "Update finalization and service restoration failed", {
          cause: failures[0],
        }),
      };
    }
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}
