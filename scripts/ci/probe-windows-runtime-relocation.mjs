import { randomUUID } from "node:crypto";
// Diagnostic only: records native junction/copy behavior; not candidate acceptance.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

if (process.platform !== "win32") {
  throw new Error("Native Windows required");
}
const root = path.join("C:\\ocu", `relocation-diagnostic-${randomUUID()}`);
const destination = path.join(os.tmpdir(), `relocation-diagnostic-${randomUUID()}`);
const source = path.join(root, "candidate");
const dependency = path.join(source, "node_modules", ".pnpm", "leaf", "node_modules", "leaf");
const alias = path.join(source, "node_modules", ".pnpm", "parent", "node_modules", "leaf");
const normalize = (value) =>
  value.startsWith("\\\\?\\UNC\\")
    ? `\\\\${value.slice(8)}`
    : value.startsWith("\\\\?\\")
      ? value.slice(4)
      : value;
try {
  await fs.mkdir(dependency, { recursive: true });
  await fs.mkdir(path.dirname(alias), { recursive: true });
  await fs.writeFile(path.join(dependency, "index.js"), "module.exports = 42;");
  await fs.symlink(dependency, alias, "junction");
  await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });
  const copied = path.join(destination, path.relative(source, alias));
  const link = await fs.readlink(copied);
  const originalMath = path.join(
    destination,
    path.relative(source, path.resolve(path.dirname(alias), link)),
  );
  const normalizedMath = path.join(
    destination,
    path.relative(normalize(source), normalize(path.resolve(path.dirname(alias), link))),
  );
  console.log(
    JSON.stringify(
      {
        node: process.version,
        source,
        destination,
        sourceLink: await fs.readlink(alias),
        copiedLink: link,
        copiedIsSymlink: (await fs.lstat(copied)).isSymbolicLink(),
        originalMath,
        normalizedMath,
        sameMapping: originalMath === normalizedMath,
        scope: "Real native filesystem diagnostic; not candidate or published-driver acceptance",
      },
      null,
      2,
    ),
  );
} finally {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
}
