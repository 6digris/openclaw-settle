import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { gitNullConfigPath, requireGitCommand as requireGit } from "../infra/git-exec.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { dumpGitBackupDatabase } from "./git-backup-codec.js";
import { createGitBackup, initializeGitBackupRepository } from "./git-backup.js";

const fault = vi.hoisted(() => ({
  repository: "",
  mode: "" as "" | "committed" | "unknown",
  writes: 0,
  privateNullPath: undefined as string | undefined,
  privateEnvironment: undefined as NodeJS.ProcessEnv | undefined,
  privatePath: "",
  privateInit: new Error("stop before private Git initialization"),
  first: new Error("lost publication completion"),
  second: new Error("reconciliation read failed"),
}));
vi.mock("../infra/git-exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/git-exec.js")>();
  return {
    ...actual,
    gitNullConfigPath: () => fault.privateNullPath ?? actual.gitNullConfigPath(),
    requireGitCommand: async (...args: Parameters<typeof actual.requireGitCommand>) => {
      if (fault.privateNullPath && args[0] !== fault.repository && args[1].includes("init")) {
        fault.privatePath = args[0];
        fault.privateEnvironment = args[2]?.env;
        throw fault.privateInit;
      }
      const result = await actual.requireGitCommand(...args);
      if (args[0] === fault.repository && args[1][0] === "update-ref") {
        fault.writes++;
        if (fault.mode) {
          throw fault.first;
        }
      }
      return result;
    },
    executeGitCommand: async (...args: Parameters<typeof actual.executeGitCommand>) => {
      if (
        args[0] === fault.repository &&
        args[1][0] === "show-ref" &&
        args[1].includes("--hash") &&
        fault.mode === "unknown"
      ) {
        throw fault.second;
      }
      return await actual.executeGitCommand(...args);
    },
  };
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  fault.repository = "";
  fault.mode = "";
  fault.writes = 0;
  fault.privateNullPath = undefined;
  fault.privateEnvironment = undefined;
  fault.privatePath = "";
});
async function fixture() {
  const root = await fs.realpath(tempDirs.make("git-backup-transaction-"));
  const repositoryPath = path.join(root, "repository");
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir);
  const source = path.join(stateDir, "source.sqlite");
  const db = openOpenClawStateDatabase({ path: source }).db;
  db.exec("CREATE TABLE transaction_fixture (value TEXT)");
  db.exec("INSERT INTO transaction_fixture VALUES ('old-generation')");
  closeOpenClawStateDatabaseForTest();
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_CONFIG: undefined,
    GIT_CONFIG_COUNT: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
    SSH_AUTH_SOCK: undefined,
  };
  const database = { path: source, identity: { role: "global" as const } };
  const params: Parameters<typeof createGitBackup>[0] = {
    repositoryPath,
    stateDir,
    databases: [database],
    gitEnv: env,
  };
  await initializeGitBackupRepository(params);
  const git = async (...args: string[]) => await requireGit(repositoryPath, args, { env });
  await git("symbolic-ref", "HEAD", "refs/heads/fixture");
  await dumpGitBackupDatabase({
    snapshotPath: source,
    outputPath: path.join(repositoryPath, "global"),
    identity: database.identity,
  });
  await git("add", "global");
  await git("-c", "commit.gpgsign=false", "commit", "-m", "openclaw backup seed");
  const initial = await git("rev-parse", "HEAD");
  const index = await fs.readFile(path.join(repositoryPath, ".git", "index"));
  const changed = openOpenClawStateDatabase({ path: source }).db;
  changed.exec("UPDATE transaction_fixture SET value = 'new-generation'");
  closeOpenClawStateDatabaseForTest();
  fault.repository = repositoryPath;
  const hook = async (name: string, body: string) =>
    await fs.writeFile(
      path.join(repositoryPath, ".git", "hooks", name),
      "#!/bin/sh\n" + body + "\n",
      { mode: 0o700 },
    );
  return {
    root,
    params,
    env,
    git,
    initial,
    index,
    hook,
    repositoryPath,
    stateDir,
    database,
    backup: async () => await createGitBackup(params),
  };
}
it("uses Git-compatible null config paths before private initialization", async () => {
  const x = await fixture();
  const config = await fs.readFile(path.join(x.repositoryPath, ".git", "config"));
  // Simulate the helper's Windows return value without executing Git for Windows.
  // Stop before that value is passed to native Git on the current host.
  fault.privateNullPath = "NUL";
  await expect(x.backup()).rejects.toBe(fault.privateInit);
  expect(fault.privateEnvironment).toMatchObject({
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "NUL",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_CONFIG_COUNT: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
  });
  expect(fault.writes).toBe(0);
  expect(await x.git("rev-parse", "HEAD")).toBe(x.initial);
  expect(await fs.readFile(path.join(x.repositoryPath, ".git", "index"))).toEqual(x.index);
  expect(await fs.readFile(path.join(x.repositoryPath, ".git", "config"))).toEqual(config);
  await expect(fs.stat(fault.privatePath)).rejects.toMatchObject({ code: "ENOENT" });
});
it.skipIf(process.platform === "win32")(
  "disables automatic shared-object maintenance at command precedence",
  async () => {
    const x = await fixture();
    const capture = path.join(x.root, "effective-maintenance");
    Object.assign(x.env, {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "gc.auto",
      GIT_CONFIG_VALUE_0: "1",
      GIT_CONFIG_KEY_1: "gc.autoPackLimit",
      GIT_CONFIG_VALUE_1: "1",
      GIT_CONFIG_KEY_2: "maintenance.auto",
      GIT_CONFIG_VALUE_2: "true",
      OPENCLAW_TRANSACTION_CAPTURE: capture,
    });
    // Reject before automatic maintenance: observe effective config, never run pruning in a test.
    await x.hook(
      "pre-commit",
      '{ git config --get gc.auto; git config --get gc.autoPackLimit; git config --get maintenance.auto; } > "$OPENCLAW_TRANSACTION_CAPTURE"\nexit 1',
    );
    await expect(x.backup()).rejects.toThrow();
    expect(await fs.readFile(capture, "utf8")).toBe("0\n0\nfalse\n");
    expect(await x.git("rev-parse", "HEAD")).toBe(x.initial);
  },
);
it("publishes without overwriting owned staged or unstaged bytes", async () => {
  const x = await fixture();
  const live = path.join(x.repositoryPath, "global", "tables", "transaction_fixture.jsonl");
  await fs.writeFile(live, '{"value":"operator-staged"}\n');
  await x.git("add", "global");
  await fs.writeFile(live, '{"value":"operator-unstaged"}\n');
  const beforeIndex = await fs.readFile(path.join(x.repositoryPath, ".git", "index"));
  const result = await x.backup();
  expect(await fs.readFile(path.join(x.repositoryPath, ".git", "index"))).toEqual(beforeIndex);
  expect(await fs.readFile(live, "utf8")).toBe('{"value":"operator-unstaged"}\n');
  expect(result.worktreeUpdated).toBe(false);
  expect(await x.git("show", "HEAD:global/tables/transaction_fixture.jsonl")).toContain(
    "new-generation",
  );
  expect(await x.git("show", "-s", "--format=%P", "HEAD")).toBe(x.initial);
});
it("refuses redirected config without modifying either config", async () => {
  const x = await fixture();
  const redirect = path.join(x.root, "operator-config");
  await fs.writeFile(redirect, "[user]\n name = Operator\n email = fixture@example.invalid\n");
  const before = await fs.readFile(redirect);
  const config = path.join(x.repositoryPath, ".git", "config");
  const local = await fs.readFile(config);
  x.env.GIT_CONFIG = redirect;
  await expect(x.backup()).rejects.toThrow(/refuses redirected config/u);
  expect(await fs.readFile(redirect)).toEqual(before);
  expect(await fs.readFile(config)).toEqual(local);
});
it.each(["gitdir", "onbranch"])(
  "refuses %s conditional signing rather than committing unsigned",
  async (condition) => {
    const x = await fixture();
    const include = path.join(x.root, "signing-config");
    await fs.writeFile(
      include,
      "[commit]\n gpgSign = true\n[gpg]\n program = /fixture-no-signer\n",
    );
    await x.git(
      "config",
      condition === "gitdir"
        ? "includeIf.gitdir:" + x.repositoryPath + "/.git.path"
        : "includeIf.onbranch:fixture.path",
      include,
    );
    expect(await x.git("config", "--bool", "commit.gpgsign")).toBe("true");
    await expect(x.backup()).rejects.toThrow(/cannot preserve conditional/u);
    expect(await x.git("rev-parse", "HEAD")).toBe(x.initial);
  },
);
it.skipIf(process.platform === "win32")(
  "preserves config precedence and verifies required SSH signing",
  async () => {
    const x = await fixture();
    const key = path.join(x.root, "signing-key"),
      allowed = path.join(x.root, "allowed-signers");
    await promisify(execFile)("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    await fs.writeFile(
      allowed,
      "fixture@example.invalid " + (await fs.readFile(key + ".pub", "utf8")),
    );
    const global = path.join(x.root, "global-config");
    await fs.writeFile(global, "[user]\n name = Global\n email = global@example.invalid\n");
    x.env.GIT_CONFIG_GLOBAL = global;
    await x.git("config", "user.name", "Local");
    await x.git("config", "user.email", "local@example.invalid");
    Object.assign(x.env, {
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Command",
      GIT_CONFIG_KEY_1: "user.email",
      GIT_CONFIG_VALUE_1: "fixture@example.invalid",
    });
    await x.git("config", "gpg.format", "ssh");
    await x.git("config", "user.signingkey", key);
    await x.git("config", "gpg.ssh.allowedSignersFile", allowed);
    await x.git("config", "commit.gpgsign", "true");
    const result = await x.backup();
    assert.ok(result.commit);
    expect(await x.git("show", "-s", "--format=%an <%ae>", result.commit)).toBe(
      "Command <fixture@example.invalid>",
    );
    await x.git("verify-commit", result.commit);
  },
);
it.skipIf(process.platform === "win32")(
  "refuses same-tree hook replacement with the wrong prepared parent",
  async () => {
    const x = await fixture();
    await x.hook(
      "post-commit",
      'root=$(git -c commit.gpgsign=false commit-tree "$(git write-tree)" -m wrong-parent)\ngit update-ref HEAD "$root"',
    );
    await expect(x.backup()).rejects.toThrow(/prepared ancestry changed/u);
    expect(await x.git("rev-parse", "HEAD")).toBe(x.initial);
  },
);
it.each(["committed", "unknown"] as const)(
  "reconciles lost completion as %s without losing the first failure",
  async (mode) => {
    const x = await fixture();
    fault.mode = mode;
    await expect(x.backup()).rejects.toMatchObject({
      publication: mode,
      cause: fault.first,
      previousCommit: x.initial,
      ref: "refs/heads/fixture",
      preparedCommit: expect.stringMatching(/^[a-f0-9]{40}$/u),
      ...(mode === "unknown" ? { reconciliationError: fault.second } : {}),
    });
    expect(fault.writes).toBe(1);
    expect(await fs.readFile(path.join(x.repositoryPath, ".git", "index"))).toEqual(x.index);
    expect(await x.git("show", "HEAD:global/tables/transaction_fixture.jsonl")).toContain(
      "new-generation",
    );
  },
);
it.skipIf(process.platform === "win32")(
  "distinguishes a rejected publication from a successful native write",
  async () => {
    const x = await fixture();
    x.env.OPENCLAW_TRANSACTION_LIVE = x.repositoryPath;
    await x.hook(
      "reference-transaction",
      'if [ "$1" = prepared ] && [ "$(git rev-parse --show-toplevel)" = "$OPENCLAW_TRANSACTION_LIVE" ]; then echo refused-live-ref >&2; exit 1; fi',
    );
    await expect(x.backup()).rejects.toMatchObject({
      publication: "not-observed",
      observedCommit: x.initial,
      previousCommit: x.initial,
      ref: "refs/heads/fixture",
      cause: expect.objectContaining({ message: expect.stringContaining("refused-live-ref") }),
    });
    expect(await x.git("rev-parse", "HEAD")).toBe(x.initial);
  },
);
it.each(["core.attributesfile", "gpg.ssh.allowedSignersFile", "core.fsmonitor"])(
  "refuses unsupported relative config/helper context: %s",
  async (key) => {
    const x = await fixture();
    await x.git("config", key, "relative-fixture-helper");
    await expect(x.backup()).rejects.toThrow(/cannot preserve relative config paths/u);
    expect(await x.git("rev-parse", "HEAD")).toBe(x.initial);
  },
);

it("refuses valueless config rather than changing its meaning", async () => {
  const x = await fixture();
  await fs.appendFile(path.join(x.repositoryPath, ".git", "config"), "\n[fixture]\nflag\n");
  await expect(x.backup()).rejects.toThrow(/cannot preserve valueless Git config/u);
  expect(await x.git("rev-parse", "HEAD")).toBe(x.initial);
});
