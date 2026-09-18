import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyNpmTarballInstall } from "../../scripts/verify-npm-tarball-install.mjs";

it.each(["missing dependency", "Gateway failure", "healthy"])(
  "checks a public install with %s",
  (scenario) => {
    const dir = mkdtempSync(join(tmpdir(), "tarball-install-test-"));
    try {
      const packageDir = join(dir, "package");
      mkdirSync(packageDir);
      writeFileSync(
        join(packageDir, "package.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.7.33",
          type: "module",
          dependencies: scenario === "missing dependency" ? { "@openclaw/ai": "2026.7.33" } : {},
        }),
      );
      writeFileSync(
        join(packageDir, "npm-shrinkwrap.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.7.33",
          lockfileVersion: 3,
          packages: { "": { name: "openclaw", version: "2026.7.33", dependencies: {} } },
        }),
      );
      writeFileSync(
        join(packageDir, "openclaw.mjs"),
        scenario === "Gateway failure"
          ? "if (process.argv[2] === 'gateway') throw new Error('Gateway smoke failure');\n"
          : "console.log('2026.7.33');\n",
      );
      const tarball = join(dir, "openclaw.tgz");
      execFileSync("tar", ["-czf", tarball, "-C", dir, "package"]);
      if (scenario === "healthy") {
        expect(() => verifyNpmTarballInstall(tarball)).not.toThrow();
      } else {
        const message =
          scenario === "missing dependency"
            ? "missing declared dependency @openclaw/ai"
            : "Gateway smoke failure";
        expect(() => verifyNpmTarballInstall(tarball)).toThrow(message);
      }
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  },
  30_000,
);
