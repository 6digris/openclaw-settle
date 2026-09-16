import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureUpdateRecoveryRepairRuntime } from "./update-recovery-repair-runtime.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const root = dirs.make("repair-runtime-source-");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"source"}');
  const module = path.join(root, "src/forward.js");
  const entry = path.join(root, "src/doctor.js");
  const node = path.join(root, "node-fixture");
  fs.writeFileSync(module, "export {}; ");
  fs.writeFileSync(entry, "export {}; ");
  fs.writeFileSync(node, "unexecuted private Node identity bytes");
  return { root, module, entry, node };
}

it("binds an unchanged actual source tree without inventing emitted build metadata", () => {
  const f = fixture();
  const read = () =>
    captureUpdateRecoveryRepairRuntime(
      f.root,
      pathToFileURL(f.module).href,
      pathToFileURL(f.entry).href,
      f.node,
    );
  const before = read();
  expect(read()).toEqual(before);
  fs.appendFileSync(f.module, "// changed source");
  expect(read().artifact.inventorySha256).not.toBe(before.artifact.inventorySha256);
});

it("refuses a loaded entry outside the repairing root", () => {
  const f = fixture();
  expect(() =>
    captureUpdateRecoveryRepairRuntime(
      f.root,
      pathToFileURL(f.module).href,
      import.meta.url,
      f.node,
    ),
  ).toThrow(/runtime/);
});

it("refuses a symlinked runtime module even when it resolves to in-root bytes", () => {
  const f = fixture();
  const link = path.join(f.root, "src/linked.js");
  fs.symlinkSync(f.module, link);
  expect(() =>
    captureUpdateRecoveryRepairRuntime(
      f.root,
      pathToFileURL(link).href,
      pathToFileURL(f.entry).href,
      f.node,
    ),
  ).toThrow(/runtime/);
});

it("binds in-tree aliases and target edits while rejecting aliases outside the inventoried trees", () => {
  const f = fixture();
  const target = path.join(f.root, "src/AGENTS.md");
  const alias = path.join(f.root, "src/CLAUDE.md");
  fs.writeFileSync(target, "retained source instructions");
  fs.symlinkSync("AGENTS.md", alias);
  const read = () =>
    captureUpdateRecoveryRepairRuntime(
      f.root,
      pathToFileURL(f.module).href,
      pathToFileURL(f.entry).href,
      f.node,
    );
  const initial = read();
  expect(read()).toEqual(initial);
  fs.appendFileSync(target, " changed");
  const changedTarget = read();
  expect(changedTarget.artifact.inventorySha256).not.toBe(initial.artifact.inventorySha256);
  fs.unlinkSync(alias);
  fs.symlinkSync("doctor.js", alias);
  expect(read().artifact.inventorySha256).not.toBe(changedTarget.artifact.inventorySha256);
  fs.unlinkSync(alias);
  fs.symlinkSync("../node-fixture", alias);
  expect(read).toThrow(/runtime/);
});
