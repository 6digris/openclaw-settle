import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runWithSpawnBroker } from "../../process/spawn-broker/context.js";
import { createSpawnBrokerHost } from "../../process/spawn-broker/host.js";
import { isPidDefinitelyDead } from "../../shared/pid-alive.js";
import { createRemoteShellSandboxSession } from "./remote-shell-transport.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const skipBrokerTests = process.platform === "win32" || Boolean(process.versions.bun);

describe.skipIf(skipBrokerTests)("remote sandbox upload through the spawn broker", () => {
  let broker: ReturnType<typeof createSpawnBrokerHost>;

  beforeAll(async () => {
    broker = createSpawnBrokerHost();
    await broker.ready();
  });
  afterAll(async () => {
    await broker?.close();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("copies bytes with both pipeline children parented by the broker", async () => {
    const root = await fs.realpath(tempDirs.make("remote-shell-broker-"));
    const localDir = path.join(root, "local");
    const remoteDir = path.join(root, "remote");
    const binDir = path.join(root, "bin");
    await fs.mkdir(localDir);
    await fs.mkdir(binDir);
    const payload = Buffer.alloc(256 * 1024);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 256;
    }
    await fs.writeFile(path.join(localDir, "payload"), payload);
    await fs.writeFile(
      path.join(binDir, "tar"),
      '#!/bin/sh\nprintf "%s" "$PPID" > "$OPENCLAW_UPLOAD_TAR_PARENT"\nexec /usr/bin/tar "$@"\n',
      { mode: 0o755 },
    );
    const tarParentFile = path.join(root, "tar-parent");
    const remoteParentFile = path.join(root, "remote-parent");
    const providerFile = path.join(root, "provider.cjs");
    await fs.writeFile(
      providerFile,
      `
      const fs = require("node:fs");
      const { spawnSync } = require("node:child_process");
      fs.writeFileSync(${JSON.stringify(remoteParentFile)}, String(process.ppid));
      if (process.cwd() !== ${JSON.stringify(root)}) process.exit(41);
      if (process.env.PROVIDER_LOCAL_ONLY !== "synthetic-provider-auth") process.exit(42);
      const child = spawnSync("/bin/sh", ["-c", process.argv[2]], {
        stdio: "inherit", env: { PATH: "/usr/bin:/bin" },
      });
      process.exit(child.status ?? 1);
      `,
    );
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("OPENCLAW_UPLOAD_TAR_PARENT", tarParentFile);
    const session = createRemoteShellSandboxSession({
      buildCommand: ({ remoteCommand }) => ({
        argv: [process.execPath, providerFile, remoteCommand],
        env: { PROVIDER_LOCAL_ONLY: "synthetic-provider-auth" },
        cwd: root,
      }),
    });

    try {
      await runWithSpawnBroker(broker, () =>
        session.uploadDirectory({ localDir, remoteDir, remoteRootDir: root }),
      );
      expect(await fs.readFile(path.join(remoteDir, "payload"))).toEqual(payload);
      const parents = await Promise.all(
        [tarParentFile, remoteParentFile].map(async (file) =>
          Number(await fs.readFile(file, "utf8")),
        ),
      );
      expect(parents).toEqual([broker.pid, broker.pid]);
      expect(parents).not.toContain(process.pid);
    } finally {
      await session.dispose();
    }
  });

  it("cancels before broker readiness and reaps both late pipeline children", async () => {
    const root = await fs.realpath(tempDirs.make("remote-shell-broker-abort-"));
    const localDir = path.join(root, "local");
    await fs.mkdir(localDir);
    await fs.writeFile(path.join(localDir, "payload"), Buffer.alloc(256 * 1024));
    const admitted = createDeferred<void>();
    const controller = new AbortController();
    const reason = new Error("operator canceled upload");
    const brokerSpawn = vi.spyOn(broker, "spawn");
    const session = createRemoteShellSandboxSession({
      buildCommand: () => ({
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        env: {},
      }),
      assertCurrent: () => admitted.resolve(),
    });
    process.kill(broker.pid!, "SIGSTOP");
    const upload = runWithSpawnBroker(broker, () =>
      session.uploadDirectory({ localDir, remoteDir: root, signal: controller.signal }),
    );
    const outcome = expect(upload).rejects.toMatchObject({
      name: "AbortError",
      code: "ABORT_ERR",
      cause: reason,
    });
    try {
      await withTestTimeout(admitted.promise, 2000, "upload admission did not start");
      controller.abort(reason);
      await outcome;
      expect(brokerSpawn).toHaveBeenCalledTimes(2);
      const children = brokerSpawn.mock.results.map((result) => result.value);
      expect(children.map((child) => child.pid)).toEqual([undefined, undefined]);
      process.kill(broker.pid!, "SIGCONT");
      await withTestTimeout(
        Promise.all(children.map((child) => child.waitForClose())),
        2000,
        "canceled upload children were not reaped",
      );
      expect(children.map((child) => child.signalCode)).toEqual(["SIGKILL", "SIGKILL"]);
      expect(children.every((child) => isPidDefinitelyDead(child.pid!))).toBe(true);
    } finally {
      controller.abort(reason);
      process.kill(broker.pid!, "SIGCONT");
      await session.dispose();
    }
  });

  it("refuses archive delivery when authority changes before the remote pipe is ready", async () => {
    const root = await fs.realpath(tempDirs.make("remote-shell-broker-authority-"));
    const localDir = path.join(root, "local");
    const remoteDir = path.join(root, "remote");
    await fs.mkdir(localDir);
    await fs.writeFile(path.join(localDir, "payload"), "private workspace bytes");
    const admitted = createDeferred<void>();
    const revoked = new Error("Remote claim was revoked");
    const controller = new AbortController();
    let current = true;
    const brokerSpawn = vi.spyOn(broker, "spawn");
    const session = createRemoteShellSandboxSession({
      buildCommand: ({ remoteCommand }) => ({
        argv: ["/bin/sh", "-c", remoteCommand],
        env: { PATH: "/usr/bin:/bin" },
      }),
      assertCurrent: () => {
        if (!current) {
          throw revoked;
        }
        admitted.resolve();
      },
    });
    process.kill(broker.pid!, "SIGSTOP");
    const upload = runWithSpawnBroker(broker, () =>
      session.uploadDirectory({
        localDir,
        remoteDir,
        remoteRootDir: root,
        signal: controller.signal,
      }),
    );
    const outcome = expect(upload).rejects.toBe(revoked);
    try {
      await withTestTimeout(admitted.promise, 2000, "upload admission did not start");
      current = false;
      process.kill(broker.pid!, "SIGCONT");
      await outcome;
      expect(brokerSpawn).toHaveBeenCalledTimes(2);
      await withTestTimeout(
        Promise.all(brokerSpawn.mock.results.map((result) => result.value.waitForClose())),
        2000,
        "revoked upload children were not reaped",
      );
      await expect(fs.readFile(path.join(remoteDir, "payload"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      controller.abort();
      process.kill(broker.pid!, "SIGCONT");
      await session.dispose();
    }
  });
});
