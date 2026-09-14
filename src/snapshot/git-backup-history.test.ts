import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatCliOperatorError } from "../cli/failure-output.js";
import { backupGitLogCommand } from "../commands/backup-git.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { requireGitCommand as requireGit } from "../infra/git-exec.js";
import { initializeGitBackupRepository, readGitBackupLog } from "./git-backup.js";

const mocks = vi.hoisted(() => ({
  logDiagnostic: undefined as { stdout: string; stderr: string } | undefined,
}));

vi.mock("../infra/git-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/git-exec.js")>();
  return {
    ...actual,
    executeGitCommand: async (
      ...args: Parameters<typeof actual.executeGitCommand>
    ): ReturnType<typeof actual.executeGitCommand> => {
      if (args[1][0] === "log" && mocks.logDiagnostic) {
        return {
          code: 1,
          ...mocks.logDiagnostic,
          signal: null,
          killed: false,
          termination: "exit",
          timeoutMs: args[2]?.timeoutMs ?? actual.GIT_TIMEOUT_MS,
        };
      }
      return await actual.executeGitCommand(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
async function tempRoot(): Promise<string> {
  return tempDirs.make("openclaw-git-backup-history-test-");
}

afterEach(() => {
  mocks.logDiagnostic = undefined;
  vi.restoreAllMocks();
});

describe("Git backup history", () => {
  it.skipIf(process.platform !== "win32")(
    "initializes and reads history when Windows Git emits MSYS paths",
    async () => {
      const root = await tempRoot();
      const stateDir = path.join(root, "state");
      const repositoryPath = path.join(root, "repository");
      await fs.mkdir(stateDir);

      await initializeGitBackupRepository({ repositoryPath, stateDir });
      await requireGit(repositoryPath, ["config", "user.name", "OpenClaw Backup Test"]);
      await requireGit(repositoryPath, ["config", "user.email", "backup@example.invalid"]);
      await fs.writeFile(path.join(repositoryPath, "README.md"), "backup\n");
      await requireGit(repositoryPath, ["add", "README.md"]);
      await requireGit(repositoryPath, ["commit", "-m", "backup history"]);

      await expect(readGitBackupLog({ repositoryPath, limit: 1 })).resolves.toEqual([
        expect.objectContaining({ message: "backup history" }),
      ]);
    },
  );

  it("returns an empty log without matching localized Git diagnostics", async () => {
    const root = await tempRoot();
    const repositoryPath = path.join(root, "empty-repository");
    await requireGit(root, ["init", repositoryPath]);
    mocks.logDiagnostic = {
      stdout: "",
      stderr: "fatal: el historial no contiene confirmaciones",
    };
    const runtime = createTestRuntime();

    await expect(
      backupGitLogCommand(runtime, { repository: repositoryPath, limit: 10 }),
    ).resolves.toEqual([]);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringMatching(/No Git backup commits in .*\/empty-repository\.$/u),
    );
  });

  it("returns bounded redacted diagnostics from both failed history streams", async () => {
    const root = await tempRoot();
    const repositoryPath = path.join(root, "failed-history-repository");
    const username = ["synthetic", "history", "user"].join("-");
    const password = ["synthetic", "history", "password"].join("-");
    const querySecret = ["synthetic", "history", "query"].join("-");
    const remote = `https://${username}:${password}@example.invalid/history?token=${querySecret}`;
    await requireGit(root, ["init", repositoryPath]);
    await requireGit(repositoryPath, [
      "-c",
      "user.name=OpenClaw Backup Test",
      "-c",
      "user.email=backup@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "openclaw backup fixture",
    ]);
    await requireGit(repositoryPath, ["checkout", "--detach", "HEAD"]);
    mocks.logDiagnostic = {
      stderr: [
        ...Array.from({ length: 20 }, (_, index) => `stderr-old-${index} '${remote}'`),
        `${"🦞".repeat(400)}x stderr-tail-🦞 fatal: unable to read '${remote}'`,
      ].join("\n"),
      stdout: [
        ...Array.from({ length: 20 }, (_, index) => `stdout-old-${index} '${remote}'`),
        `stdout-tail-🐚 retry with '${remote}'`,
      ].join("\n"),
    };

    const error = await backupGitLogCommand(createTestRuntime(), {
      repository: repositoryPath,
      limit: 10,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw new Error("expected failed Git history error");
    }
    const output = formatCliOperatorError(error, { argv: ["backup", "git", "log"], env: {} });

    expect(error.message.length).toBeLessThanOrEqual(1_200);
    expect(output).toContain("git log failed (code=1, termination=exit)");
    expect(output).toContain("stderr:");
    expect(output).toContain("stdout:");
    expect(output).toContain("stderr-tail-🦞");
    expect(output).toContain("stdout-tail-🐚");
    expect(output).toContain("https://***:***@example.invalid/history?token=***");
    expect(output).not.toContain(username);
    expect(output).not.toContain(password);
    expect(output).not.toContain(querySecret);
    expect(output).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    expect(output).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });

  it("rejects a truncated Git history record with bounded redacted diagnostics", async () => {
    const repositoryPath = await tempRoot();
    await requireGit(repositoryPath, ["init"]);
    const tree = await requireGit(repositoryPath, ["hash-object", "-w", "-t", "tree", "--stdin"], {
      input: "",
    });
    const secret = ["synthetic", "history", "password"].join("-");
    const remote = `https://synthetic:${secret}@example.invalid/history`;
    const commit = await requireGit(
      repositoryPath,
      [
        "-c",
        "user.name=OpenClaw Backup Test",
        "-c",
        "user.email=backup@example.invalid",
        "commit-tree",
        tree,
      ],
      { input: `openclaw backup ${"x".repeat(17 * 1024 * 1024)} ${remote}\n` },
    );
    await fs.writeFile(path.join(repositoryPath, ".git", "HEAD"), `${commit}\n`);

    const outcome = await readGitBackupLog({ repositoryPath, limit: 1 }).then(
      (entries) => ({
        kind: "returned",
        entries: entries.map((entry) => ({
          commitBytes: Buffer.byteLength(entry.commit),
          date: entry.date,
          messageBytes: Buffer.byteLength(entry.message),
        })),
      }),
      (error: unknown) => ({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    expect(outcome).toEqual({ kind: "error", message: expect.stringContaining("output-limit") });
    if ("message" in outcome) {
      expect(outcome.message.length).toBeLessThanOrEqual(1_200);
      expect(outcome.message).toContain("https://***:***@example.invalid/history");
      expect(outcome.message).not.toContain(secret);
    }
  });

  it("does not treat a symbolic HEAD with a missing object as an empty log", async () => {
    const root = await tempRoot();
    const repositoryPath = path.join(root, "broken-repository");
    await requireGit(root, ["init", repositoryPath]);
    const headRef = await requireGit(repositoryPath, ["symbolic-ref", "HEAD"]);
    const headRefPath = path.join(repositoryPath, ".git", ...headRef.split("/"));
    await fs.mkdir(path.dirname(headRefPath), { recursive: true });
    await fs.writeFile(headRefPath, `${"a".repeat(40)}\n`);

    await expect(readGitBackupLog({ repositoryPath, limit: 10 })).rejects.toThrow(/git show-ref/u);
  });

  it("does not treat a missing non-branch symbolic HEAD as an unborn branch", async () => {
    const root = await tempRoot();
    const repositoryPath = path.join(root, "missing-symbolic-ref-repository");
    await requireGit(root, ["init", repositoryPath]);
    await requireGit(repositoryPath, ["symbolic-ref", "HEAD", "refs/tags/missing"]);

    await expect(readGitBackupLog({ repositoryPath, limit: 10 })).rejects.toThrow(/git show-ref/u);
  });
});
