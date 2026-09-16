import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxFsBridge } from "../../agents/sandbox/fs-bridge.types.js";
import {
  declareAgentWorkspaceAccess,
  registerAgentWorkspaceAccess,
} from "../../agents/workspace-access.js";
import { ensureMemoryFlushTargetFile } from "./memory-flush-target.js";

describe("memory flush target storage", () => {
  let root: string;
  let workspaceDir: string;
  const relativePath = "memory/2026-09-15.md";
  let revoke: (() => void) | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-flush-storage-"));
    workspaceDir = path.join(root, "gateway");
  });

  afterEach(async () => {
    revoke?.();
    revoke = undefined;
    await fs.rm(root, { recursive: true, force: true });
  });

  function bind(
    createFileExclusive?: SandboxFsBridge["createFileExclusive"],
    stat?: SandboxFsBridge["stat"],
  ) {
    const unexpected = () => {
      throw new Error("Unexpected bridge operation");
    };
    revoke = registerAgentWorkspaceAccess(workspaceDir, {
      bridge: {
        createFileExclusive,
        resolvePath: unexpected,
        readFile: unexpected,
        writeFile: unexpected,
        mkdirp: unexpected,
        remove: unexpected,
        rename: unexpected,
        stat: stat ?? unexpected,
      },
    });
  }

  it("preserves local create and append behavior", async () => {
    await ensureMemoryFlushTargetFile({ workspaceDir, relativePath });
    const target = path.join(workspaceDir, relativePath);
    expect(await fs.readFile(target, "utf8")).toBe("");
    await fs.writeFile(target, "retained memory");
    await ensureMemoryFlushTargetFile({ workspaceDir, relativePath });
    expect(await fs.readFile(target, "utf8")).toBe("retained memory");
  });

  it("creates remotely without overwriting an existing memory file or touching Gateway", async () => {
    const remote = path.join(root, "harness", relativePath);
    const create = vi.fn<NonNullable<SandboxFsBridge["createFileExclusive"]>>(async () => {
      await fs.mkdir(path.dirname(remote), { recursive: true });
      try {
        await fs.writeFile(remote, "", { flag: "wx" });
        return "created";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return "exists";
        }
        throw error;
      }
    });
    bind(create, async () => {
      const value = await fs.stat(remote);
      return { type: value.isFile() ? "file" : "other", size: value.size, mtimeMs: value.mtimeMs };
    });
    await ensureMemoryFlushTargetFile({ workspaceDir, relativePath });
    expect(create).toHaveBeenCalledWith({ filePath: relativePath, data: "", mkdir: true });
    expect(await fs.readFile(remote, "utf8")).toBe("");
    await fs.writeFile(remote, "written by a running harness");
    await ensureMemoryFlushTargetFile({ workspaceDir, relativePath });
    expect(await fs.readFile(remote, "utf8")).toBe("written by a running harness");
    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an existing directory at the flush target", async () => {
    bind(
      async () => "exists",
      async () => ({ type: "directory", size: 0, mtimeMs: 0 }),
    );
    await expect(ensureMemoryFlushTargetFile({ workspaceDir, relativePath })).rejects.toThrow(
      "not a regular file",
    );
    await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["starting", "unsupported", "unavailable", "revoked"] as const)(
    "rejects %s remote access without a local fallback",
    async (state) => {
      if (state === "starting") {
        declareAgentWorkspaceAccess(workspaceDir);
      } else {
        bind(
          state === "unsupported"
            ? undefined
            : async () => {
                if (state === "unavailable") {
                  throw new Error("Remote workspace unavailable");
                }
                revoke?.();
                return "created";
              },
        );
      }
      await expect(ensureMemoryFlushTargetFile({ workspaceDir, relativePath })).rejects.toThrow();
      await expect(fs.stat(workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["../outside.md", "/outside.md", "."])("rejects invalid target %s", async (target) => {
    const create = vi.fn<NonNullable<SandboxFsBridge["createFileExclusive"]>>();
    bind(create);
    await expect(
      ensureMemoryFlushTargetFile({ workspaceDir, relativePath: target }),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
