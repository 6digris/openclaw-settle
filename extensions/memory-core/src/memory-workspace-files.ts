import fs from "node:fs/promises";
import path from "node:path";
import {
  getAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { isShortTermSessionCorpusPath } from "./short-term-promotion-utils.js";

type MemoryBridge = NonNullable<AgentWorkspaceAccess["memoryBridge"]>;

/** Gateway session-derived corpus is private; workspace Markdown lives with the Harness. */
export function getMemoryWorkspaceBridge(
  workspaceDir: string,
  filePath: string,
): MemoryBridge | undefined {
  const relativePath = path.relative(workspaceDir, filePath).replaceAll(path.sep, "/");
  if (
    relativePath.startsWith("memory/.dreams/session-corpus/") &&
    isShortTermSessionCorpusPath(relativePath)
  ) {
    return undefined;
  }
  const access = getAgentWorkspaceAccess(workspaceDir);
  if (!access) {
    return undefined;
  }
  if (!access.memoryBridge) {
    throw new Error("Workspace memory file access is unavailable");
  }
  const assertCurrent = () => {
    if (getAgentWorkspaceAccess(workspaceDir) !== access) {
      throw new Error("Workspace memory file access changed");
    }
  };
  return new Proxy(access.memoryBridge, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        return value;
      }
      return async (params: { filePath: string; cwd?: string }) => {
        assertCurrent();
        const { cwd, ...remoteParams } = params;
        const relative = path.relative(workspaceDir, path.resolve(workspaceDir, params.filePath));
        if (
          (cwd !== undefined && cwd !== workspaceDir) ||
          !relative ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          throw new Error("Memory file must stay inside the workspace");
        }
        const result: unknown = await Reflect.apply(value, target, [
          { ...remoteParams, filePath: relative.replaceAll(path.sep, "/") },
        ]);
        assertCurrent();
        return result;
      };
    },
  });
}

export async function readMemoryWorkspaceFile(
  workspaceDir: string,
  filePath: string,
): Promise<Buffer> {
  const bridge = getMemoryWorkspaceBridge(workspaceDir, filePath);
  if (!bridge) {
    return await fs.readFile(filePath);
  }
  const stat = await bridge.stat({ filePath, cwd: workspaceDir });
  if (!stat) {
    throw Object.assign(new Error("Memory source does not exist"), { code: "ENOENT" });
  }
  if (stat.type !== "file") {
    throw new Error("Memory source must be a regular file");
  }
  return await bridge.readFile({ filePath, cwd: workspaceDir, maxBytes: 8 * 1024 * 1024 });
}

export async function statMemoryWorkspaceFile(workspaceDir: string, filePath: string) {
  const bridge = getMemoryWorkspaceBridge(workspaceDir, filePath);
  if (bridge) {
    return await bridge.stat({ filePath, cwd: workspaceDir });
  }
  const stat = await fs.stat(filePath).catch((error: unknown) => {
    if (extractErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  });
  return stat
    ? {
        type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      }
    : null;
}

export async function listMemoryWorkspaceDirectory(workspaceDir: string, filePath: string) {
  const bridge = getMemoryWorkspaceBridge(workspaceDir, filePath);
  if (bridge) {
    if (!bridge.listDirectory) {
      throw new Error("Workspace memory directory listing is unavailable");
    }
    return (await bridge.listDirectory({ filePath, cwd: workspaceDir, maxEntries: 4096 })) ?? [];
  }
  const entries = await fs.readdir(filePath, { withFileTypes: true }).catch((error: unknown) => {
    if (extractErrorCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  });
  return entries.map((entry) => ({
    name: entry.name,
    type: entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other",
  }));
}
