import { withTestSpawnBroker } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  native.spawn.mockImplementation(actual.spawn);
  native.execFile.mockImplementation(actual.execFile);
  return { ...actual, ...native };
});

import {
  readCodexAppServerProcessCommand,
  readCodexAppServerProcessSnapshot,
} from "./transport-process-snapshot.js";

describe.skipIf(process.platform === "win32" || Boolean(process.versions.bun))(
  "Codex process inspection spawn ownership",
  () => {
    it("reads the live process command through the broker without spawning in the Gateway", async () => {
      await withTestSpawnBroker(async ({ broker }) => {
        const admitted = vi.spyOn(broker, "spawn");
        const admittedCommand = vi.spyOn(broker, "spawnExeca");
        native.spawn.mockClear();
        native.execFile.mockClear();
        try {
          const deadline = Date.now() + 10_000;
          const rows = await readCodexAppServerProcessSnapshot(deadline, [process.pid]);
          const own = rows.find((row) => row.pid === process.pid);
          expect(own).toBeDefined();
          const command = await readCodexAppServerProcessCommand(own!, deadline);
          expect(command).toContain("node");
          expect(admitted.mock.calls.length + admittedCommand.mock.calls.length).toBeGreaterThan(0);
          expect(native.execFile).not.toHaveBeenCalled();
          expect(native.spawn).not.toHaveBeenCalled();
        } finally {
          admitted.mockRestore();
          admittedCommand.mockRestore();
        }
      });
    });
  },
);
