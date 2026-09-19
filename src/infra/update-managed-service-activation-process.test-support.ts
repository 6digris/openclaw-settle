import type { spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { waitForFile } from "../../test/helpers/process-wait.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../test/vitest/vitest.timeouts.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

/** Retains actual Gateway -> helper -> updater ancestry across the stop exchange. */
export async function createManagedActivationAncestor(root: string, spawn: typeof spawnProcess) {
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "index.js"), "");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "1.0.0" }),
  );
  const launchPath = path.join(root, "helper-launch.json");
  const exitPath = path.join(root, "helper-exit");
  const pidPath = path.join(root, "helper-pid");
  const preloadPath = path.join(root, "helper-exit-preload.cjs");
  const statePath = path.join(root, "manager-state.json");
  await fs.writeFile(
    preloadPath,
    `if (process.argv[1] === process.env.OPENCLAW_TEST_ACTIVATION_HELPER) {
    const fs = require("node:fs"), path = require("node:path"), children = require("node:child_process");
    const spawn = children.spawn, kill = process.kill;
    let updaterPid;
    const settled = ${JSON.stringify(statePath + ".native-settled")};
    children.spawn = (...args) => {
      const child = spawn(...args);
      if (!updaterPid && args[2]?.stdio?.includes("ipc")) updaterPid = child.pid;
      if (path.basename(args[0]) === "launchctl" && args[1]?.[0] === "bootout")
        child.once("close", () => fs.writeFileSync(settled, "joined"));
      return child;
    };
    process.kill = (pid, ...args) => {
      if (updaterPid && Math.abs(pid) === updaterPid)
        fs.writeFileSync(${JSON.stringify(statePath + ".retirement")}, JSON.stringify({ nativeStopSettledBeforeRetirement: fs.existsSync(settled) }));
      return kill(pid, ...args);
    };
    process.once("exit", code => fs.writeFileSync(${JSON.stringify(exitPath)}, String(code)));
  }`,
  );
  const parent = spawn(
    resolveTestNodeExecPath(),
    [
      "-e",
      `
    const fs = require("node:fs"), { spawn } = require("node:child_process");
    process.stdin.resume();
    process.stdin.once("end", () => process.exit(0));
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(launchPath)})) return;
      clearInterval(timer);
      const launch = JSON.parse(fs.readFileSync(${JSON.stringify(launchPath)}, "utf8"));
      const child = spawn(launch.command, launch.args, { env: launch.env, detached: true, stdio: [3,4,5] });
      fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
      child.unref();
    }, 5);
  `,
    ],
    { stdio: ["pipe", "ignore", "ignore", "pipe", "pipe", "pipe"] },
  );
  const parentPid = parent.pid;
  const parentStartIdentity = parentPid ? getFileLockProcessStartTime(parentPid) : null;
  if (!parentPid || parentStartIdentity === null) {
    parent.kill();
    throw new Error("fixture ancestor has no stable identity");
  }
  const parentClosed = new Promise<void>((resolve) => {
    parent.once("close", () => resolve());
  });
  let helper: { pid: number; startIdentity: number | null } | undefined;
  let exitPoll: ReturnType<typeof setInterval> | undefined;
  return {
    parent,
    parentPid,
    parentStartIdentity,
    parentClosed,
    async connect(scriptPath: string, paramsPath: string, env: NodeJS.ProcessEnv) {
      // These are inherited OS pipes; only the grandchild's event facade is synthetic.
      const [stdin, stdout, stderr] = parent.stdio.slice(3);
      if (
        !(stdin instanceof Writable) ||
        !(stdout instanceof Readable) ||
        !(stderr instanceof Readable)
      ) {
        throw new Error("fixture ancestor control pipes are unavailable");
      }
      await fs.writeFile(
        launchPath,
        JSON.stringify({
          command: resolveTestNodeExecPath(),
          args: [scriptPath, paramsPath],
          env: {
            ...env,
            OPENCLAW_TEST_ACTIVATION_HELPER: scriptPath,
            NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim(),
          },
        }),
        { mode: 0o600 },
      );
      await waitForFile(pidPath, DEFAULT_VITEST_TEST_TIMEOUT_MS);
      const pid = Number(await fs.readFile(pidPath, "utf8"));
      helper = { pid, startIdentity: getFileLockProcessStartTime(pid) };
      const transport = Object.assign(new EventEmitter(), {
        pid,
        stdin,
        stdout,
        stderr,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
      });
      let reading = false;
      exitPoll = setInterval(() => {
        if (reading) {
          return;
        }
        reading = true;
        void fs.readFile(exitPath, "utf8").then(
          (code) => {
            clearInterval(exitPoll);
            transport.exitCode = Number(code);
            transport.emit("close", Number(code));
          },
          () => {
            reading = false;
          },
        );
      }, 5);
      return transport;
    },
    async cleanup(cleanupDescendants: () => Promise<void>) {
      // Discover live descendants before retiring the ancestor and its control pipes.
      if (parent.exitCode === null && parent.signalCode === null) {
        await cleanupDescendants();
      }
      clearInterval(exitPoll);
      if (
        helper &&
        helper.startIdentity !== null &&
        getFileLockProcessStartTime(helper.pid) === helper.startIdentity
      ) {
        try {
          process.kill(-helper.pid, "SIGKILL");
        } catch {}
        try {
          process.kill(helper.pid, "SIGKILL");
        } catch {}
      }
    },
  };
}

/** Observe either a direct helper or the retained grandchild transport. */
export function observeManagedActivationHelper(
  helper: EventEmitter & {
    stdout?: Readable | null;
    stderr?: Readable | null;
  },
) {
  let stdout = "";
  let stderr = "";
  let completed = false;
  helper.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  helper.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const completion = new Promise<number | null>((resolve, reject) => {
    helper.once("error", reject);
    helper.once("close", (code) => {
      completed = true;
      resolve(code);
    });
  });
  return {
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get completed() {
      return completed;
    },
    completion,
  };
}
