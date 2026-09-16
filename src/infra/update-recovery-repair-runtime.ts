import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fail = (): never => {
  throw new Error("Forward recovery repair runtime changed or cannot be bound.");
};
const physical = (stat: fs.BigIntStats) => [String(stat.dev), String(stat.ino)];
const identity = (stat: fs.BigIntStats) => [
  ...physical(stat),
  String(stat.mode),
  String(stat.size),
  String(stat.mtimeNs),
  String(stat.ctimeNs),
];

/** No imports or effects: pin both the open file and the path that selected it. */
function fileIdentity(file: string): { identity: string; sha256: string } {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile()) {
      return fail();
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      digest.update(buffer.subarray(0, count));
    }
    const bound = JSON.stringify(identity(before));
    if (
      JSON.stringify(identity(fs.fstatSync(fd, { bigint: true }))) !== bound ||
      JSON.stringify(identity(fs.lstatSync(file, { bigint: true }))) !== bound
    ) {
      return fail();
    }
    return { identity: bound, sha256: digest.digest("hex") };
  } finally {
    fs.closeSync(fd);
  }
}

/** Bind actual loaded modules and their whole runtime code tree, not package version alone.
 * Production calls supply import.meta.url, never a user-selected substitute entry.
 * The explicit executable argument is used only by isolated fixture callers.
 */
export function captureUpdateRecoveryRepairRuntime(
  repairRoot: string,
  actualModuleUrl: string,
  actualEntryUrl: string,
  executable: string = process.execPath,
) {
  const root = fs.realpathSync(repairRoot);
  const rootStat = fs.lstatSync(root, { bigint: true });
  if (!rootStat.isDirectory()) {
    return fail();
  }
  const rootIdentity = JSON.stringify([root, ...physical(rootStat)]);
  const module = fileURLToPath(actualModuleUrl);
  const entry = fileURLToPath(actualEntryUrl);
  const trees = new Set<string>();
  for (const file of [module, entry]) {
    const relative = path.relative(root, file);
    const tree = relative.split(path.sep)[0];
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.startsWith(".." + path.sep) ||
      fs.realpathSync(file) !== file ||
      (tree !== "dist" && tree !== "src")
    ) {
      return fail();
    }
    trees.add(tree);
  }
  // Source invocations have no emitted build-info; bind their complete src tree.
  // If dist appears/disappears or any root build metadata changes, the inventory changes.
  if (fs.existsSync(path.join(root, "dist"))) {
    trees.add("dist");
  }
  const files: Record<string, { identity: string; sha256: string }> = {};
  const directories: Record<string, string> = {};
  const links: Record<string, { identity: string; target: string; resolved: string }> = {};
  const walk = (directory: string): void => {
    const before = fs.lstatSync(directory, { bigint: true });
    if (!before.isDirectory()) {
      return fail();
    }
    const names = fs.readdirSync(directory).toSorted();
    for (const name of names) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file, { bigint: true });
      if (stat.isDirectory()) {
        walk(file);
      } else if (stat.isFile()) {
        files[path.relative(root, file)] = fileIdentity(file);
      } else if (stat.isSymbolicLink()) {
        // Source checkouts contain in-tree document aliases. Bind the link and
        // require its resolved target in a tree whose complete contents we hash.
        const resolved = fs.realpathSync(file);
        const relative = path.relative(root, resolved);
        const targetTree = relative.split(path.sep)[0];
        if (
          !relative ||
          path.isAbsolute(relative) ||
          relative.startsWith(".." + path.sep) ||
          !targetTree ||
          !trees.has(targetTree)
        ) {
          return fail();
        }
        links[path.relative(root, file)] = {
          identity: JSON.stringify(identity(stat)),
          target: fs.readlinkSync(file),
          resolved,
        };
      } else {
        return fail();
      }
    }
    if (
      JSON.stringify(identity(fs.lstatSync(directory, { bigint: true }))) !==
        JSON.stringify(identity(before)) ||
      JSON.stringify(fs.readdirSync(directory).toSorted()) !== JSON.stringify(names)
    ) {
      return fail();
    }
    directories[path.relative(root, directory)] = JSON.stringify(identity(before));
  };
  for (const tree of [...trees].toSorted()) {
    walk(path.join(root, tree));
  }
  files["package.json"] = fileIdentity(path.join(root, "package.json"));
  for (const relative of ["build-info.json", "openclaw.mjs"]) {
    if (fs.existsSync(path.join(root, relative))) {
      files[relative] = fileIdentity(path.join(root, relative));
    }
  }
  const emitted = [module, entry].some(
    (file) => path.relative(root, file).split(path.sep)[0] === "dist",
  );
  if (
    !files[path.relative(root, module)] ||
    !files[path.relative(root, entry)] ||
    (emitted && !files[path.join("dist", "build-info.json")])
  ) {
    return fail();
  }
  const node = fs.realpathSync(executable);
  const nodeFile = fileIdentity(node);
  // Detect a previously-read member being replaced while a later file was hashed.
  for (const [relative, captured] of Object.entries(files)) {
    if (
      JSON.stringify(identity(fs.lstatSync(path.join(root, relative), { bigint: true }))) !==
      captured.identity
    ) {
      return fail();
    }
  }
  for (const [relative, captured] of Object.entries(links)) {
    const file = path.join(root, relative);
    if (
      JSON.stringify(identity(fs.lstatSync(file, { bigint: true }))) !== captured.identity ||
      fs.readlinkSync(file) !== captured.target ||
      fs.realpathSync(file) !== captured.resolved
    ) {
      return fail();
    }
  }
  for (const [relative, captured] of Object.entries(directories)) {
    if (
      JSON.stringify(identity(fs.lstatSync(path.join(root, relative), { bigint: true }))) !==
      captured
    ) {
      return fail();
    }
  }
  if (
    fs.realpathSync(executable) !== node ||
    JSON.stringify(identity(fs.lstatSync(node, { bigint: true }))) !== nodeFile.identity ||
    fs.realpathSync(repairRoot) !== root ||
    JSON.stringify([root, ...physical(fs.lstatSync(root, { bigint: true }))]) !== rootIdentity
  ) {
    return fail();
  }
  return {
    root,
    packageSha256: files["package.json"].sha256,
    node,
    artifact: {
      rootIdentity,
      module,
      entry,
      inventorySha256: hash(JSON.stringify({ files, directories, links })),
      executableIdentity: nodeFile.identity,
      executableSha256: nodeFile.sha256,
    },
  };
}
