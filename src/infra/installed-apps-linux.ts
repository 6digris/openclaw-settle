/** Linux desktop-entry inventory and exact zero-argument native launch preparation. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InstalledAppIdSchema, type InstalledAppLaunchRequest } from "./installed-app-launch.js";
import type { InstalledApp } from "./installed-apps.js";

const MAX_DESKTOP_ENTRY_BYTES = 64 * 1024;
const MAX_DESKTOP_ENTRIES = 2048;

function applicationRoots(env: NodeJS.ProcessEnv): string[] {
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const dataDirs = (env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":");
  return [...new Set([dataHome, ...dataDirs].filter((root) => path.isAbsolute(root)))].map((root) =>
    path.join(root, "applications"),
  );
}

function desktopEntryFields(raw: string): Map<string, string> | undefined {
  const fields = new Map<string, string>();
  let inEntry = false;
  let seenEntry = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[")) {
      inEntry = line === "[Desktop Entry]";
      if (inEntry && seenEntry) {
        return undefined;
      }
      seenEntry ||= inEntry;
      continue;
    }
    if (!inEntry) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator < 1) {
      return undefined;
    }
    const key = line.slice(0, separator).trim();
    if (fields.has(key)) {
      return undefined;
    }
    fields.set(key, line.slice(separator + 1).trim());
  }
  return seenEntry ? fields : undefined;
}

/** Decode one Exec executable under Desktop Entry §§4/7, never a shell command line. */
function singleDesktopExecutable(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const escapes: Record<string, string> = { s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" };
  const command = raw.replace(
    /\\([sntr\\])/g,
    (_match: string, escape: string) => escapes[escape] ?? "",
  );
  const backtick = String.fromCharCode(96);
  let executable = "";
  if (command.startsWith('"')) {
    if (!command.endsWith('"') || command.length < 3) {
      return undefined;
    }
    for (let index = 1; index < command.length - 1; index += 1) {
      const char = command[index]!;
      if (char === "\\") {
        const escaped = command[++index];
        if (
          index >= command.length - 1 ||
          !escaped ||
          !['"', "\\", "$", backtick].includes(escaped)
        ) {
          return undefined;
        }
        executable += escaped;
      } else {
        if (char === '"' || char === "$" || char === backtick) {
          return undefined;
        }
        executable += char;
      }
    }
  } else {
    const reserved = new Set([
      '"',
      "'",
      "\\",
      ">",
      "<",
      "~",
      "|",
      "&",
      ";",
      "$",
      "*",
      "?",
      "#",
      "(",
      ")",
      backtick,
    ]);
    for (const char of command) {
      if (/\s/u.test(char) || reserved.has(char)) {
        return undefined;
      }
    }
    executable = command;
  }
  // Field expansion and executable assignments are outside the closed zero-argument contract.
  // Desktop Entry forbids control characters; field codes and assignments are not launch identities.
  // eslint-disable-next-line no-control-regex
  return executable && !/[\u0000-\u001f\u007f%=]/u.test(executable) ? executable : undefined;
}

export type PreparedLinuxInstalledApp = {
  app: InstalledApp & InstalledAppLaunchRequest;
  executable: string;
};

/** A higher-precedence entry masks even invalid entries. Search roots are node-owned. */
export function prepareLinuxInstalledApp(
  appId: string,
  env: NodeJS.ProcessEnv = process.env,
): PreparedLinuxInstalledApp | undefined {
  if (!InstalledAppIdSchema.safeParse(appId).success) {
    return undefined;
  }
  const filename = appId.slice("linux-desktop:".length);
  for (const root of applicationRoots(env)) {
    const entryPath = path.join(root, filename);
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(entryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      return undefined;
    }
    if (!entry.isFile() || entry.size > MAX_DESKTOP_ENTRY_BYTES) {
      return undefined;
    }
    try {
      const raw = fs.readFileSync(entryPath, "utf8");
      const fields = desktopEntryFields(raw);
      const exec = singleDesktopExecutable(fields?.get("Exec"));
      const label = fields?.get("Name");
      if (
        fields?.get("Type") !== "Application" ||
        !label ||
        fields.get("Hidden") === "true" ||
        fields.get("NoDisplay") === "true" ||
        fields.get("Terminal") === "true" ||
        fields.has("Path") ||
        !exec
      ) {
        return undefined;
      }
      // Never interpret shell syntax, desktop field codes, flags, or extra arguments.
      const candidates = path.isAbsolute(exec)
        ? [exec]
        : exec.includes("/")
          ? []
          : (env.PATH || "/usr/local/bin:/usr/bin:/bin")
              .split(":")
              .filter((part) => path.isAbsolute(part))
              .map((part) => path.join(part, exec));
      for (const candidate of candidates) {
        let executable: string;
        try {
          executable = fs.realpathSync(candidate);
          fs.accessSync(executable, fs.constants.X_OK);
        } catch {
          continue;
        }
        const binary = fs.statSync(executable);
        if (!binary.isFile()) {
          continue;
        }
        // Script launchers can execute additional commands; this slice supports native ELF apps.
        const fd = fs.openSync(executable, "r");
        const magic = Buffer.alloc(4);
        try {
          fs.readSync(fd, magic, 0, 4, 0);
        } finally {
          fs.closeSync(fd);
        }
        if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
          return undefined;
        }
        const appRevision = createHash("sha256")
          .update(
            JSON.stringify([
              fs.realpathSync(entryPath),
              executable,
              binary.dev,
              binary.ino,
              binary.size,
              binary.mtimeMs,
              binary.ctimeMs,
            ]),
          )
          .digest("hex");
        return {
          executable,
          app: { appId, appRevision, label, path: entryPath, system: false },
        };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }
  return undefined;
}

export function scanLinuxInstalledApps(env: NodeJS.ProcessEnv = process.env): InstalledApp[] {
  const names = new Set<string>();
  for (const root of applicationRoots(env)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries.toSorted()) {
      if (name.endsWith(".desktop") && names.size < MAX_DESKTOP_ENTRIES) {
        names.add(name);
      }
    }
  }
  return [...names]
    .flatMap((name) => {
      const prepared = prepareLinuxInstalledApp(`linux-desktop:${name}`, env);
      return prepared ? [prepared.app] : [];
    })
    .toSorted((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
}
