export const PACKAGE_LIFECYCLE_MARKER_CONTRACT_RELATIVE_PATH: string;
export const PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH: string;
export const LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH: string;
export const UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV: string;
export const RUNTIME_ACTIVATION_MANUAL_RELATIVE_PATH: string;
export function applyRuntimeActivationPolicy(params: {
  packageRoot: string;
  env?: NodeJS.ProcessEnv;
  rmSync?: (path: string, options: { force: boolean }) => void;
  writeFileSync?: (path: string, data: string) => void;
}): boolean;
