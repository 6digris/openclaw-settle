import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";

export async function ensureMemoryFlushTargetFile(params: {
  workspaceDir: string;
  relativePath: string;
}): Promise<void> {
  const workspaceDir = normalizeOptionalString(params.workspaceDir);
  const relativePath = normalizeOptionalString(params.relativePath);
  if (!workspaceDir || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Invalid memory flush target path");
  }
  const workspaceRoot = path.resolve(workspaceDir);
  const targetPath = path.resolve(workspaceRoot, relativePath);
  const targetRelativePath = path.relative(workspaceRoot, targetPath);
  if (
    !targetRelativePath ||
    targetRelativePath.startsWith("..") ||
    path.isAbsolute(targetRelativePath)
  ) {
    throw new Error("Memory flush target path must stay inside the workspace");
  }
  const access = getAgentWorkspaceAccess(workspaceRoot);
  if (access) {
    if (!access.bridge.createFileExclusive) {
      throw new Error("Remote workspace cannot create a memory flush target exclusively");
    }
    const created = await access.bridge.createFileExclusive({
      filePath: relativePath,
      data: "",
      mkdir: true,
    });
    if (getAgentWorkspaceAccess(workspaceRoot) !== access) {
      throw new Error("Workspace access changed during memory flush preparation");
    }
    if (created === "exists") {
      const stat = await access.bridge.stat({ filePath: relativePath });
      if (getAgentWorkspaceAccess(workspaceRoot) !== access) {
        throw new Error("Workspace access changed during memory flush preparation");
      }
      if (stat?.type !== "file") {
        throw new Error("Memory flush target is not a regular file");
      }
    }
    return;
  }
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
  const handle = await fs.promises.open(targetPath, "a");
  await handle.close();
}
