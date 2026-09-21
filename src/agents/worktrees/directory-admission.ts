import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../../infra/errno.js";
import { isPathInside } from "../../infra/path-guards.js";

/** Admit each parent before creating its child; recursive mkdir can follow an unchecked alias. */
export async function admitWorktreeDirectoryPath(params: {
  root: string;
  parent: string;
  create?: boolean;
  assertDirectory: (directory: string) => Promise<void>;
}): Promise<void> {
  if (!isPathInside(params.root, params.parent)) {
    throw new Error("Workspace directory escaped its admitted root");
  }
  let current = params.root;
  const components = path.relative(params.root, params.parent).split(path.sep).filter(Boolean);
  for (let index = 0; ; index++) {
    try {
      await params.assertDirectory(current);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") || current === params.root) {
        throw error;
      }
      if (!params.create) {
        return;
      }
      await fs.mkdir(current, { mode: 0o700 });
      await params.assertDirectory(current);
    }
    if (index === components.length) {
      return;
    }
    current = path.join(current, components[index]!);
  }
}
