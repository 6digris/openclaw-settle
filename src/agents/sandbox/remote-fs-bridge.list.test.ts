import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SANDBOX_PINNED_MUTATION_PYTHON } from "./fs-bridge-mutation-helper.js";
import { createSandbox } from "./fs-bridge.test-helpers.js";
import { createRemoteShellSandboxFsBridge } from "./remote-fs-bridge.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const exec = promisify(execFile);
async function fixture() {
  const workspaceDir = await fs.realpath(tempDirs.make("remote-list-"));
  const bridge = createRemoteShellSandboxFsBridge({
    sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
    runtime: {
      remoteWorkspaceDir: workspaceDir,
      remoteAgentWorkspaceDir: workspaceDir,
      async runRemoteShellScript(command) {
        // Exercise the production pinned helper on macOS as well as Linux;
        // only the GNU readlink launcher is replaced by native realpath.
        if (command.script.includes('readlink -f -- "$cursor"')) {
          const target = await fs.realpath(command.args![0]!);
          const root = await fs.realpath(command.args![2]!);
          return { stdout: Buffer.from(`${target}\n${root}\n`), stderr: Buffer.alloc(0), code: 0 };
        }
        const result = await exec(
          "python3",
          ["-c", SANDBOX_PINNED_MUTATION_PYTHON, ...command.args!],
          { encoding: "buffer" },
        );
        return { ...result, code: 0 };
      },
    },
  });
  return { workspaceDir, bridge };
}

it("lists bounded direct entries without following child symlinks", async () => {
  const { workspaceDir, bridge } = await fixture();
  await fs.mkdir(path.join(workspaceDir, "memory"));
  await fs.writeFile(path.join(workspaceDir, "memory", "daily.md"), "note");
  await fs.mkdir(path.join(workspaceDir, "memory", "nested"));
  await fs.symlink("daily.md", path.join(workspaceDir, "memory", "alias.md"));
  expect(await bridge.listDirectory!({ filePath: "memory", maxEntries: 3 })).toEqual(
    expect.arrayContaining([
      { name: "daily.md", type: "file" },
      { name: "nested", type: "directory" },
      { name: "alias.md", type: "other" },
    ]),
  );
  await expect(bridge.listDirectory!({ filePath: "memory", maxEntries: 2 })).rejects.toThrow();
});

it("returns missing directories and rejects directory symlinks and traversal", async () => {
  const { workspaceDir, bridge } = await fixture();
  await expect(bridge.listDirectory!({ filePath: "missing", maxEntries: 2 })).resolves.toBeNull();
  await fs.mkdir(path.join(workspaceDir, "memory"));
  await fs.symlink("memory", path.join(workspaceDir, "alias"));
  await expect(bridge.listDirectory!({ filePath: "alias", maxEntries: 2 })).rejects.toThrow();
  await expect(bridge.listDirectory!({ filePath: "../outside", maxEntries: 2 })).rejects.toThrow();
  await expect(bridge.listDirectory!({ filePath: "memory", maxEntries: 0 })).rejects.toThrow();
});
