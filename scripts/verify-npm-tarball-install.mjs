#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertDeclaredShrinkwrapDependencies } from "./lib/npm-shrinkwrap-dependencies.mjs";
import { resolveNpmRunner } from "./npm-runner.mjs";

export function verifyNpmTarballInstall(tarballPath) {
  const workingDir = mkdtempSync(path.join(tmpdir(), "openclaw-public-install-"));
  const prefix = path.join(workingDir, "prefix");
  // A release proof must not borrow local packages, registry shims, credentials,
  // or operator state. npm reads only the empty configs in this fresh home.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^(?:openclaw_|npm_|node_options$|node_path$|node_auth_token$)/iu.test(name),
    ),
  );
  Object.assign(env, {
    HOME: workingDir,
    USERPROFILE: workingDir,
    OPENCLAW_STATE_DIR: path.join(workingDir, "state"),
    OPENCLAW_CONFIG_PATH: path.join(workingDir, "state", "openclaw.json"),
    npm_config_registry: "https://registry.npmjs.org",
    npm_config_userconfig: path.join(workingDir, "user.npmrc"),
    npm_config_globalconfig: path.join(workingDir, "global.npmrc"),
  });
  const run = (invocation) => {
    const output = execFileSync(invocation.command, invocation.args, {
      cwd: workingDir,
      env: invocation.env ?? env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    console.log(output.trim());
  };
  try {
    writeFileSync(env.npm_config_userconfig, "");
    writeFileSync(env.npm_config_globalconfig, "");
    run(
      resolveNpmRunner({
        env,
        npmArgs: [
          "install",
          "-g",
          "--prefix",
          prefix,
          "--registry=https://registry.npmjs.org",
          "--no-audit",
          "--no-fund",
          path.resolve(tarballPath),
        ],
      }),
    );
    const packageRoot =
      process.platform === "win32"
        ? path.join(prefix, "node_modules", "openclaw")
        : path.join(prefix, "lib", "node_modules", "openclaw");
    assertDeclaredShrinkwrapDependencies(
      JSON.parse(readFileSync(path.join(packageRoot, "npm-shrinkwrap.json"), "utf8")),
      JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")),
    );
    for (const args of [["--version"], ["gateway", "status", "--no-probe"]]) {
      // Status exercises Gateway imports without probing a service owned by somebody else.
      run({ command: process.execPath, args: [path.join(packageRoot, "openclaw.mjs"), ...args] });
    }
    console.log("public npm tarball install: CLI and Gateway status passed");
  } finally {
    rmSync(workingDir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    if (process.argv.length !== 3) {
      throw new Error("Usage: node scripts/verify-npm-tarball-install.mjs <openclaw.tgz>");
    }
    verifyNpmTarballInstall(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
