/** Discovers installed gateway service candidates; native owners verify lifecycle authority. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { hasErrnoCode } from "../infra/errno.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
  resolveNodeLaunchAgentLabel,
} from "./constants.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { parseLaunchdPlistLabel } from "./launchd-plist.js";
import { readLaunchDaemonPlistLabel } from "./launchd-system.js";
import { resolveDaemonHomeDir } from "./paths.js";
import { readScheduledTaskCommand, resolveTaskName } from "./schtasks-layout.js";
import { listScheduledTasks } from "./schtasks-state-probe.js";
import { resolveSystemdServiceName } from "./systemd-service-files.js";
import { parseSystemdExecStart, splitSystemdLogicalLines } from "./systemd-unit.js";

export type ExtraGatewayService = {
  platform: "darwin" | "linux" | "win32";
  label: string;
  detail: string;
  scope: "user" | "system";
  marker?: "openclaw" | "clawdbot";
  legacy?: boolean;
};

export type FindExtraGatewayServicesOptions = {
  deep?: boolean;
};

export type GatewayServiceInventory = {
  services: ExtraGatewayService[];
  errors: Array<{ source: string; message: string }>;
};

const EXTRA_MARKERS = ["openclaw", "clawdbot"] as const;

function quotePosixCleanupArgument(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderGatewayServiceCleanupHints(
  services: readonly ExtraGatewayService[] = [],
): string[] {
  const hints: string[] = [];

  for (const service of services) {
    switch (service.platform) {
      case "darwin": {
        const plistPath = service.detail.startsWith("plist:")
          ? service.detail.slice("plist:".length).trim()
          : undefined;
        // Global LaunchAgents still run in a GUI domain; only LaunchDaemons
        // belong to the system domain regardless of their shared file scope.
        const domain =
          service.scope === "system" && plistPath?.startsWith("/Library/LaunchDaemons/")
            ? "system"
            : "gui/$UID";
        const launchctlCommand = domain === "system" ? "sudo launchctl" : "launchctl";
        hints.push(
          `${launchctlCommand} bootout ${domain}/${quotePosixCleanupArgument(service.label)}`,
        );
        if (plistPath) {
          const removeCommand = service.scope === "system" ? "sudo rm" : "rm";
          hints.push(`${removeCommand} ${quotePosixCleanupArgument(plistPath)}`);
        }
        break;
      }
      case "linux": {
        const systemctlCommand = `systemctl --${service.scope}`;
        const unit = quotePosixCleanupArgument(service.label);
        // A discovered unit may be the only running Gateway; inspect before removal.
        hints.push(`${systemctlCommand} status -- ${unit}`, `${systemctlCommand} cat -- ${unit}`);
        break;
      }
      case "win32":
        // The hint can be pasted into cmd.exe or PowerShell, so exclude names
        // that either shell can expand rather than guessing a common escape.
        if (/^[A-Za-z0-9_. ()\\/-]+$/.test(service.label)) {
          hints.push(`schtasks /Delete /TN "${service.label}" /F`);
        }
        break;
    }
  }

  return hints;
}

type Marker = (typeof EXTRA_MARKERS)[number];

function hasGatewaySubcommandArg(args: string[]): boolean {
  return args.some((arg) => {
    const normalized = normalizeLowercaseStringOrEmpty(arg);
    return normalized === "gateway" || /(^|\s)gateway(\s|$)/.test(normalized);
  });
}

export function detectMarkerLineWithGateway(contents: string): Marker | null {
  // Use the same physical-comment rules as service rewrites; comments must not
  // hide a runnable extra service from diagnostics.
  for (const line of splitSystemdLogicalLines(contents)) {
    const trimmed = normalizeLowercaseStringOrEmpty(line);
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    const assignment = trimmed.indexOf("=");
    if (assignment > 0) {
      const key = trimmed.slice(0, assignment).trim();
      if (
        key !== "execstart" ||
        !hasGatewaySubcommandArg(parseSystemdExecStart(trimmed.slice(assignment + 1).trim()))
      ) {
        continue;
      }
    }
    if (!trimmed.includes("gateway")) {
      continue;
    }
    for (const marker of EXTRA_MARKERS) {
      if (trimmed.includes(marker)) {
        return marker;
      }
    }
  }
  return null;
}

function hasGatewayServiceMarker(content: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(content);
  return (
    lower.includes("openclaw_service_marker") &&
    lower.includes("openclaw_service_kind") &&
    lower.includes(normalizeLowercaseStringOrEmpty(GATEWAY_SERVICE_MARKER)) &&
    lower.includes(normalizeLowercaseStringOrEmpty(GATEWAY_SERVICE_KIND))
  );
}

function extractPlistKeyBlock(
  contents: string,
  key: string,
  tag: "array" | "string",
): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `<key>${escapedKey}<\\/key>\\s*<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "i",
  );
  const match = contents.match(pattern);
  return match?.[1]?.trim() || null;
}

function extractPlistStringValues(
  contents: string,
  key: string,
  tag: "array" | "string",
): string[] {
  const block = extractPlistKeyBlock(contents, key, tag);
  if (!block) {
    return [];
  }
  if (tag === "string") {
    return [block];
  }
  return Array.from(block.matchAll(/<string>([\s\S]*?)<\/string>/gi))
    .map((match) => match[1]?.trim() ?? "")
    .filter(Boolean);
}

function detectLaunchdGatewayExecutionMarker(contents: string): Marker | null {
  const program = extractPlistStringValues(contents, "Program", "string");
  const programArguments = extractPlistStringValues(contents, "ProgramArguments", "array");
  if (!hasGatewaySubcommandArg(programArguments)) {
    return null;
  }
  // Only execution command fields identify gateway jobs; labels alone catch too
  // many unrelated helper jobs.
  const launchCommand = normalizeLowercaseStringOrEmpty(
    [...program, ...programArguments].filter(Boolean).join("\n"),
  );
  return EXTRA_MARKERS.find((marker) => launchCommand.includes(marker)) ?? null;
}

function isOpenClawGatewayTaskName(name: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  if (!normalized) {
    return false;
  }
  // Windows schtasks /Query returns task names prefixed with \ (e.g.
  // \OpenClaw Gateway for root-folder tasks). Strip the leading
  // backslash so the configured name matches correctly and the live
  // gateway task is not misidentified as an extra gateway service.
  const stripped = normalized.replace(/^\\+/, "");
  const defaultName = normalizeLowercaseStringOrEmpty(resolveGatewayWindowsTaskName());
  return stripped === defaultName || /^openclaw gateway \(.+\)$/.test(stripped);
}

function isLegacyLabel(label: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(label);
  return lower.includes("clawdbot");
}

function isPotentialGatewayServiceName(
  name: string,
  platform: "darwin" | "linux",
  selected?: string,
): boolean {
  return (
    name === selected ||
    (platform === "darwin"
      ? (name.startsWith("ai.openclaw.") && name !== resolveNodeLaunchAgentLabel()) ||
        /clawdbot.*gateway/.test(name)
      : /^(?:openclaw|clawdbot)-gateway(?:$|[-.])/.test(name))
  );
}

async function readServicePath<T>(
  source: string,
  read: () => Promise<T>,
  errors?: GatewayServiceInventory["errors"],
): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      errors?.push({ source, message: "Service path could not be inspected." });
    }
    return null;
  }
}

type ServiceFileEntry = {
  entry: string;
  name: string;
  fullPath: string;
  contents: string;
};

async function collectServiceFiles(params: {
  dir: string;
  extension: string;
  ignoredName?: string;
  isPotentialName: (name: string) => boolean;
  errors?: GatewayServiceInventory["errors"];
}): Promise<ServiceFileEntry[]> {
  const out: ServiceFileEntry[] = [];
  const entries = await readServicePath(params.dir, () => fs.readdir(params.dir), params.errors);
  for (const entry of (entries ?? []).toSorted()) {
    if (!entry.endsWith(params.extension)) {
      continue;
    }
    const name = entry.slice(0, -params.extension.length);
    if (name === params.ignoredName) {
      continue;
    }
    const fullPath = path.join(params.dir, entry);
    const contents = await readServicePath(
      fullPath,
      () => fs.readFile(fullPath, "utf8"),
      params.isPotentialName(name) ? params.errors : undefined,
    );
    if (contents === null) {
      continue;
    }
    out.push({ entry, name, fullPath, contents });
  }
  return out;
}

async function scanLaunchdDir(params: {
  dir: string;
  scope: "user" | "system";
  includeManagedOpenClaw?: boolean;
  managedLabel?: string;
  selectedName?: string;
  errors?: GatewayServiceInventory["errors"];
}): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  const isPotentialName = (name: string) =>
    isPotentialGatewayServiceName(name, "darwin", params.selectedName);
  const candidates = await collectServiceFiles({
    dir: params.dir,
    extension: ".plist",
    ignoredName: params.includeManagedOpenClaw ? undefined : resolveGatewayLaunchAgentLabel(),
    isPotentialName,
    errors: params.errors,
  });

  for (const { name: labelFromName, fullPath, contents } of candidates) {
    const parsedLabel = parseLaunchdPlistLabel(contents);
    const executionMarker = detectLaunchdGatewayExecutionMarker(contents);
    const serviceMarker = hasGatewayServiceMarker(contents);
    const relevant =
      isPotentialName(labelFromName) ||
      (parsedLabel && isPotentialName(parsedLabel)) ||
      executionMarker ||
      serviceMarker;
    const errors = relevant ? params.errors : undefined;
    const nativeLabel =
      params.includeManagedOpenClaw && (!parsedLabel || params.scope === "system")
        ? await readServicePath(fullPath, () => readLaunchDaemonPlistLabel(fullPath), errors)
        : null;
    if (nativeLabel?.status === "unreadable" || nativeLabel?.status === "unverifiable") {
      errors?.push({ source: fullPath, message: "Service plist could not be inspected." });
    }
    const label = nativeLabel?.status === "ok" ? nativeLabel.label : (parsedLabel ?? labelFromName);
    const legacyLabel = isLegacyLabel(labelFromName) || isLegacyLabel(label);
    const marker =
      label === params.managedLabel || serviceMarker || executionMarker === "openclaw"
        ? "openclaw"
        : executionMarker === "clawdbot" || legacyLabel
          ? "clawdbot"
          : null;
    if (!marker) {
      continue;
    }
    // Managed current services are expected; this scan reports extra jobs that
    // can compete for ports or survive old installs.
    if (
      !params.includeManagedOpenClaw &&
      (label === resolveGatewayLaunchAgentLabel() ||
        (marker === "openclaw" &&
          (serviceMarker || (executionMarker === "openclaw" && label.startsWith("ai.openclaw.")))))
    ) {
      continue;
    }
    results.push({
      platform: "darwin",
      label,
      detail: `plist: ${fullPath}`,
      scope: params.scope,
      marker,
      legacy: marker !== "openclaw" || isLegacyLabel(label),
    });
  }

  return results;
}

async function scanSystemdDir(params: {
  dir: string;
  scope: "user" | "system";
  includeManagedOpenClaw?: boolean;
  selectedName?: string;
  errors?: GatewayServiceInventory["errors"];
}): Promise<ExtraGatewayService[]> {
  const results: ExtraGatewayService[] = [];
  const candidates = await collectServiceFiles({
    dir: params.dir,
    extension: ".service",
    ignoredName: params.includeManagedOpenClaw ? undefined : resolveGatewaySystemdServiceName(),
    isPotentialName: (name) => isPotentialGatewayServiceName(name, "linux", params.selectedName),
    errors: params.errors,
  });

  for (const { entry, name, fullPath, contents } of candidates) {
    const serviceMarker = hasGatewayServiceMarker(contents);
    const marker = serviceMarker ? "openclaw" : detectMarkerLineWithGateway(contents);
    if (!marker) {
      continue;
    }
    if (
      !params.includeManagedOpenClaw &&
      marker === "openclaw" &&
      (serviceMarker ||
        (name.startsWith("openclaw-gateway") &&
          normalizeLowercaseStringOrEmpty(contents).includes("gateway")))
    ) {
      continue;
    }
    results.push({
      platform: "linux",
      label: entry,
      detail: `unit: ${fullPath}`,
      scope: params.scope,
      marker,
      legacy: marker !== "openclaw",
    });
  }

  return results;
}

export async function findSystemGatewayServices(): Promise<ExtraGatewayService[]> {
  if (process.platform !== "linux") {
    return [];
  }

  const results: ExtraGatewayService[] = [];
  try {
    for (const dir of ["/etc/systemd/system", "/usr/lib/systemd/system", "/lib/systemd/system"]) {
      results.push(
        ...(await scanSystemdDir({
          dir,
          scope: "system",
          includeManagedOpenClaw: true,
        })),
      );
    }
  } catch {
    return [];
  }

  return results;
}

async function scanGatewayServices(
  env: Record<string, string | undefined>,
  opts: FindExtraGatewayServicesOptions & { includeManagedOpenClaw?: boolean },
): Promise<GatewayServiceInventory> {
  const inventory: GatewayServiceInventory = { services: [], errors: [] };
  const { services, errors } = inventory;
  const seen = new Set<string>();
  const push = (svc: ExtraGatewayService) => {
    const key = `${svc.platform}:${svc.label}:${svc.detail}:${svc.scope}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    services.push(svc);
  };

  if (process.platform === "darwin") {
    try {
      const home = resolveDaemonHomeDir(env);
      const userDir = path.join(home, "Library", "LaunchAgents");
      for (const svc of await scanLaunchdDir({
        dir: userDir,
        scope: "user",
        includeManagedOpenClaw: opts.includeManagedOpenClaw,
        selectedName: resolveLaunchAgentLabel(env),
        errors,
      })) {
        push(svc);
      }
      if (opts.deep) {
        for (const svc of await scanLaunchdDir({
          dir: path.join(path.sep, "Library", "LaunchAgents"),
          scope: "system",
          includeManagedOpenClaw: opts.includeManagedOpenClaw,
          selectedName: resolveLaunchAgentLabel(env),
          errors,
        })) {
          push(svc);
        }
        for (const svc of await scanLaunchdDir({
          dir: path.join(path.sep, "Library", "LaunchDaemons"),
          scope: "system",
          includeManagedOpenClaw: true,
          managedLabel: resolveLaunchAgentLabel(env),
          selectedName: resolveLaunchAgentLabel(env),
          errors,
        })) {
          push(svc);
        }
      }
    } catch {
      errors.push({ source: "launchd", message: "Gateway service discovery could not finish." });
    }
    return inventory;
  }

  if (process.platform === "linux") {
    try {
      const home = resolveDaemonHomeDir(env);
      const userDir = path.join(home, ".config", "systemd", "user");
      const userServices = await scanSystemdDir({
        dir: userDir,
        scope: "user",
        includeManagedOpenClaw: opts.includeManagedOpenClaw,
        selectedName: resolveSystemdServiceName(env),
        errors,
      });
      for (const svc of userServices) {
        push(svc);
      }
      for (const name of opts.includeManagedOpenClaw ? [] : LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES) {
        const label = `${name}.service`;
        // The unit and its managed backup are one cleanup target. Report the
        // backup separately only when it is the remaining orphaned artifact.
        if (userServices.some((service) => service.label === label)) {
          continue;
        }
        const backupPath = path.join(userDir, `${name}.service.bak`);
        if ((await readServicePath(backupPath, () => fs.readFile(backupPath, "utf8"))) !== null) {
          push({
            platform: "linux",
            label,
            detail: `unit backup: ${backupPath}`,
            scope: "user",
            marker: "clawdbot",
            legacy: true,
          });
        }
      }
      if (opts.deep) {
        for (const dir of [
          "/etc/systemd/system",
          "/usr/lib/systemd/system",
          "/lib/systemd/system",
        ]) {
          for (const svc of await scanSystemdDir({
            dir,
            scope: "system",
            includeManagedOpenClaw: opts.includeManagedOpenClaw,
            selectedName: resolveSystemdServiceName(env),
            errors,
          })) {
            push(svc);
          }
        }
      }
    } catch {
      errors.push({ source: "systemd", message: "Gateway service discovery could not finish." });
    }
    return inventory;
  }

  if (process.platform === "win32") {
    if (!opts.deep && !opts.includeManagedOpenClaw) {
      return inventory;
    }
    let tasks: ReturnType<typeof listScheduledTasks>;
    try {
      tasks = listScheduledTasks();
    } catch {
      errors.push({ source: "schtasks", message: "Scheduled tasks could not be queried." });
      return inventory;
    }
    for (const task of tasks) {
      const name = task.taskPath?.trim();
      if (!name) {
        continue;
      }
      if (!opts.includeManagedOpenClaw && isOpenClawGatewayTaskName(name)) {
        continue;
      }
      const taskToRun =
        task.actions?.map((action) => `${action.path} ${action.arguments}`.trim()).join("; ") ?? "";
      const description = `${name}\n${taskToRun}`;
      let gateway =
        isOpenClawGatewayTaskName(name) || Boolean(detectMarkerLineWithGateway(description));
      let marker: Marker | undefined = EXTRA_MARKERS.find((candidate) =>
        description.toLowerCase().includes(candidate),
      );
      const selected =
        name.replace(/^\\+/, "").toLowerCase() ===
        resolveTaskName(env).replace(/^\\+/, "").toLowerCase();
      if (!task.actions) {
        if (gateway || selected) {
          errors.push({ source: name, message: "Scheduled Task action could not be inspected." });
        }
        continue;
      }
      if (task.actions?.some((action) => /\.(?:cmd|vbs)$/i.test(action.path))) {
        try {
          const command = await readScheduledTaskCommand(
            { ...env, OPENCLAW_WINDOWS_TASK_NAME: name, OPENCLAW_PROFILE: undefined },
            {
              requireEffective: true,
              requireLoaded: true,
              onLauncherContent: (content) => {
                const contentMarker =
                  detectMarkerLineWithGateway(content) ||
                  (hasGatewayServiceMarker(content) ? "openclaw" : undefined);
                gateway ||= Boolean(contentMarker);
                marker = contentMarker ?? marker;
              },
            },
          );
          const commandMarker =
            command && detectMarkerLineWithGateway(command.programArguments.join(" "));
          const serviceMarker = command?.environment?.OPENCLAW_SERVICE_MARKER;
          const serviceKind = command?.environment?.OPENCLAW_SERVICE_KIND;
          gateway = Boolean(
            commandMarker || (serviceMarker === "openclaw" && serviceKind === "gateway"),
          );
          marker = commandMarker || (serviceMarker === "openclaw" ? "openclaw" : marker);
        } catch {
          if (gateway || selected) {
            errors.push({
              source: name,
              message: "Scheduled Task launcher could not be inspected.",
            });
          }
          continue;
        }
      }
      if (!marker || (opts.includeManagedOpenClaw && !gateway)) {
        continue;
      }
      push({
        platform: "win32",
        label: name,
        detail: taskToRun ? `task: ${name}, run: ${taskToRun}` : name,
        scope: "system",
        marker,
        legacy: marker !== "openclaw",
      });
    }
    return inventory;
  }

  return inventory;
}

export async function findGatewayServices(
  env: Record<string, string | undefined>,
  opts: FindExtraGatewayServicesOptions = {},
): Promise<GatewayServiceInventory> {
  return await scanGatewayServices(env, { ...opts, includeManagedOpenClaw: true });
}

export async function findExtraGatewayServices(
  env: Record<string, string | undefined>,
  opts: FindExtraGatewayServicesOptions = {},
): Promise<ExtraGatewayService[]> {
  return (await scanGatewayServices(env, opts)).services;
}
