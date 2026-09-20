import type { ChildProcess } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { createManagedServiceBoundaryCleanup } from "../../infra/update-managed-service-handoff-process.test-support.js";
import type { UpdateRespawnFixtures } from "./run-loop.test-support.js";

/** Pause the real preparation flight after its owner exists, before helper spawn. */
export async function gateFixtureHandoffPublication(root: string, handoffId: string) {
  const runtimeFs = (await import("node:fs/promises")).default;
  const write = runtimeFs.writeFile;
  const entered = createDeferred();
  const release = createDeferred();
  const publication = vi
    .spyOn(runtimeFs, "writeFile")
    .mockImplementation(async (target, data, options) => {
      if (
        typeof target === "string" &&
        path.basename(target) === "handoff.json" &&
        typeof data === "string"
      ) {
        const params = JSON.parse(data);
        if (params.updateLeaseKey === root && params.handoffId === handoffId) {
          entered.resolve();
          await release.promise;
        }
      }
      return write(target, data, options);
    });
  return {
    entered: entered.promise,
    release: () => release.resolve(),
    restore: () => publication.mockRestore(),
  };
}

/** Observe only this fixture's helper; startup refusal remains the production decision. */
export async function observeFixtureHelper(
  root: string,
  handoffId: string,
  control: string,
  spawnProcess: UpdateRespawnFixtures["spawnProcess"],
) {
  const { spawn } =
    await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const runtimeFs = (await import("node:fs/promises")).default;
  const remove = runtimeFs.rm;
  let helper: ChildProcess | undefined;
  let helperDirectory: string | undefined;
  let closed: Promise<void> | undefined;
  let stderr = "";
  const capture = async () => {
    if (helperDirectory) {
      const log = await fs
        .readFile(path.join(helperDirectory, "handoff.log"), "utf8")
        .catch(() => undefined);
      if (log !== undefined) {
        await fs.writeFile(path.join(control, "handoff.log"), log, { mode: 0o600 });
      }
    }
    if (stderr) {
      await fs.writeFile(path.join(control, "handoff.stderr.log"), stderr, { mode: 0o600 });
    }
  };
  spawnProcess.mockImplementation((command, args, options) => {
    const script = Array.isArray(args) ? args[0] : undefined;
    let matched = false;
    if (typeof script === "string" && path.basename(script) === "handoff.cjs") {
      const params = JSON.parse(
        fsSync.readFileSync(path.join(path.dirname(script), "handoff.json"), "utf8"),
      );
      matched = params.updateLeaseKey === root && params.handoffId === handoffId;
    }
    if (!matched) {
      return spawn(command, args, options);
    }
    helperDirectory = path.dirname(script!);
    // Only stderr visibility changes; argv, environment, IPC and ownership stay real.
    helper = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    helper.stderr?.on("data", (bytes) => {
      stderr = (stderr + String(bytes)).slice(-32768);
    });
    closed = new Promise((resolve) => {
      helper!.once("close", () => resolve());
    });
    return helper;
  });
  const removeSpy = vi.spyOn(runtimeFs, "rm").mockImplementation(async (target, options) => {
    if (helperDirectory && target === helperDirectory) {
      await capture().catch(() => undefined);
    }
    return remove(target, options);
  });
  const cleanup = createManagedServiceBoundaryCleanup(() => [helper]);
  return {
    async waitForClose() {
      if (!closed) {
        throw new Error("fixture helper did not launch");
      }
      await withTimeout(closed, 15000);
    },
    async close() {
      const outcomes = await Promise.allSettled([
        cleanup(),
        ...(closed ? [withTimeout(closed, 15000)] : []),
      ]);
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      try {
        await capture();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, "Fixture helper cleanup did not settle");
      }
    },
    restore() {
      spawnProcess.mockImplementation(spawn);
      removeSpy.mockRestore();
    },
  };
}
