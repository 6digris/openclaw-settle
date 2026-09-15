// A retained updater must resolve Node without importing replacement-package dependencies.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { afterEach, expect, it } from "vitest";
import {
  readUpdateCompatibilityInventory,
  writeUpdateCompatibilityChunks,
} from "../../scripts/lib/update-compat-chunks.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import configs from "../../tsdown.config.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sourceDir = fileURLToPath(new URL("../../", import.meta.url));

it("loads the published updater's Node resolver without candidate runtime dependencies", async () => {
  const runtime = configs.find((config) => {
    const entry = config.entry;
    return (
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      "index" in entry &&
      entry.index === "src/index.ts"
    );
  });
  if (
    !runtime ||
    typeof runtime.entry !== "object" ||
    runtime.entry === null ||
    Array.isArray(runtime.entry)
  ) {
    throw new Error("Missing production runtime build config");
  }
  const fixture = tempDirs.make("openclaw-update-node-runner-");
  const distDir = path.join(fixture, "dist");
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ type: "module" }));
  const { bundles } = await build({
    ...runtime,
    config: false,
    cwd: sourceDir,
    entry: {
      "update-shared": "src/cli/update-cli/shared.ts",
      ...Object.fromEntries(
        Object.entries(runtime.entry).filter(([name]) => name === "update-node-runner"),
      ),
    },
    outDir: distDir,
    dts: false,
    sourcemap: false,
    logLevel: "silent",
  });
  try {
    const inventory = readUpdateCompatibilityInventory(
      path.join(sourceDir, "scripts/lib/update-compat-inventory.json"),
    );
    const releases = inventory.releases
      .map((release) => ({
        ...release,
        chunks: release.chunks.filter((chunk) =>
          chunk.exports.some(
            ({ origin }) =>
              origin.module === "src/cli/update-cli/shared.ts" &&
              origin.symbol === "resolveNodeRunner",
          ),
        ),
      }))
      .filter((release) => release.chunks.length > 0);
    expect(releases.length).toBeGreaterThan(0);
    writeUpdateCompatibilityChunks({
      sourceDir,
      distDir,
      inventory: { schemaVersion: 1, releases },
    });
    for (const release of releases) {
      for (const chunk of release.chunks) {
        const result = spawnSync(
          resolveTestNodeExecPath(),
          [
            "--input-type=module",
            "-e",
            `
import assert from "node:assert/strict";
import { isBuiltin, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
registerHooks({ resolve(specifier, context, next) {
  if (!isBuiltin(specifier) && !specifier.startsWith(".") && !specifier.startsWith("file:")) {
    throw new Error("Retained updater loaded a candidate dependency: " + specifier);
  }
  return next(specifier, context);
}});
const { resolveNodeRunner } = await import(pathToFileURL(process.argv[1]).href);
assert.equal(resolveNodeRunner(), process.execPath);
for (const [executable, expected] of [
  ["/runtime/node", "/runtime/node"],
  ["/runtime/NODE.exe", "/runtime/NODE.exe"],
  ["/runtime/bun", "node"],
  ["/runtime/node-shim", "node"],
]) {
  Object.defineProperty(process, "execPath", { value: executable, configurable: true });
  assert.equal(resolveNodeRunner(), expected);
}
`,
            path.join(distDir, chunk.path),
          ],
          { cwd: fixture, encoding: "utf8", timeout: 30_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      }
    }
  } finally {
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
  }
}, 120_000);
