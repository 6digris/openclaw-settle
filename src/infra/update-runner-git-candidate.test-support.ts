import assert from "node:assert/strict";
import path from "node:path";
import { expect, vi } from "vitest";
import { resolveSystemNodeInfo } from "../daemon/runtime-paths.js";
import * as processExec from "../process/exec.js";
import { pathExists } from "../utils.js";
import { buildUpdateCommandRunner } from "./update-runner-command.js";
import { updateGitCheckout } from "./update-runner-git.js";

const { runCommandWithTimeout } = processExec;

export async function resolveCandidateNodeRuntimeForTest(): Promise<{
  path: string;
  version: string;
}> {
  if (!process.versions.bun) {
    return { path: process.execPath, version: process.versions.node };
  }
  const systemNode = await resolveSystemNodeInfo({});
  if (systemNode?.status !== "supported" || !systemNode.version) {
    throw new Error("This candidate runtime test requires a supported system Node");
  }
  return { path: systemNode.path, version: systemNode.version };
}

export async function expectCancelledGitCandidateCleanup({
  phase,
  fixture: { localRoot, baseSha, targetSha },
  pnpmVersion,
  runRealGit,
}: {
  phase: "build" | "locked worktree creation";
  fixture: { localRoot: string; baseSha: string; targetSha: string };
  pnpmVersion: string;
  runRealGit: (cwd: string, ...args: string[]) => Promise<string>;
}) {
  const controller = new AbortController();
  const stopped = new Error("preflight owner stopped");
  const beforeGitMutation = vi.fn(async () => {
    throw new Error("cancelled update reached mutation");
  });
  let buildResult: Awaited<ReturnType<typeof runCommandWithTimeout>> | undefined;
  let worktree: string | undefined;
  const commandSpy = vi
    .spyOn(processExec, "runCommandWithTimeout")
    .mockImplementation(async (argv, optionsOrTimeout) => {
      const options =
        typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : optionsOrTimeout;
      if (argv[0] !== "pnpm") {
        const result = await runCommandWithTimeout(argv, options);
        if (
          phase === "locked worktree creation" &&
          argv.includes("worktree") &&
          argv.includes("add")
        ) {
          worktree = argv.at(-2);
          assert.ok(worktree);
          // Git can retain this lock when creation is forcibly terminated during checkout.
          await runRealGit(worktree, "worktree", "lock", "--reason", "initializing", worktree);
          controller.abort(stopped);
        }
        if (argv.includes("worktree") && argv.includes("remove")) {
          assert.ok(options.cwd);
          expect(result.code).toBe(0);
          expect(await runRealGit(options.cwd, "worktree", "list", "--porcelain")).not.toContain(
            worktree,
          );
        }
        return result;
      }
      if (argv[1] === "build") {
        worktree = options.cwd;
        buildResult = await runCommandWithTimeout(
          [process.execPath, "-e", 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'],
          { ...options, onOutputChunk: () => controller.abort(stopped) },
        );
        return buildResult;
      }
      return {
        stdout: argv[1] === "--version" ? pnpmVersion : "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
        noOutputTimedOut: false,
      };
    });
  try {
    const commandRunner = await buildUpdateCommandRunner();
    const result = await updateGitCheckout({
      ...commandRunner,
      gitRoot: localRoot,
      timeoutMs: 5000,
      startedAt: Date.now(),
      runCommand: (argv, options) =>
        commandRunner.runCommand(argv, {
          ...options,
          signal: options.signal ?? controller.signal,
        }),
      opts: {
        devTarget: { mode: "tracked", upstreamRef: "origin/main", upstreamSha: targetSha },
        inspectGitTarget: async () => {},
        beforeGitMutation,
      },
    });
    expect(controller.signal.reason).toBe(stopped);
    expect(result.status).toBe("error");
    expect(beforeGitMutation).not.toHaveBeenCalled();
  } finally {
    commandSpy.mockRestore();
  }
  if (phase === "build") {
    expect(buildResult?.termination).toBe("signal");
  }
  assert.ok(worktree);
  expect(await pathExists(path.dirname(worktree))).toBe(false);
  expect(await runRealGit(localRoot, "worktree", "list", "--porcelain")).not.toContain(worktree);
  expect(await runRealGit(localRoot, "rev-parse", "HEAD")).toBe(baseSha);
}
