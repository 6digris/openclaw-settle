import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";

/** Inference placement is a recorded provider-profile choice, not a worker fallback. */
export function workerInferencePlacement(
  environment: Pick<WorkerEnvironmentRecord, "providerId" | "profileSnapshot">,
): "gateway" | "runtime-local" {
  const settings = environment.profileSnapshot.settings;
  const placement = isRecord(settings) ? settings.inference : undefined;
  if (placement === undefined || placement === "gateway") {
    return "gateway";
  }
  if (placement !== "runtime-local" || environment.providerId !== DEVICE_WORKER_PROVIDER_ID) {
    throw new Error(
      "Runtime-local inference requires an explicitly configured paired-device worker profile",
    );
  }
  return "runtime-local";
}
