import { normalizeWindowsTaskIdentity } from "./constants.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { resolveTaskName } from "./schtasks-layout.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";

export function resolveManagedGatewayServiceIdentity(env: GatewayServiceEnv): string {
  return process.platform === "win32"
    ? normalizeWindowsTaskIdentity(resolveTaskName(env))
    : process.platform === "darwin"
      ? resolveLaunchAgentLabel(env)
      : resolveSystemdServiceName(env);
}
