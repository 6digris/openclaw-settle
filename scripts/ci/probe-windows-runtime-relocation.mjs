// Diagnostic only: tiny pinned-pnpm graph, not full candidate acceptance.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.platform !== "win32" || process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
  throw new Error("Disposable native Windows required");
}
const pin = JSON.parse(await fs.readFile("package.json", "utf8")).packageManager;
const root = path.join("C:\\ocu", `relocation-diagnostic-${randomUUID()}`);
const destination = path.join(process.env.RUNNER_TEMP, `relocation-diagnostic-${randomUUID()}`);
const source = path.join(root, "candidate");
const events = [];
function probe(directory) {
  const entry = pathToFileURL(path.join(directory, "node_modules", "execa", "index.js")).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `await import(${JSON.stringify(entry)}); console.log('execa-imported');`,
    ],
    { encoding: "utf8" },
  );
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}
// Mirrors the published2026.9.5 relocation's early return and directory type
// choice. The experiment isolates actual fs.cp/readlink/import behavior.
async function relocate(directory, original, finalRoot, forceDirectoryType = false) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const oldFile = path.join(original, entry.name);
    const finalFile = path.join(finalRoot, entry.name);
    if (entry.isDirectory()) {
      await relocate(file, oldFile, finalFile, forceDirectoryType);
    } else if (entry.isSymbolicLink()) {
      const link = await fs.readlink(file);
      const sourceTarget = path.resolve(path.dirname(oldFile), link);
      const relative = path.relative(source, sourceTarget);
      const owned =
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      const target = owned ? path.join(destination, relative) : sourceTarget;
      const replacement = path.isAbsolute(link)
        ? target
        : path.relative(path.dirname(finalFile), target);
      const directoryTarget = (await fs.stat(oldFile)).isDirectory();
      if (link.includes("yoctocolors")) {
        events.push({
          file,
          link,
          target,
          replacement,
          directoryTarget,
          same: replacement === link,
        });
      }
      if (replacement === link && !(forceDirectoryType && directoryTarget)) {
        continue;
      }
      await fs.unlink(file);
      await fs.symlink(
        directoryTarget ? target : replacement,
        file,
        directoryTarget ? "junction" : "file",
      );
    }
  }
}
try {
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(
    path.join(source, "package.json"),
    JSON.stringify({ private: true, packageManager: pin, dependencies: { execa: "10.0.1" } }),
  );
  const install = spawnSync(
    process.env.ComSpec,
    ["/d", "/s", "/c", `pnpm install --ignore-scripts --store-dir "${path.join(root, "store")}"`],
    { cwd: source, encoding: "utf8", timeout: 300000 },
  );
  if (install.status !== 0) {
    throw new Error(`Fixture install failed: ${install.stdout}\n${install.stderr}`);
  }
  const sourceImport = probe(source);
  if (sourceImport.status !== 0) {
    throw new Error(`Source import failed: ${sourceImport.stderr}`);
  }
  await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });
  await relocate(destination, source, destination);
  const heldSource = path.join(root, "held-source");
  await fs.rename(source, heldSource);
  let oldPromotion;
  try {
    oldPromotion = probe(destination);
  } finally {
    await fs.rename(heldSource, source);
  }
  // Rebind even unchanged relative directory links using the still-live source
  // type, then remove that source before requiring the copied graph again.
  await relocate(destination, source, destination, true);
  await fs.rm(source, { recursive: true, force: true });
  const repairedPromotion = probe(destination);
  console.log(
    JSON.stringify(
      {
        pin,
        node: process.version,
        sourceImport,
        oldPromotion,
        repairedPromotion,
        events,
        scope:
          "Actual pinned pnpm graph and native copy/import; diagnostic, not full updater acceptance",
      },
      null,
      2,
    ),
  );
  if (repairedPromotion.status !== 0) {
    throw new Error("Relinked graph failed after source removal");
  }
} finally {
  await fs.rm(destination, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
}
