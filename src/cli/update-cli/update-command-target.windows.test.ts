import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { resolveNpmRunner } from "../../../scripts/npm-runner.mts";
import {
  swapStagedPackageInstall,
  type PackageUpdateTransaction,
} from "../../infra/package-update-swap.js";
import { resolveGlobalInstallTarget } from "../../infra/update-global.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import {
  buildWindowsCmdExeCommandLine,
  resolveTrustedWindowsCmdExe,
} from "../../process/windows-command.js";
import { withTempDir } from "../../test-utils/temp-dir.js";
import { resolveUpdateCommandTarget } from "./update-command-target.js";

vi.mock("./update-command-config.js", () => ({
  readUpdateChannelConfig: async () => ({ configSnapshot: { valid: true }, storedChannel: null }),
}));

describe.skipIf(process.platform !== "win32")("Windows npm dirty Git relocation", () => {
  it("keeps the invoked npm prefix through CMD and PowerShell with another prefix first on PATH", async () => {
    await withTempDir("openclaw npm relocation ", async (temp) => {
      const root = await fs.realpath(temp);
      const checkout = path.join(root, "operator checkout");
      const prefix = path.join(root, "invoked prefix");
      const otherPrefix = path.join(root, "PATH prefix");
      await fs.mkdir(checkout);
      await fs.writeFile(
        path.join(checkout, "package.json"),
        JSON.stringify({ name: "openclaw", version: "1.0.0", bin: { openclaw: "openclaw.mjs" } }),
      );
      await fs.writeFile(
        path.join(checkout, "openclaw.mjs"),
        "#!/usr/bin/env node\nimport { realpathSync } from 'node:fs';\nconsole.log(JSON.stringify({ argv1: process.argv[1], entry: realpathSync(process.argv[1]) }));\n",
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        npm_config_userconfig: path.join(root, "user.npmrc"),
        npm_config_globalconfig: path.join(root, "global.npmrc"),
        npm_config_cache: path.join(root, "npm cache"),
      };
      const run = (command: string, args: string[], windowsVerbatimArguments = false) => {
        const result = spawnSync(command, args, {
          cwd: checkout,
          env,
          encoding: "utf8",
          timeout: 30_000,
          windowsVerbatimArguments,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        return result.stdout;
      };
      run("git", ["init", "--quiet", "--template="]);
      run("git", [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgSign=false",
        "-c",
        `core.hooksPath=${path.join(root, "no-hooks")}`,
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "fixture",
      ]);
      const sha = run("git", ["rev-parse", "HEAD"]).trim();
      await fs.mkdir(path.join(checkout, "dist", "control-ui"), { recursive: true });
      for (const [name, contents] of [
        ["entry.js", "export {};"],
        ["control-ui/index.html", "ready"],
        ["build-info.json", JSON.stringify({ commit: sha, buildId: "original-build" })],
        [".buildstamp", JSON.stringify({ head: sha })],
        [".runtime-postbuildstamp", JSON.stringify({ head: sha })],
      ] as const) {
        await fs.writeFile(path.join(checkout, "dist", name), contents);
      }
      const install = (installPrefix: string, source: string) => {
        const npm = resolveNpmRunner({
          npmArgs: [
            "install",
            "--global",
            "--prefix",
            installPrefix,
            "--ignore-scripts",
            "--offline",
            "--no-audit",
            "--no-fund",
            source,
          ],
          env,
        });
        run(npm.command, npm.args, npm.windowsVerbatimArguments);
      };
      for (const installPrefix of [prefix, otherPrefix]) {
        install(installPrefix, checkout);
      }
      const packageRoot = path.join(prefix, "node_modules", "openclaw");
      expect((await fs.lstat(packageRoot)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(packageRoot)).toBe(checkout);
      const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
      env[pathKey] = `${otherPrefix}${path.delimiter}${env[pathKey] ?? ""}`;
      const originalArgv = process.argv;
      onTestFinished(() => {
        process.argv = originalArgv;
        vi.unstubAllEnvs();
      });
      vi.stubEnv("OPENCLAW_GIT_DIR", path.join(root, "fresh checkout"));
      vi.stubEnv(pathKey, env[pathKey]);
      const admit = async (sourceRoot = checkout) =>
        await resolveUpdateCommandTarget(
          { channel: "dev", yes: true },
          { triageTarget: { env: {} } },
          checkout,
          {
            startedAt: Date.now(),
            postCoreUpdateResume: false,
            postCoreUpdateChannel: undefined,
            timeoutMs: 30_000,
            shouldRestart: false,
            requestedChannel: "dev",
            devTarget: undefined,
            controlPlaneUpdateSentinelMeta: null,
            discoveredRoot: sourceRoot,
            installKind: "git",
            servicePlan: undefined,
          },
          {
            enter: async () => {
              throw new Error("Target admission must not start an update");
            },
          },
          30_000,
        );
      let admitted: Awaited<ReturnType<typeof resolveUpdateCommandTarget>>;
      const invoke = (shell: string) =>
        JSON.parse(
          shell === "cmd"
            ? run(
                resolveTrustedWindowsCmdExe(),
                [
                  "/d",
                  "/s",
                  "/c",
                  buildWindowsCmdExeCommandLine(path.join(prefix, "openclaw.cmd"), []),
                ],
                true,
              )
            : run("powershell.exe", [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                path.join(prefix, "openclaw.ps1"),
              ]),
        ) as { argv1: string; entry: string };
      for (const shell of ["cmd", "powershell"]) {
        const observed = invoke(shell);
        expect(observed.argv1).toBe(path.join(packageRoot, "openclaw.mjs"));
        process.argv = [process.execPath, observed.argv1];
        const target = await admit();
        admitted = target;
        expect(target?.gitRelocation?.installTarget.packageRoot, shell).toBe(packageRoot);
        await target?.gitRelocation?.assertCurrent();
        expect(await fs.realpath(packageRoot)).toBe(checkout);
      }
      const relocation = admitted?.gitRelocation;
      if (!relocation?.validateCandidate) {
        throw new Error("Windows relocation must validate the staged launcher family");
      }
      const nextCheckout = path.join(root, "new checkout");
      await fs.cp(checkout, nextCheckout, { recursive: true });
      const stagePrefix = path.join(root, "staged prefix");
      install(stagePrefix, nextCheckout);
      const stageRoot = path.join(stagePrefix, "node_modules", "openclaw");
      await expect(relocation.validateCandidate(stageRoot)).resolves.toEqual([]);
      const wrapper = path.join(prefix, "openclaw.ps1");
      const originalWrapper = await fs.readFile(wrapper);
      await fs.appendFile(wrapper, "\n# launcher changed while staging\n");
      await expect(relocation.assertCurrent()).rejects.toThrow("changed while preparing");
      await fs.writeFile(wrapper, originalWrapper);
      const stagedWrapper = path.join(stagePrefix, "openclaw.cmd");
      const generatedWrapper = await fs.readFile(stagedWrapper);
      await fs.appendFile(stagedWrapper, "\r\nrem custom command\r\n");
      await expect(relocation.validateCandidate(stageRoot)).rejects.toThrow("does not match");
      await expect(relocation.assertCurrent()).rejects.toThrow("changed while preparing");
      expect(await fs.realpath(packageRoot)).toBe(checkout);
      await fs.writeFile(stagedWrapper, generatedWrapper);
      await expect(relocation.validateCandidate(stageRoot)).resolves.toEqual([]);
      const stageTarget = await resolveGlobalInstallTarget({
        manager: "npm",
        pkgRoot: stageRoot,
        timeoutMs: 30_000,
        runCommand: runCommandWithTimeout,
      });
      let transaction: PackageUpdateTransaction | undefined;
      const result = await swapStagedPackageInstall({
        installTarget: relocation.installTarget,
        packageName: "openclaw",
        stage: {
          prefix: stagePrefix,
          packageRoot: stageRoot,
          installTarget: stageTarget,
          layout: { prefix: stagePrefix, globalRoot: path.dirname(stageRoot), binDir: stagePrefix },
        },
        beforeActivate: relocation.assertCurrent,
        onTransaction: (retained) => {
          transaction = retained;
        },
      });
      expect(result.status, result.step.stderrTail ?? undefined).toBe("committed");
      expect(await fs.realpath(packageRoot)).toBe(nextCheckout);
      for (const shell of ["cmd", "powershell"]) {
        expect(invoke(shell).entry).toBe(path.join(nextCheckout, "openclaw.mjs"));
      }
      expect(await fs.readFile(wrapper)).toEqual(originalWrapper);
      await expect(admit()).rejects.toThrow("recognized npm launcher");
      const repeat = await admit(nextCheckout);
      expect(repeat?.gitRelocation?.installTarget.packageRoot).toBe(packageRoot);
      if (!transaction) {
        throw new Error("Swap must retain rollback ownership");
      }
      const rollback = await transaction.rollback(() => {});
      expect(rollback.exitCode, rollback.stderrTail ?? undefined).toBe(0);
      expect(await fs.realpath(packageRoot)).toBe(checkout);
      expect(await fs.readFile(wrapper)).toEqual(originalWrapper);
      await transaction.complete({ activationVerified: false }, () => {});
      const restored = await admit();
      expect(restored?.gitRelocation?.installTarget.packageRoot).toBe(packageRoot);
      await expect(restored?.gitRelocation?.assertCurrent()).resolves.toBeUndefined();
      for (const shell of ["cmd", "powershell"]) {
        expect(invoke(shell).entry).toBe(path.join(checkout, "openclaw.mjs"));
      }
    });
  }, 120_000);
});
