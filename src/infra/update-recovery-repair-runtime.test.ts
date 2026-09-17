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

it("binds an unchanged actual source tree without inventing emitted build metadata", async () => {
  const f = fixture();
  const read = () =>
    captureUpdateRecoveryRepairRuntime(
      f.root,
      pathToFileURL(f.module).href,
      pathToFileURL(f.entry).href,
      f.node,
    );
  const before = await read();
  expect((await read()).runtime).toEqual(before.runtime);
  expect(before.assertCurrent).not.toThrow();
  fs.appendFileSync(f.module, "// changed source");
  expect(before.assertCurrent).toThrow(/runtime/);
  expect((await read()).runtime.artifact.inventorySha256).not.toBe(
    before.runtime.artifact.inventorySha256,
  );
});

it("refuses a loaded entry outside the repairing root", async () => {
  const f = fixture();
  await expect(
    captureUpdateRecoveryRepairRuntime(
      f.root,
      pathToFileURL(f.module).href,
      import.meta.url,
      f.node,
    ),
  ).rejects.toThrow(/runtime/);
});

it("refuses a symlinked runtime module even when it resolves to in-root bytes", async () => {
  const f = fixture();
  const link = path.join(f.root, "src/linked.js");
  fs.symlinkSync(f.module, link);
  await expect(
    captureUpdateRecoveryRepairRuntime(
      f.root,
      pathToFileURL(link).href,
      pathToFileURL(f.entry).href,
      f.node,
    ),
  ).rejects.toThrow(/runtime/);
});

it("binds in-tree aliases and target edits while rejecting aliases outside the inventoried trees", async () => {
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
  const initial = await read();
  expect((await read()).runtime).toEqual(initial.runtime);
  fs.appendFileSync(target, " changed");
  const changedTarget = await read();
  expect(changedTarget.runtime.artifact.inventorySha256).not.toBe(
    initial.runtime.artifact.inventorySha256,
  );
  fs.unlinkSync(alias);
  fs.symlinkSync("doctor.js", alias);
  expect((await read()).runtime.artifact.inventorySha256).not.toBe(
    changedTarget.runtime.artifact.inventorySha256,
  );
  fs.unlinkSync(alias);
  fs.symlinkSync("../node-fixture", alias);
  await expect(read()).rejects.toThrow(/runtime/);
});

it("binds emitted plugin dependency links, self-cycles, and transitive code changes", async () => {
  const f = fixture();
  const dist = path.join(f.root, "dist");
  const modules = path.join(dist, "extensions", "fixture", "node_modules");
  fs.mkdirSync(modules, { recursive: true });
  const dependency = dirs.make("repair-runtime-dependency-");
  fs.mkdirSync(path.join(dependency, "node_modules"));
  fs.writeFileSync(path.join(dependency, "package.json"), '{"name":"fixture"}');
  const code = path.join(dependency, "index.js");
  fs.writeFileSync(code, "export {}; ");
  fs.symlinkSync(dependency, path.join(modules, "fixture"), "junction");
  fs.symlinkSync(dependency, path.join(dependency, "node_modules", "fixture"), "junction");
  fs.symlinkSync(f.root, path.join(modules, "openclaw"), "junction");
  const read = () =>
    captureUpdateRecoveryRepairRuntime(
      f.root,
      pathToFileURL(f.module).href,
      pathToFileURL(f.entry).href,
      f.node,
    );
  const before = await read();
  expect((await read()).runtime).toEqual(before.runtime);
  expect(before.assertCurrent).not.toThrow();
  fs.appendFileSync(code, "// dependency changed");
  expect(before.assertCurrent).toThrow(/runtime/);
  expect((await read()).runtime.artifact.inventorySha256).not.toBe(
    before.runtime.artifact.inventorySha256,
  );
  fs.unlinkSync(path.join(modules, "fixture"));
  expect((await read()).runtime.artifact.inventorySha256).not.toBe(
    before.runtime.artifact.inventorySha256,
  );
});

it.each(["dist", "build-info.json", "openclaw.mjs"])(
  "refuses a previously absent %s selector appearing before publication",
  async (selector) => {
    const f = fixture();
    const captured = await captureUpdateRecoveryRepairRuntime(
      f.root,
      pathToFileURL(f.module).href,
      pathToFileURL(f.entry).href,
      f.node,
    );
    expect(captured.assertCurrent).not.toThrow();
    if (selector === "dist") {
      fs.mkdirSync(path.join(f.root, selector));
    } else {
      fs.writeFileSync(path.join(f.root, selector), "new generation");
    }
    expect(captured.assertCurrent).toThrow(/runtime/);
  },
);
