/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import type { SpawnOptions } from "node:child_process";
import { spawnProcess } from "../../process/spawn-utils.js";
import {
  buildShellCommandInvocation,
  getBashShellConfig,
  getBashShellEnv,
} from "../shell-utils.js";

// Retain in-flight results too: concurrent requests execute each cached command once.
const commandResultCache = new Map<string, Promise<string | undefined>>();

type ShellResult = { executed: boolean; value: string | undefined };

function executeShell(
  command: string,
  args: string[],
  options: SpawnOptions,
  input?: string,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawnProcess(command, args, { cwd: process.cwd(), ...options });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failed = false;
    let missing = false;
    const stop = () => {
      failed = true;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(stop, 10_000);
    child.once("error", (error: NodeJS.ErrnoException) => {
      failed = true;
      missing = error.code === "ENOENT";
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const value = !failed && code === 0 ? Buffer.concat(chunks).toString("utf8").trim() : "";
      resolve({ executed: !missing, value: value || undefined });
    });
    // Broker stdio arrives with spawn; local children expose it before the same event.
    child.once("spawn", () => {
      child.stdout?.on("error", stop);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (failed) {
          return;
        }
        bytes += chunk.length;
        if (bytes > 1024 * 1024) {
          stop();
        } else {
          chunks.push(chunk);
        }
      });
      child.stdin?.on("error", stop);
      child.stdin?.end(failed ? undefined : input);
    });
  });
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 */
export async function resolveConfigValue(config: string): Promise<string | undefined> {
  if (config.startsWith("!")) {
    return executeCommand(config);
  }
  const envValue = process.env[config];
  return envValue || config;
}

async function executeWithConfiguredShell(command: string): Promise<ShellResult> {
  try {
    const shellConfig = getBashShellConfig();
    const invocation = buildShellCommandInvocation(command, shellConfig);
    const [shell, ...args] = invocation.argv;
    return await executeShell(
      shell,
      args,
      {
        stdio: [invocation.stdin, "pipe", "ignore"],
        shell: false,
        windowsHide: true,
        env: getBashShellEnv(shellConfig.shell),
      },
      invocation.input,
    );
  } catch {
    return { executed: false, value: undefined };
  }
}

async function executeWithDefaultShell(command: string): Promise<string | undefined> {
  try {
    const result = await executeShell(command, [], {
      shell: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.value;
  } catch {
    return undefined;
  }
}

async function executeCommandUncached(commandConfig: string): Promise<string | undefined> {
  const command = commandConfig.slice(1);
  if (process.platform === "win32") {
    const configuredResult = await executeWithConfiguredShell(command);
    if (configuredResult.executed) {
      return configuredResult.value;
    }
  }
  return executeWithDefaultShell(command);
}

function executeCommand(commandConfig: string): Promise<string | undefined> {
  const cached = commandResultCache.get(commandConfig);
  if (cached) {
    return cached;
  }

  const result = executeCommandUncached(commandConfig);
  commandResultCache.set(commandConfig, result);
  return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export async function resolveConfigValueUncached(config: string): Promise<string | undefined> {
  if (config.startsWith("!")) {
    return executeCommandUncached(config);
  }
  const envValue = process.env[config];
  return envValue || config;
}

export async function resolveConfigValueOrThrow(
  config: string,
  description: string,
): Promise<string> {
  const resolvedValue = await resolveConfigValueUncached(config);
  if (resolvedValue !== undefined) {
    return resolvedValue;
  }

  if (config.startsWith("!")) {
    throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
  }

  throw new Error(`Failed to resolve ${description}`);
}

export async function resolveHeadersOrThrow(
  headers: Record<string, string> | undefined,
  description: string,
): Promise<Record<string, string> | undefined> {
  if (!headers) {
    return undefined;
  }
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = await resolveConfigValueOrThrow(value, `${description} header "${key}"`);
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}
