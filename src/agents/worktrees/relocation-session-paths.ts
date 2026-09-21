import { createHash } from "node:crypto";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import type { SessionEntry } from "../../config/sessions/types.js";
import { isPathInside } from "../../infra/path-guards.js";
import type { WorktreeMovePlan, WorktreeSessionReference } from "./relocation.types.js";

export const relocationSessionDigest = (entry: SessionEntry) =>
  createHash("sha256").update(stableStringify(entry)).digest("hex");

export function originalSessionPaths(
  reference: Pick<WorktreeSessionReference, "sessionRoot" | "spawnedCwd" | "spawnedWorkspaceDir">,
) {
  return {
    sessionRoot: reference.sessionRoot,
    spawnedCwd: reference.spawnedCwd,
    spawnedWorkspaceDir: reference.spawnedWorkspaceDir,
  };
}

export function movedSessionPaths(plan: WorktreeMovePlan, reference: WorktreeSessionReference) {
  const mappings: Array<readonly [string, string]> = [[plan.record.path, plan.destination]];
  if (plan.projection) {
    mappings.push([plan.projection.source.path, plan.projection.destination]);
  }
  const relocate = (value: string | undefined) => {
    const mapping = value && mappings.find(([source]) => isPathInside(source, value));
    return value && mapping ? path.join(mapping[1], path.relative(mapping[0], value)) : value;
  };
  return {
    sessionRoot: relocate(reference.sessionRoot),
    spawnedCwd: relocate(reference.spawnedCwd),
    spawnedWorkspaceDir: relocate(reference.spawnedWorkspaceDir),
  };
}
