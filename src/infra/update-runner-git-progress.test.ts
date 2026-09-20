import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { writeRuntime } from "./update-runner-git-candidate.test-support.js";
import { updateGitCheckout } from "./update-runner-git.js";
import type { CommandRunner } from "./update-runner-types.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each(["dev", "stable"] as const)(
  "reports runtime preparation before copying candidate files on %s",
  async (channel) => {
    const directory = await fs.realpath(dirs.make("update-git-progress-"));
    const remote = path.join(directory, "remote");
    const root = path.join(directory, "checkout");
    const git = async (cwd: string, ...args: string[]) => {
      const result = await runCommandWithTimeout(["git", "-C", cwd, ...args], {
        timeoutMs: 5000,
      });
      expect(result.code, `git ${args.join(" ")}: ${result.stderr}`).toBe(0);
      return result.stdout.trim();
    };
    await fs.mkdir(remote);
    await git(remote, "init", "--initial-branch=main");
    await git(remote, "config", "user.name", "OpenClaw Test");
    await git(remote, "config", "user.email", "openclaw@example.com");
    await fs.writeFile(
      path.join(remote, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.9.1", packageManager: "pnpm@12.0.0" }),
    );
    await fs.writeFile(path.join(remote, "openclaw.mjs"), "export {};\n");
    await fs.writeFile(path.join(remote, ".gitignore"), "node_modules/\ndist/\ndist-runtime/\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "base");
    await git(directory, "clone", "--quiet", remote, root);
    await git(root, "config", "user.name", "OpenClaw Test");
    await git(root, "config", "user.email", "openclaw@example.com");
    const store = path.join(directory, "store");
    await writeRuntime(root, await git(root, "rev-parse", "HEAD"), store, "node_modules/.pnpm");
    await fs.writeFile(path.join(remote, "candidate.txt"), "candidate\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "candidate");
    await git(remote, "tag", "v2026.9.2");
    let stopped = false;
    const progress: string[] = [];
    const copy = fs.cp.bind(fs);
    let runtimeCopies = 0;
    vi.spyOn(fs, "cp").mockImplementation(async (...args) => {
      if (String(args[1]).includes(".openclaw-update-")) {
        runtimeCopies++;
        expect(progress.at(-1)).toBe("start");
        expect(stopped).toBe(false);
      }
      return copy(...args);
    });
    const runCommand: CommandRunner = async (argv, options) => {
      if (argv[0] === "git") {
        return runCommandWithTimeout(argv, options);
      }
      if (argv[0] === "pnpm") {
        if (argv[1] === "build") {
          await writeRuntime(
            options.cwd!,
            await git(options.cwd!, "rev-parse", "HEAD"),
            store,
            "node_modules/.pnpm",
          );
        }
        return { code: 0, stdout: argv[1] === "--version" ? "12.0.0" : "", stderr: "" };
      }
      if (argv.includes("doctor")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error(`Unexpected command: ${argv.join(" ")}`);
    };
    const result = await updateGitCheckout({
      gitRoot: root,
      runCommand,
      defaultCommandEnv: undefined,
      timeoutMs: 5000,
      startedAt: Date.now(),
      opts: {
        channel,
        validateCandidate: async () => {},
        beforeGitMutation: async () => {
          stopped = true;
        },
        progress: {
          onStepStart: ({ name }) => {
            if (name === "prepare runtime") {
              progress.push("start");
            }
          },
          onStepComplete: ({ name }) => {
            if (name === "prepare runtime") {
              progress.push("complete");
            }
          },
        },
      },
    });
    expect(result.status, JSON.stringify(result)).toBe("ok");
    expect(runtimeCopies).toBeGreaterThan(0);
    expect(progress).toEqual(["start", "complete"]);
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: "prepare runtime",
        exitCode: 0,
        durationMs: expect.any(Number),
      }),
    );
  },
);
