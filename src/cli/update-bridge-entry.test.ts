import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const nodeSha256 = hash(fs.readFileSync(process.execPath));
const cleanEnv = () => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  LANG: "C",
});

function fixture() {
  const base = tempDirs.make("openclaw-update-bridge-");
  const bridge = path.join(base, "bridge");
  const target = path.join(base, "target");
  const state = path.join(base, "state");
  for (const dir of [
    bridge,
    target,
    state,
    path.join(bridge, "src/infra"),
    path.join(bridge, "src/cli/update-cli"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  for (const dir of [bridge, target]) {
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "dist/build-info.json"),
      JSON.stringify({ commit: dir === bridge ? "current" : "old" }),
    );
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "openclaw",
        type: "module",
        version: dir === bridge ? "current" : "old",
      }),
    );
  }
  const compile = (source: URL, out: string) => {
    fs.writeFileSync(
      out,
      ts.transpileModule(fs.readFileSync(source, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText,
    );
  };
  const entry = path.join(bridge, "src/cli/update-bridge-entry.js");
  const binding = path.join(bridge, "src/infra/update-bridge-binding.js");
  compile(new URL("./update-bridge-entry.ts", import.meta.url), entry);
  compile(new URL("../infra/update-bridge-binding.ts", import.meta.url), binding);
  // The synthetic updater is the effect oracle, not a product update. The
  // production entry must load this B module, never the A installation.
  fs.writeFileSync(
    path.join(bridge, "src/cli/update-cli/update-command.js"),
    `
    import fs from "node:fs";
    import {resolveBoundUpdateTarget, assertBoundUpdateSelectors} from "../../infra/update-bridge-binding.js";
    export async function updateCommand(opts) {
      const target = resolveBoundUpdateTarget(opts.bridge);
      assertBoundUpdateSelectors(opts.bridge, ${JSON.stringify({ configPath: path.join(state, "config.json"), statePath: path.join(state, "state.db") })});
      fs.writeFileSync(target + "/effect.json", JSON.stringify({driver: import.meta.url, target, dryRun: opts.dryRun}));
    }
  `,
  );
  fs.writeFileSync(
    path.join(target, "openclaw.mjs"),
    'throw new Error("old updater must never be imported");',
  );
  const st = fs.statSync(target, { bigint: true });
  const request = {
    target: {
      root: target,
      physicalRoot: fs.realpathSync(target),
      device: String(st.dev),
      inode: String(st.ino),
      packageSha256: hash(fs.readFileSync(path.join(target, "package.json"))),
      buildInfoSha256: hash(fs.readFileSync(path.join(target, "dist/build-info.json"))),
    },
    selectors: {
      configPath: path.join(state, "config.json"),
      statePath: path.join(state, "state.db"),
    },
  };
  const identity = path.join(base, "identity.json");
  fs.writeFileSync(identity, JSON.stringify(request));
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, child.name);
      if (child.isDirectory()) {
        walk(file);
      } else {
        files[path.relative(bridge, file).split(path.sep).join("/")] = hash(fs.readFileSync(file));
      }
    }
  };
  walk(bridge);
  const manifest = path.join(base, "manifest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      version: 1,
      root: bridge,
      sourceCommit: "a".repeat(40),
      dependencyLockSha256: "b".repeat(64),
      stage1ReceiptSha256: "c".repeat(64),
      nodeSha256,
      files,
    }),
  );
  const manifestHash = hash(fs.readFileSync(manifest));
  const args = [
    entry,
    "--target-install",
    target,
    "--expected-target-identity",
    identity,
    "--bridge-manifest",
    manifest,
    "--bridge-manifest-sha256",
    manifestHash,
    "--dry-run",
  ];
  const run = (env = cleanEnv()) => execFileSync(process.execPath, args, { env, encoding: "utf8" });
  const script = (body: string) =>
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import * as b from ${JSON.stringify(pathToFileURL(binding).href)};
    const request = ${JSON.stringify({ ...request, bridgeManifestPath: manifest, bridgeManifestSha256: manifestHash })};
    const context = b.admitUpdateBridgeBinding(request, ${JSON.stringify(pathToFileURL(entry).href)});
    ${body}
  `,
      ],
      { env: cleanEnv(), encoding: "utf8" },
    );
  return { base, bridge, target, state, entry, binding, manifest, args, request, run, script };
}

it("executes the current bridge module against the explicit old target without invoking its shim", () => {
  const f = fixture();
  f.run();
  const effect = JSON.parse(fs.readFileSync(path.join(f.target, "effect.json"), "utf8"));
  expect(effect.target).toBe(f.target);
  expect(effect.driver).toBe(
    pathToFileURL(path.join(f.bridge, "src/cli/update-cli/update-command.js")).href,
  );
  expect(effect.dryRun).toBe(true);
  expect(fs.existsSync(path.join(f.bridge, "effect.json"))).toBe(false);
});

it.each([
  "OPENCLAW_UPDATE_POST_CORE",
  "OPENCLAW_UPDATE_RUN_HANDOFF",
  "OPENCLAW_UPDATE_RUN_ID",
  "OPENCLAW_GATEWAY_SERVICE_PID",
  "OPENCLAW_LAUNCHD_LABEL",
])("refuses ambient %s before importing the updater", (marker) => {
  const f = fixture();
  expect(() => f.run({ ...cleanEnv(), [marker]: "1" })).toThrow();
  expect(fs.existsSync(path.join(f.target, "effect.json"))).toBe(false);
});

it("rejects copied, serialized and released contexts", () => {
  fixture().script(`
    for (const copy of [{...context}, JSON.parse(JSON.stringify(context)), {}]) {
      assert.throws(() => b.resolveBoundUpdateTarget(copy), /never admitted/);
    }
    b.releaseUpdateBridgeBinding(context);
    assert.throws(() => b.resolveBoundUpdateTarget(context), /expired/);
  `);
});

it("snapshots request identities instead of retaining caller-mutable objects", () => {
  fixture().script(`
    const root = b.resolveBoundUpdateTarget(context);
    request.target.root = "/tmp/not-the-target";
    request.selectors.configPath = "/tmp/not-the-config";
    assert.equal(b.resolveBoundUpdateTarget(context), root);
    assert.throws(() => b.assertBoundUpdateSelectors(context, request.selectors), /selection changed/);
  `);
});

it("refuses a replaced target before effects", () => {
  const f = fixture();
  f.script(`
    fs.renameSync(request.target.root, request.target.root + ".before");
    fs.mkdirSync(request.target.root);
    fs.copyFileSync(request.target.root + ".before/package.json", request.target.root + "/package.json");
    fs.mkdirSync(request.target.root + "/dist");
    fs.copyFileSync(request.target.root + ".before/dist/build-info.json", request.target.root + "/dist/build-info.json");
    assert.throws(() => b.resolveBoundUpdateTarget(context), /identity changed/);
  `);
  expect(fs.existsSync(path.join(f.target, "effect.json"))).toBe(false);
});

it("rejects changed bridge code, unlisted payloads and symlink escape", () => {
  for (const kind of ["changed", "unlisted", "link"]) {
    const f = fixture();
    if (kind === "changed") {
      fs.appendFileSync(path.join(f.bridge, "src/cli/update-cli/update-command.js"), "\n// drift");
    } else if (kind === "unlisted") {
      fs.writeFileSync(path.join(f.bridge, "extra.js"), "export {};");
    } else {
      fs.symlinkSync(f.target, path.join(f.bridge, "escape"));
    }
    expect(() => f.run()).toThrow();
    expect(fs.existsSync(path.join(f.target, "effect.json"))).toBe(false);
  }
});

it("refuses config/state selector retargeting after admission", () => {
  const f = fixture();
  f.script(`
    const selectors = request.selectors;
    fs.renameSync(${JSON.stringify(f.state)}, ${JSON.stringify(f.state + ".before")});
    fs.mkdirSync(selectors.configPath.slice(0, selectors.configPath.lastIndexOf("/")));
    assert.throws(() => b.assertBoundUpdateSelectors(context, selectors), /parent changed/);
  `);
});

it("refuses an unqualified Node executable before loading updater effects", () => {
  const f = fixture();
  const manifest = JSON.parse(fs.readFileSync(f.manifest, "utf8"));
  manifest.nodeSha256 = "0".repeat(64);
  fs.writeFileSync(f.manifest, JSON.stringify(manifest));
  f.args[f.args.indexOf("--bridge-manifest-sha256") + 1] = hash(fs.readFileSync(f.manifest));
  expect(() => f.run()).toThrow();
  expect(fs.existsSync(path.join(f.target, "effect.json"))).toBe(false);
});

it("rejects changed target build metadata before mutation", () => {
  fixture().script(`
    fs.writeFileSync(request.target.root + "/dist/build-info.json", '{"commit":"changed"}');
    assert.throws(() => b.resolveBoundUpdateTarget(context), /identity changed/);
  `);
});
