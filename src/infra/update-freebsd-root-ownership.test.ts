import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCommandBuffered } from "../process/exec.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { assertFreeBsdUpdateRootOwnership } from "./update-freebsd-root-ownership.js";
import {
  freeBsdRootOwnershipEntrypoint,
  nativeFreeBsdRoot,
  withFreeBsdRootFixture,
} from "./update-freebsd-root-ownership.test-support.js";

async function native(argv: string[]): Promise<string> {
  const result = await runCommandBuffered(argv, {
    timeoutMs: 5_000,
    env: { LC_ALL: "C" },
    maxOutputBytes: { stdout: 8192, stderr: 8192 },
  });
  expect(result.termination).toBe("exit");
  expect(result.code).toBe(0);
  expect(result.stderr.toString()).toBe("");
  return result.stdout.toString();
}

describe.skipIf(!nativeFreeBsdRoot)("native FreeBSD root path admission", () => {
  it.each(["seteuid", "setuid"] as const)(
    "refuses the actual child identity after %s",
    async (method) => {
      await withFreeBsdRootFixture(async ({ root, env }) => {
        const owner = resolveRuntimeWorkerUrl(freeBsdRootOwnershipEntrypoint);
        const sourceArgs = owner.pathname.endsWith(".ts")
          ? ["--import", path.resolve("scripts/tsx.mjs")]
          : [];
        const script = `
        import { assertFreeBsdUpdateRootOwnership, FreeBsdUpdateRootOwnershipError } from ${JSON.stringify(owner.href)};
        process[${JSON.stringify(method)}](65534);
        try {
          await assertFreeBsdUpdateRootOwnership(${JSON.stringify({ roots: [root], env })});
          throw new Error('foreign process identity was admitted');
        } catch (error) {
          if (!(error instanceof FreeBsdUpdateRootOwnershipError)) throw error;
          process.stdout.write(JSON.stringify({uid:process.getuid(), euid:process.geteuid(), reason:error.reason}));
        }
      `;
        const output = await native([
          process.execPath,
          ...sourceArgs,
          "--input-type=module",
          "--eval",
          script,
        ]);
        expect(JSON.parse(output)).toEqual({
          uid: method === "seteuid" ? 0 : 65534,
          euid: 65534,
          reason: "freebsd-update-ownership",
        });
        await expect(fs.stat(env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
    30_000,
  );

  it("admits physical root-owned paths and absent state below trusted ancestors", async () => {
    await withFreeBsdRootFixture(async ({ root, env }) => {
      await expect(
        assertFreeBsdUpdateRootOwnership({ roots: [root], env }),
      ).resolves.toBeUndefined();
      await expect(fs.stat(env.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(env.OPENCLAW_CONFIG_PATH!)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it.each(["installation", "HOME", "state", "config", "database", "-wal", "-shm", "-journal"])(
    "refuses foreign-owned %s without changing its owner or creating history",
    async (target) => {
      await withFreeBsdRootFixture(async ({ home, root, env }) => {
        const database = resolveOpenClawStateSqlitePath(env);
        const selected =
          target === "installation"
            ? root
            : target === "HOME"
              ? path.join(home, "foreign-home")
              : target === "state"
                ? env.OPENCLAW_STATE_DIR!
                : target === "config"
                  ? env.OPENCLAW_CONFIG_PATH!
                  : target === "database"
                    ? database
                    : database + target;
        const directory = ["installation", "HOME", "state"].includes(target);
        await fs.mkdir(directory ? selected : path.dirname(selected), {
          recursive: true,
          mode: 0o700,
        });
        if (!directory) {
          await fs.writeFile(selected, "foreign fixture", { mode: 0o600 });
        }
        await fs.chown(selected, 65534, 65534);
        if (target === "HOME") {
          env.HOME = selected;
        }
        await expect(
          assertFreeBsdUpdateRootOwnership({ roots: [root], env }),
        ).rejects.toMatchObject({
          reason: "freebsd-update-ownership",
        });
        expect((await fs.lstat(selected)).uid).toBe(65534);
        if (!directory) {
          expect(await fs.readFile(selected, "utf8")).toBe("foreign fixture");
        }
        if (target !== "database") {
          await expect(fs.stat(database)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );

  it.each(["writable ancestor", "installation symlink", "state symlink", "config symlink"])(
    "refuses a replaceable namespace: %s",
    async (kind) => {
      await withFreeBsdRootFixture(async ({ home, root, env }) => {
        if (kind === "writable ancestor") {
          await fs.chmod(home, 0o777);
        } else {
          const alias = path.join(home, "alias");
          await fs.symlink(root, alias);
          if (kind === "installation symlink") {
            root = alias;
          } else if (kind === "state symlink") {
            env.OPENCLAW_STATE_DIR = alias;
          } else {
            env.OPENCLAW_CONFIG_PATH = alias;
          }
        }
        await expect(
          assertFreeBsdUpdateRootOwnership({ roots: [root], env }),
        ).rejects.toMatchObject({
          reason: "freebsd-update-ownership",
        });
      });
    },
  );

  // The disposable native proof provisions both filesystems at protected mounts.
  // Missing ACL support is a failed setup/proof gate, never a passing skip.
  it.each([
    { model: "POSIX.1e", parent: "/root/openclaw-test-acl-posix", nfs4: "0\n" },
    { model: "NFSv4", parent: "/root/openclaw-test-acl-nfs4", nfs4: "1\n" },
  ])(
    "refuses nontrivial access and inheritance ACLs on $model",
    async ({ parent, nfs4 }) => {
      await withFreeBsdRootFixture(async ({ root, env }) => {
        expect(await native(["/usr/bin/getconf", "ACL_NFS4", root])).toBe(nfs4);
        await expect(
          assertFreeBsdUpdateRootOwnership({ roots: [root], env }),
        ).resolves.toBeUndefined();
        const access = path.join(root, "access");
        const inheritance = path.join(root, "inheritance");
        await fs.mkdir(access, { mode: 0o700 });
        await fs.mkdir(inheritance, { mode: 0o700 });
        if (nfs4 === "1\n") {
          // write_acl and inherit-only permissions are not represented by mode 0022.
          await native(["/bin/setfacl", "-a", "0", "u:65534:write_acl::allow", access]);
          await native(["/bin/setfacl", "-a", "0", "u:65534:write_data:fi:allow", inheritance]);
        } else {
          await native(["/bin/setfacl", "-m", "u:65534:r-x,m::r-x", access]);
          await native(["/bin/setfacl", "-d", "-m", "u::rwx,g::r-x,o::---", inheritance]);
          expect(await native(["/bin/getfacl", "-q", "-n", "-s", "--", inheritance])).toBe("");
        }
        for (const selected of [access, inheritance]) {
          expect((await fs.lstat(selected)).mode & 0o022).toBe(0);
          const flags = selected === inheritance && nfs4 === "0\n" ? ["-d"] : [];
          const argv = ["/bin/getfacl", ...flags, "-q", "-n", "--", selected];
          const before = await native(argv);
          expect(before).not.toBe("");
          await expect(
            assertFreeBsdUpdateRootOwnership({ roots: [selected], env }),
          ).rejects.toMatchObject({
            reason: "freebsd-update-ownership",
          });
          expect(await native(argv)).toBe(before);
        }
      }, parent);
    },
    30_000,
  );
});
