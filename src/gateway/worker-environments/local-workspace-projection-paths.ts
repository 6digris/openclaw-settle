import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/state-dir.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";

export async function projectionPath(owner: LocalWorkspaceOwner) {
  if (!/^[a-f0-9-]{36}$/u.test(owner.worktree.id)) {
    throw new Error("Invalid managed worktree identity");
  }
  const root = owner.worktreeRoot ?? resolveStateDir(owner.env);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return path.join(
    await fs.realpath(root),
    owner.worktreeRoot ? ".projections" : "worktree-projections",
    owner.worktree.id,
    "workspace",
  );
}

export async function assertOwnedDirectory(directory: string) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await fs.realpath(directory)) !== directory
  ) {
    throw new Error("Local sandbox workspace directory changed; preserved for recovery");
  }
}
