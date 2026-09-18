import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateShrinkwrap,
  updateOrCheckPackage,
} from "../../scripts/generate-npm-shrinkwrap.mjs";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

const dirs: string[] = [];
const releaseVersion = JSON.parse(readFileSync("packages/ai/package.json", "utf8")).version;
const manifest = {
  name: "openclaw",
  version: releaseVersion,
  dependencies: { "@openclaw/ai": "workspace:*" },
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "shrinkwrap-workspace-test-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  return dir;
}

afterEach(() => {
  vi.resetAllMocks();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("workspace runtime shrinkwrap", () => {
  it("passes the published workspace version to npm and retains its registry entry", () => {
    vi.mocked(execFileSync).mockImplementation((_command, _args, options) => {
      const cwd = String(options?.cwd);
      const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
      const version = pkg.dependencies?.["@openclaw/ai"];
      const packages = {
        "": pkg,
        ...(version
          ? {
              "node_modules/@openclaw/ai": {
                version,
                resolved: `https://registry.npmjs.org/@openclaw/ai/-/ai-${version}.tgz`,
                integrity: "sha512-test",
              },
            }
          : {}),
      };
      writeFileSync(
        join(cwd, "npm-shrinkwrap.json"),
        JSON.stringify({ lockfileVersion: 3, packages }),
      );
      return Buffer.from("");
    });

    const generated = JSON.parse(generateShrinkwrap(fixture()));
    expect(generated.packages[""].dependencies).toEqual({ "@openclaw/ai": releaseVersion });
    expect(generated.packages["node_modules/@openclaw/ai"]).toEqual({
      version: releaseVersion,
      resolved: `https://registry.npmjs.org/@openclaw/ai/-/ai-${releaseVersion}.tgz`,
      integrity: "sha512-test",
    });
  });

  it.each(["root declaration", "package entry"])(
    "check rejects a missing %s before running npm",
    (missing) => {
      const dir = fixture();
      writeFileSync(
        join(dir, "npm-shrinkwrap.json"),
        JSON.stringify({
          packages: {
            "": {
              dependencies: missing === "root declaration" ? {} : { "@openclaw/ai": "2026.7.33" },
            },
            ...(missing === "package entry"
              ? {}
              : { "node_modules/@openclaw/ai": { version: "2026.7.33" } }),
          },
        }),
      );
      expect(() => updateOrCheckPackage(dir, true)).toThrow(
        "missing declared dependency @openclaw/ai",
      );
      expect(execFileSync).not.toHaveBeenCalled();
    },
  );
});
