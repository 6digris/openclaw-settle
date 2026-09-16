import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import type { UpdateChannel } from "./update-channels.js";

export function resolveUpdateCliArgv(params: {
  timeoutMs?: number;
  channel?: UpdateChannel;
  tag?: string;
  acceptCapabilities?: boolean;
  reapplyLocalOverrides?: boolean;
  execPath?: string;
  argv1?: string;
}): string[] {
  const updateArgs = ["update", "--yes", "--json"];
  if (params.reapplyLocalOverrides) {
    updateArgs.push("--reapply-local-overrides");
  }
  if (params.acceptCapabilities) {
    updateArgs.push("--accept-capabilities");
  }
  if (params.channel) {
    updateArgs.push("--channel", params.channel);
  }
  if (params.tag) {
    updateArgs.push("--tag", params.tag);
  }
  if (typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)) {
    updateArgs.push("--timeout", String(Math.max(1, Math.ceil(params.timeoutMs / 1000))));
  }

  return resolveManagedServiceCliArgv(params, updateArgs);
}

export function resolveManagedServiceCliArgv(
  params: { execPath?: string; argv1?: string },
  args: string[],
): string[] {
  const execPath = params.execPath?.trim();
  const argv1 = params.argv1?.trim();
  if (execPath && argv1) {
    return [execPath, argv1, ...args];
  }
  if (execPath && !/^(?:node|bun)(?:\.exe)?$/iu.test(path.basename(execPath))) {
    return [execPath, ...args];
  }
  return ["openclaw", ...args];
}

export function formatManagedServiceUpdateCommand(
  params?: {
    timeoutMs?: number;
    channel?: UpdateChannel;
    tag?: string;
    acceptCapabilities?: boolean;
    reapplyLocalOverrides?: boolean;
  },
  env: NodeJS.ProcessEnv = process.env,
): string {
  return formatCliCommand(
    resolveUpdateCliArgv(params ?? {})
      .toSpliced(3, 1)
      .join(" "),
    env,
  );
}

export function buildManagedServiceHandoffUnavailableMessage(command: string): string {
  return [
    "OpenClaw updates cannot safely run inside the live gateway process without a managed-service handoff.",
    `Stop the foreground Gateway, run \`${command}\` from a shell, then launch the Gateway again. For a managed deployment, use its host's stop, update, and restart workflow.`,
  ].join("\n");
}
