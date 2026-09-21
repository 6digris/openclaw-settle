import type { ConfigWriteOptions } from "./io.js";
import { copyRuntimeConfigWriteApplication } from "./runtime-write-application.js";

export function mergeConfigMutationWriteOptions(
  prepared: ConfigWriteOptions,
  caller?: ConfigWriteOptions,
): ConfigWriteOptions {
  const merged = copyRuntimeConfigWriteApplication(caller, { ...prepared, ...caller });
  const capturedGuard = prepared.assertConfigPathForWrite;
  const callerGuard = caller?.assertConfigPathForWrite;
  // Caller authority narrows the captured destination; it must never replace
  // that ownership check through retries and post-write validation.
  if (capturedGuard && callerGuard && capturedGuard !== callerGuard) {
    merged.assertConfigPathForWrite = () => {
      capturedGuard();
      callerGuard();
    };
  } else if (capturedGuard) {
    merged.assertConfigPathForWrite = capturedGuard;
  }
  return merged;
}
