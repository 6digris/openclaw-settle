import { expect, it } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  closeOwnedStdioProcess,
  createOwnedStdioProcess,
  type OwnedStdioProcess,
} from "./owned-stdio.js";
import { createChildAdapter } from "./supervisor/adapters/child.js";

async function closeAwaitedProcess(child: OwnedStdioProcess, consumption: Promise<void>) {
  child.kill("SIGKILL");
  try {
    await Promise.allSettled([child.wait(), consumption]);
    if (!child.waitForExtinction) {
      throw new Error("Awaited stdio cleanup requires its native extinction owner");
    }
    await child.waitForExtinction();
  } finally {
    child.dispose();
  }
}

it.skipIf(process.platform === "win32")(
  "drains protocol output and shutdown diagnostics before confirming real stdio cleanup",
  async () => {
    const diagnostic = "shutdown: 🌊\n".repeat(8192);
    const child = await createOwnedStdioProcess({
      argv: [
        process.execPath,
        "-e",
        `process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write("done\\n", () => {
    process.stderr.write("shutdown: 🌊\\n".repeat(8192), () => process.exit(0));
  });
});`,
      ],
      env: {},
      exactEnv: true,
    });
    let stdout = "";
    let stderr = "";
    child.onStdout((chunk) => {
      stdout += chunk;
    });
    child.onStderr((chunk) => {
      stderr += chunk;
    });
    const result = child.wait();
    try {
      await closeOwnedStdioProcess(child);
      await expect(result).resolves.toEqual({ code: 0, signal: null });
      expect(stdout).toBe("done\n");
      expect(stderr).toBe(diagnostic);
    } finally {
      await closeOwnedStdioProcess(child, { force: true }).catch(() => undefined);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "joins an awaited stdout consumer after real relay extinction",
  async () => {
    const { adapter: child, ready } = await createChildAdapter({
      argv: [
        process.execPath,
        "-e",
        `process.stdin.once("data", () => {
  process.stdin.destroy();
  process.stderr.write(String(process.ppid) + "\\n");
  process.stdout.write("held output\\n");
  process.exitCode = 7;
});`,
      ],
      ownProcessTree: true,
      stdoutConsumption: "awaited",
      stdinMode: "pipe-open",
      env: {},
      exactEnv: true,
    });
    await ready;
    const entered = createDeferred();
    const release = createDeferred();
    const exited = createDeferred();
    let stdout = "";
    let stderr = "";
    child.onExit(() => exited.resolve());
    child.onStderr((chunk) => {
      stderr += chunk;
    });
    let consumed = Promise.resolve();
    try {
      consumed = child.consumeStdout(async (chunk) => {
        stdout += chunk;
        entered.resolve();
        await release.promise;
      });
      const waiting = child.wait();
      void waiting.catch(() => undefined);
      child.stdin!.write("go");
      await withTestTimeout(entered.promise, 5_000, "stdout consumer did not receive output");
      await withTestTimeout(exited.promise, 5_000, "relay command did not exit");
      await withTestTimeout(child.waitForExtinction!(), 5_000, "relay did not become extinct");
      const settled = await Promise.race([
        waiting.then(() => true),
        new Promise<false>((resolve) => {
          setImmediate(() => resolve(false));
        }),
      ]);
      expect(settled).toBe(false);
      release.resolve();
      await withTestTimeout(consumed, 5_000, "released stdout consumer did not settle");
      await expect(
        withTestTimeout(waiting, 5_000, "relay did not join the released consumer"),
      ).resolves.toEqual({ code: 7, signal: null });
      expect(stdout).toBe("held output\n");
      expect(Number(stderr.trim())).toBeGreaterThan(0);
      expect(Number(stderr.trim())).not.toBe(process.pid);
    } finally {
      release.resolve();
      await closeAwaitedProcess(child, consumed);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "stops the real relay process before rejecting failed stdout consumption",
  async () => {
    const { adapter: child, ready } = await createChildAdapter({
      argv: [
        process.execPath,
        "-e",
        `process.stdin.once("data", () => {
  process.stdin.destroy();
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
  process.stdout.write("reject this output\\n");
});`,
      ],
      ownProcessTree: true,
      stdoutConsumption: "awaited",
      stdinMode: "pipe-open",
      env: {},
      exactEnv: true,
    });
    await ready;
    const entered = createDeferred();
    const release = createDeferred();
    const failure = new Error("synthetic stdout consumer failure");
    let consumed = Promise.resolve();
    try {
      consumed = child.consumeStdout(async () => {
        entered.resolve();
        await release.promise;
        throw failure;
      });
      const consumedFailure = consumed.then(
        () => undefined,
        (error: unknown) => error,
      );
      let extinct = false;
      const extinction = child.waitForExtinction!().then(() => {
        extinct = true;
      });
      void extinction.catch(() => undefined);
      const waitingFailure = child.wait().then(
        () => undefined,
        (error: unknown) => error,
      );
      child.stdin!.write("go");
      await withTestTimeout(entered.promise, 5_000, "rejecting consumer did not receive output");
      expect(child.pid).toBeGreaterThan(0);
      process.kill(child.pid!, 0);
      release.resolve();
      expect(
        await withTestTimeout(consumedFailure, 5_000, "consumer rejection did not settle"),
      ).toBe(failure);
      expect(
        await withTestTimeout(waitingFailure, 5_000, "consumer failure did not stop the relay"),
      ).toBe(failure);
      expect(extinct).toBe(true);
      await withTestTimeout(extinction, 5_000, "failed consumer left a live relay");
      expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      release.resolve();
      await closeAwaitedProcess(child, consumed);
    }
  },
);
