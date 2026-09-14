import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH =
  "scripts/lib/package-lifecycle-marker.mjs";
export const PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH = ".openclaw-lifecycle-pending";
// 2026.8.1 shipped this path. Remove after the supported upgrade floor moves past that release.
export const LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH = "dist/openclaw-install-guard";
export const UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV =
  "OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION";
export const RUNTIME_ACTIVATION_MANUAL_RELATIVE_PATH =
  "node_modules/.openclaw-runtime-activation-manual";

export function applyRuntimeActivationPolicy(params) {
  const env = params.env ?? process.env;
  const policy = env?.[UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV]?.trim();
  if (policy !== "0" && policy !== "1") {
    if (policy) {
      throw new Error(`${UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV} must be 0 or 1 when set`);
    }
    return false;
  }

  const markerPath = join(params.packageRoot, RUNTIME_ACTIVATION_MANUAL_RELATIVE_PATH);
  const removePath = params.rmSync ?? rmSync;
  removePath(markerPath, { force: true });
  if (policy === "0") {
    mkdirSync(dirname(markerPath), { recursive: true });
    (params.writeFileSync ?? writeFileSync)(markerPath, "manual\n");
  }
  return true;
}
