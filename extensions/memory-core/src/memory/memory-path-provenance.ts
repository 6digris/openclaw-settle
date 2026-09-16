// Memory Core plugin module classifies indexed workspace paths by provenance owner.
import fs from "node:fs/promises";
import path from "node:path";
import {
  getAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { isPathStrictlyInside } from "openclaw/plugin-sdk/file-access-runtime";
import type {
  MemoryEntryProvenance,
  MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { readMemoryArtifactProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

type MemoryPathClassification = {
  curatedRoot: boolean;
  originClass: MemoryEntryProvenance["originClass"];
};

export async function resolveMemoryPathClassification(params: {
  absolutePath: string;
  source: MemorySource;
  workspaceDir: string;
}): Promise<MemoryPathClassification> {
  if (params.source !== "memory") {
    return { curatedRoot: false, originClass: "untrusted" };
  }
  let workspacePath: string;
  let filePath: string;
  let access: AgentWorkspaceAccess | undefined;
  try {
    access = getAgentWorkspaceAccess(params.workspaceDir);
    if (access) {
      workspacePath = path.resolve(params.workspaceDir);
      filePath = path.resolve(params.absolutePath);
      if (!isPathStrictlyInside(workspacePath, filePath)) {
        return { curatedRoot: false, originClass: "untrusted" };
      }
      const stat = await access.bridge.stat({
        filePath: path.relative(workspacePath, filePath).replaceAll(path.sep, "/"),
      });
      if (stat?.type !== "file" || getAgentWorkspaceAccess(params.workspaceDir) !== access) {
        return { curatedRoot: false, originClass: "untrusted" };
      }
    } else {
      [workspacePath, filePath] = await Promise.all([
        fs.realpath(params.workspaceDir),
        fs.realpath(params.absolutePath),
      ]);
    }
  } catch {
    return { curatedRoot: false, originClass: "untrusted" };
  }
  if (!isPathStrictlyInside(workspacePath, filePath)) {
    return { curatedRoot: false, originClass: "untrusted" };
  }
  const relativePath = path.relative(workspacePath, filePath);
  const segments = relativePath.split(path.sep);
  const curatedRoot =
    segments.length === 1 &&
    (segments[0] === "MEMORY.md" || segments[0] === "memory.md" || segments[0] === "USER.md");
  if (
    (segments.length === 1 && (segments[0] === "DREAMS.md" || segments[0] === "dreams.md")) ||
    (segments[0] === "memory" && (segments[1] === "dreaming" || segments[1] === ".dreams"))
  ) {
    return { curatedRoot, originClass: "system" };
  }
  const isWorkspaceMemory =
    curatedRoot || (segments[0] === "memory" && segments.at(-1)?.endsWith(".md") === true);
  const normalizedRelativePath = relativePath.replaceAll(path.sep, "/");
  const recorded = isWorkspaceMemory
    ? await readMemoryArtifactProvenance({
        workspaceDir: params.workspaceDir,
        relativePath: normalizedRelativePath,
      })
    : undefined;
  if (access) {
    try {
      if (getAgentWorkspaceAccess(params.workspaceDir) !== access) {
        return { curatedRoot: false, originClass: "untrusted" };
      }
    } catch {
      return { curatedRoot: false, originClass: "untrusted" };
    }
  }
  if (recorded) {
    return { curatedRoot, originClass: recorded.originClass };
  }
  // Workspace memory Markdown is owner-controlled. Flush-recorded provenance
  // still downgrades machine-written untrusted material during ingestion; the
  // index default must not fail closed the entire workspace.
  return { curatedRoot, originClass: isWorkspaceMemory ? "agent" : "untrusted" };
}
