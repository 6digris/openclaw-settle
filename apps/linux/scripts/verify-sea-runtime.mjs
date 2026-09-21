import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const binary = path.resolve(process.argv[2] || "apps/linux/src-tauri/gen/runtime/openclaw-runtime");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sea-product-"));
try {
  const env = {
    HOME: root,
    PATH: "/usr/bin:/bin",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_DESKTOP_RUNTIME_DIR: path.join(root, "runtime"),
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_NO_AUTO_UPDATE: "1",
  };
  const invoke = (args, environment = env) => {
    const result = spawnSync(binary, args, { env: environment, encoding: "utf8", timeout: 120000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  const start = performance.now();
  const version = invoke(["--version"]).trim();
  const coldMs = performance.now() - start;
  invoke(["gateway", "--help"]);
  invoke(["node", "--help"]);
  invoke(["plugins", "list", "--json"]);
  const versions = fs
    .readdirSync(env.OPENCLAW_DESKTOP_RUNTIME_DIR)
    .filter((name) => /^[a-f0-9]{64}$/.test(name));
  assert.equal(versions.length, 1);
  const runtime = path.join(env.OPENCLAW_DESKTOP_RUNTIME_DIR, versions[0]);
  const node = path.join(runtime, "bin/node");
  const pkg = path.join(runtime, "openclaw");
  const probe =
    "import assert from 'node:assert/strict';\nimport {createRequire} from 'node:module';\nimport {DatabaseSync} from 'node:sqlite';\nconst require=createRequire(process.cwd()+'/package.json');\nconst pty=require('@lydell/node-pty');\nconst terminal=pty.spawn(process.execPath,['-e','process.stdout.write(\"native-pty-ok\")'],{env:process.env});\nlet output='';\nterminal.onData(data=>output+=data);\nconst exit=await new Promise(resolve=>terminal.onExit(resolve));\nassert.equal(exit.exitCode,0);\nassert.match(output,/native-pty-ok/);\nconst sqlite=require('sqlite-vec');\nconst db=new DatabaseSync(':memory:',{allowExtension:true});\nsqlite.load(db);\nassert.ok(db.prepare('select vec_version() as version').get().version);\ndb.close();\nconst fsSafe=await import(require.resolve('@openclaw/fs-safe'));\nassert.ok(fsSafe);\nconsole.log('pty, sqlite-vec and fs-safe loaded from the extracted package');\n";
  const result = spawnSync(node, ["--input-type=module", "--eval", probe], {
    cwd: pkg,
    env,
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  fs.mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"),
    JSON.stringify({
      gateway: { mode: "local", port, auth: { mode: "token", token: "sea-fixture-token" } },
      plugins: { entries: { "device-pair": { config: { publicUrl: "ws://127.0.0.1:" + port } } } },
    }),
  );
  const gateway = spawn(
    binary,
    [
      "gateway",
      "run",
      "--allow-unconfigured",
      "--port",
      String(port),
      "--auth",
      "token",
      "--token",
      "sea-fixture-token",
    ],
    { env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let log = "";
  gateway.stdout.on("data", (bytes) => {
    log = (log + bytes).slice(-16000);
  });
  gateway.stderr.on("data", (bytes) => {
    log = (log + bytes).slice(-16000);
  });
  const exited = once(gateway, "exit");
  try {
    const deadline = Date.now() + 120000;
    let ready = false;
    while (Date.now() < deadline && gateway.exitCode === null) {
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/readyz");
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {}
      await delay(200);
    }
    assert.ok(ready, log);
    const fakeBin = path.join(root, "host-bin");
    fs.mkdirSync(fakeBin);
    // npm derives this nominal prefix from process.execPath, even when its own
    // JavaScript comes from an unrelated host installation. It must not own us.
    fs.writeFileSync(
      path.join(fakeBin, "npm"),
      "#!/bin/sh\nprintf '%s\\n' '" + path.join(runtime, "lib/node_modules") + "'\n",
      { mode: 0o500 },
    );
    const ownership = JSON.parse(
      invoke(["update", "status", "--json", "--timeout", "1"], {
        ...env,
        PATH: fakeBin + path.delimiter + env.PATH,
      }),
    );
    assert.equal(ownership.update.packageManager, "unknown");
    assert.equal(ownership.update.root, pkg);
    const rpc = ["--url", "ws://127.0.0.1:" + port, "--token", "sea-fixture-token", "--json"];
    const { joinUrl } = JSON.parse(invoke(["devices", "join-code", ...rpc]));
    assert.equal(typeof joinUrl, "string");
    const worker = spawn(
      binary,
      ["connect", joinUrl, "--commands", "desktop.stream", "--display-name", "SEA desktop proof"],
      {
        env: { ...env, OPENCLAW_STATE_DIR: path.join(root, "node-state") },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    let workerLog = "";
    worker.stdout.on("data", (bytes) => {
      workerLog = (workerLog + bytes).slice(-12000);
    });
    worker.stderr.on("data", (bytes) => {
      workerLog = (workerLog + bytes).slice(-12000);
    });
    const workerExit = once(worker, "exit");
    try {
      const deadline = Date.now() + 90000;
      let connected = false;
      while (Date.now() < deadline && worker.exitCode === null) {
        const pending = JSON.parse(invoke(["nodes", "pending", ...rpc]));
        for (const request of pending) {
          assert.equal(request.displayName, "SEA desktop proof");
          invoke(["nodes", "approve", request.requestId, ...rpc]);
        }
        const state = JSON.parse(invoke(["nodes", "status", ...rpc]));
        connected = state.nodes.some(
          (node) =>
            node.displayName === "SEA desktop proof" &&
            node.connected &&
            node.commands.includes("desktop.stream"),
        );
        if (connected) break;
        await delay(200);
      }
      assert.ok(connected, "Desktop node did not advertise its capability: " + workerLog);
    } finally {
      worker.kill("SIGTERM");
      const stopped = await Promise.race([workerExit, delay(30000, null, { ref: false })]);
      if (!stopped) {
        process.kill(-worker.pid, "SIGKILL");
        await workerExit;
        throw new Error("Desktop worker cancellation failed");
      }
    }
  } finally {
    gateway.kill("SIGTERM");
    const result = await Promise.race([exited, delay(30000, null, { ref: false })]);
    if (!result) {
      process.kill(-gateway.pid, "SIGKILL");
      await exited;
      throw new Error("Gateway did not stop gracefully: " + log);
    }
  }
  console.log(
    JSON.stringify({
      version,
      coldMs,
      executableBytes: fs.statSync(binary).size,
      native: result.stdout.trim(),
      gatewayReady: true,
      appOwnedUpdateRoot: true,
      desktopNodeConnected: true,
      desktopNodeCancelled: true,
      gracefulShutdown: true,
    }),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
