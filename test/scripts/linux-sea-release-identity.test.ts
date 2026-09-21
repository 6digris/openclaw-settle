import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { buildSea } from "../../apps/linux/scripts/build-sea-runtime.mjs";
import { digest } from "../../apps/linux/scripts/sea-runtime.cjs";
import { createNestedGitEnv } from "../helpers/temp-repo.js";

// Exercise packaging identity through buildSea, with only Node SEA compilation replaced
// by a tiny executable fixture. The native SEA/upgrade proof owns executable semantics.
describe.skipIf(process.platform !== "linux")("Linux SEA release identity", () => {
  let root: string;
  let source: string;
  let checkout: string;
  let sourceSha: string;
  let otherSha: string;
  const packageVersion = "2026.9.6";
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      env: {
        ...createNestedGitEnv(),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sea-identity-"));
    source = path.join(root, "prefix");
    checkout = path.join(root, "checkout");
    fs.mkdirSync(checkout);
    fs.mkdirSync(path.join(source, "bin"), { recursive: true });
    fs.mkdirSync(path.join(source, "lib/node_modules/openclaw"), { recursive: true });
    const packageJson = JSON.stringify({ version: packageVersion });
    fs.writeFileSync(path.join(source, "lib/node_modules/openclaw/package.json"), packageJson);
    fs.writeFileSync(path.join(checkout, "package.json"), packageJson);
    fs.writeFileSync(
      path.join(source, "bin/node"),
      `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "--version") console.log("v26.8.2");
else if (process.argv[2] === "--build-sea") {
  const config = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
  fs.writeFileSync(config.output, "fixture SEA bytes");
} else process.exit(1);
`,
      { mode: 0o755 },
    );
    git("init", "--quiet", "--initial-branch=main", "--template=");
    git("add", "package.json");
    git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base");
    sourceSha = git("rev-parse", "HEAD");
    git("tag", "v2026.9.6");
    git("tag", "v2026.9.6-1");
    git(
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "different source",
    );
    otherSha = git("rev-parse", "HEAD");
    git("tag", "v2026.9.6-2");
    git("checkout", "--quiet", "--detach", sourceSha);
  });
  afterAll(() => {
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function build(releaseTag: string, sha = sourceSha, sourceDirectory = checkout) {
    const output = fs.mkdtempSync(path.join(root, "bundle-"));
    const binary = path.join(output, "openclaw-runtime");
    buildSea(source, binary, { releaseTag, sourceSha: sha, sourceDirectory });
    return JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
  }

  test.each(["v2026.9.6", "v2026.9.6-1"])(
    "binds %s to unchanged package bytes and exact source",
    (releaseTag) => {
      assert.deepEqual(build(releaseTag), {
        version: releaseTag.slice(1),
        packageVersion,
        sourceSha,
        sha256: digest(Buffer.from("fixture SEA bytes")),
      });
      assert.equal(
        JSON.parse(
          fs.readFileSync(path.join(source, "lib/node_modules/openclaw/package.json"), "utf8"),
        ).version,
        packageVersion,
      );
    },
  );

  test("rejects a correction whose release tag names another source", () => {
    assert.throws(() => build("v2026.9.6-2"), /release tag.*source/i);
  });
  test("rejects a selected SHA that is not the packaging checkout", () => {
    assert.throws(() => build("v2026.9.6", otherSha), /source.*checkout/i);
  });
  test("rejects different-source reuse of a base-version package", () => {
    git("checkout", "--quiet", "--detach", otherSha);
    try {
      assert.throws(() => build("v2026.9.6-2", otherSha), /base release.*source/i);
    } finally {
      git("checkout", "--quiet", "--detach", sourceSha);
    }
  });
  test("rejects a package version that disagrees with the source checkout", () => {
    const file = path.join(source, "lib/node_modules/openclaw/package.json");
    fs.writeFileSync(file, JSON.stringify({ version: "2026.9.7" }));
    try {
      assert.throws(() => build("v2026.9.7"), /package.*source/i);
    } finally {
      fs.writeFileSync(file, JSON.stringify({ version: packageVersion }));
    }
  });
});
