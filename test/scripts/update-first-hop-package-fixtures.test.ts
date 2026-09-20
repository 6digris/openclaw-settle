import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FUTURE_FIXTURE_VERSION,
  LEGACY_UPDATE_COMPAT_CHUNKS,
  markFutureUpdateFixture,
  packFutureUpdateFixture,
  removeLegacyUpdateCompatChunks,
} from "../../scripts/e2e/lib/update-first-hop-package-fixtures.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makePackageFixture(options: { compatibilityChunks?: boolean } = {}) {
  const root = tempDirs.make("openclaw-first-hop-package-");
  writeJson(path.join(root, "package.json"), {
    name: "openclaw",
    version: "2026.8.1",
    dependencies: { "@openclaw/ai": "2026.8.1" },
  });
  writeJson(path.join(root, "dist", "build-info.json"), {
    version: "2026.8.1",
    commit: "a".repeat(40),
    builtAt: "2026-09-02T00:00:00.000Z",
    buildId: "old-build",
  });
  const compatibilityChunks = options.compatibilityChunks
    ? LEGACY_UPDATE_COMPAT_CHUNKS.map((name) => `dist/${name}`)
    : [];
  const inventory = ["dist/build-info.json", ...compatibilityChunks, "dist/index.js"];
  writeJson(path.join(root, "dist", "postinstall-inventory.json"), inventory);
  if (options.compatibilityChunks) {
    for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
      fs.writeFileSync(path.join(root, "dist", name), "export function resolveNodeRunner() {}\n");
    }
  }
  fs.writeFileSync(path.join(root, "dist", "index.js"), "export {};\n");
  return root;
}

describe("first-hop package fixtures", () => {
  it("removes only the declared legacy compatibility inputs", () => {
    const root = makePackageFixture({ compatibilityChunks: true });
    removeLegacyUpdateCompatChunks(root);

    const inventory = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "postinstall-inventory.json"), "utf8"),
    ) as string[];
    expect(inventory).toEqual(["dist/build-info.json", "dist/index.js"]);
    for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
      expect(fs.existsSync(path.join(root, "dist", name))).toBe(false);
    }
    expect(fs.readFileSync(path.join(root, "dist", "index.js"), "utf8")).toBe("export {};\n");
  });

  it("marks a distinct future package without requiring compatibility chunks", () => {
    const root = makePackageFixture();
    markFutureUpdateFixture(root);

    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const buildInfo = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8"),
    );
    expect(packageJson.version).toBe(FUTURE_FIXTURE_VERSION);
    expect(packageJson.dependencies).toEqual({ "@openclaw/ai": "2026.8.1" });
    expect(buildInfo.version).toBe(FUTURE_FIXTURE_VERSION);
    expect(buildInfo.buildId).toContain("future-fixture");
    const inventory = JSON.parse(
      fs.readFileSync(path.join(root, "dist", "postinstall-inventory.json"), "utf8"),
    ) as string[];
    expect(inventory).toEqual(["dist/build-info.json", "dist/index.js"]);
  });

  it("packs distinct self-update targets without changing the candidate artifact", () => {
    const root = tempDirs.make("openclaw-same-schema-fixtures-");
    fs.cpSync(makePackageFixture(), path.join(root, "package"), { recursive: true });
    const candidate = path.join(root, "candidate.tgz");
    execFileSync("tar", ["-czf", candidate, "-C", root, "package"]);
    const original = fs.readFileSync(candidate);
    const receipts = [0, 1].map((sequence) => {
      const output = path.join(root, `future-${sequence}.tgz`);
      const receipt = packFutureUpdateFixture(candidate, output, sequence);
      const pkg = JSON.parse(
        execFileSync("tar", ["-xOf", output, "package/package.json"], { encoding: "utf8" }),
      );
      expect(pkg.version).toBe(receipt.targetVersion);
      expect(pkg.dependencies).toEqual({ "@openclaw/ai": "2026.8.1" });
      expect(receipt.sourceVersion).toBe("2026.8.1");
      return receipt;
    });
    expect(receipts.map((receipt) => receipt.targetVersion)).toEqual([
      "2026.9.99-first-hop.0",
      "2026.9.99-first-hop.1",
    ]);
    expect(new Set(receipts.map((receipt) => receipt.targetSha256)).size).toBe(2);
    expect(fs.readFileSync(candidate)).toEqual(original);
    expect(() => packFutureUpdateFixture(candidate, candidate)).toThrow("new tarball path");
    expect(fs.readFileSync(candidate)).toEqual(original);
  });
});
