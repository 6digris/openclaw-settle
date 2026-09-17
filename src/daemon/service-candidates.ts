import { cloneEnvWithPlatformSemantics } from "../config/env-vars.js";
import {
  GATEWAY_SERVICE_RUNTIME_PID_ENV,
  GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
  normalizeWindowsTaskIdentity,
} from "./constants.js";
import { findGatewayServices } from "./inspect.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { resolveTaskName } from "./schtasks-layout.js";
import {
  ServiceDefinitionInspectionError,
  ServiceInspectionError,
} from "./service-inspection-error.js";
import { resolveServiceEntrypointIndex } from "./service-layout.js";
import type {
  GatewayServiceEnv,
  GatewayServiceEnvArgs,
  GatewayServiceState,
} from "./service-types.js";
import { readGatewayServiceState, type GatewayService } from "./service.js";
import { resolveSystemdGatewayInstanceName } from "./systemd-scope.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";

export function resolveManagedGatewayServiceIdentity(env: GatewayServiceEnv): string {
  return process.platform === "win32"
    ? normalizeWindowsTaskIdentity(resolveTaskName(env))
    : process.platform === "darwin"
      ? resolveLaunchAgentLabel(env)
      : resolveSystemdServiceName(env);
}

/** Native snapshots are discovery facts; callers still prove target ownership before mutation. */
export async function readGatewayServiceCandidates(
  service: GatewayService,
  args: GatewayServiceEnvArgs & {
    knownServiceEnvs?: readonly GatewayServiceEnv[];
    onInspectionUnavailable?: (error: ServiceInspectionError) => boolean;
  } = {},
): Promise<GatewayServiceState[]> {
  const baseEnv = args.env ?? process.env;
  const inventory = await findGatewayServices(baseEnv, {
    deep: process.platform === "linux" || process.platform === "darwin",
  });
  if (inventory.errors.length > 0) {
    throw new ServiceDefinitionInspectionError(
      inventory.errors.map((error) => error.source).join(", "),
    );
  }
  const known = new Set(
    args.knownServiceEnvs?.map(
      (env) =>
        `${process.platform === "win32" ? "system" : "user"}:${resolveManagedGatewayServiceIdentity(env)}`,
    ),
  );
  const states: GatewayServiceState[] = [];
  for (const candidate of inventory.services) {
    if (candidate.marker !== "openclaw" || candidate.platform !== process.platform) {
      continue;
    }
    const externalLaunchdPlist =
      candidate.platform === "darwin" && candidate.scope === "system"
        ? candidate.detail.slice("plist: ".length)
        : undefined;
    const env = cloneEnvWithPlatformSemantics(baseEnv);
    for (const key of [
      ...GATEWAY_SERVICE_SELECTOR_ENV_KEYS,
      GATEWAY_SERVICE_RUNTIME_PID_ENV,
      "OPENCLAW_HOME",
      "OPENCLAW_WORKSPACE_DIR",
      "OPENCLAW_TASK_SCRIPT",
      "OPENCLAW_TASK_SCRIPT_NAME",
      "OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER",
      "OPENCLAW_SERVICE_MARKER",
      "OPENCLAW_SERVICE_KIND",
    ]) {
      delete env[key];
    }
    const selector =
      candidate.platform === "darwin"
        ? "OPENCLAW_LAUNCHD_LABEL"
        : candidate.platform === "linux"
          ? "OPENCLAW_SYSTEMD_UNIT"
          : "OPENCLAW_WINDOWS_TASK_NAME";
    const label =
      candidate.platform === "linux" && candidate.scope === "system"
        ? resolveSystemdGatewayInstanceName(candidate.label)
        : candidate.label;
    env[selector] = label;
    const identity = `${candidate.scope}:${resolveManagedGatewayServiceIdentity(env)}${externalLaunchdPlist ? `\0${externalLaunchdPlist}` : ""}`;
    if (known.has(identity)) {
      continue;
    }
    let state: GatewayServiceState;
    try {
      const systemdReadTarget =
        candidate.platform === "linux" && candidate.scope === "system"
          ? {
              scope: "system" as const,
              unitName: label,
              unitPath: candidate.detail.slice("unit: ".length),
            }
          : undefined;
      state = await readGatewayServiceState(service, {
        env,
        externalLaunchdPlist,
        systemdInstallation: systemdReadTarget
          ? { kind: "system", system: systemdReadTarget }
          : undefined,
        requireEffective: true,
        requireLoadedCommand: true,
        timeoutMs: args.timeoutMs,
      });
    } catch (error) {
      if (
        error instanceof ServiceInspectionError &&
        error.reason !== "launchd-system-owned" &&
        args.onInspectionUnavailable?.(error)
      ) {
        continue;
      }
      throw error instanceof ServiceInspectionError ||
        error instanceof ServiceDefinitionInspectionError
        ? error
        : new ServiceDefinitionInspectionError(externalLaunchdPlist ?? candidate.label);
    }
    const entrypointIndex =
      state.command && resolveServiceEntrypointIndex(state.command.programArguments);
    if (
      entrypointIndex !== undefined &&
      entrypointIndex !== null &&
      state.command?.programArguments[entrypointIndex + 1] === "node"
    ) {
      continue;
    }
    known.add(identity);
    states.push(state);
  }
  return states;
}
