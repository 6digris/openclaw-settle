// Unexecuted preparation. Run with the exact admitted Node26.8.2 on the proof host.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorkerCapture } from "./verify.mjs";

const directory = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Pass a new task-owned proof directory");
assert.equal(process.version, "v26.8.2");
assert.ok(!process.env.NODE_OPTIONS, "Proof needs the recorded clean Node environment");
await fs.mkdir(directory);
const install = path.join(directory, "fixture");
await fs.mkdir(path.join(install, "dist/infra"), { recursive: true });
await fs.mkdir(path.join(install, "dist/state"));
await fs.writeFile(path.join(install, "package.json"), '{"type":"module"}\n');
const target = path.join(install, "dist/infra/sqlite-store.worker.js");
await fs.writeFile(
  target,
  `import { parentPort, workerData } from 'node:worker_threads';
function sqliteWorkerSyntheticLoad() {
  const end = performance.now() + 40;
  let result = 0;
  while (performance.now() < end) result += Math.sqrt(result % 101 + 1);
  return result;
}
sqliteWorkerSyntheticLoad();
parentPort.on('message', message => {
  if (message.type === 'execute') sqliteWorkerSyntheticLoad();
  parentPort.postMessage({ id: message.id, ok: true, argv: process.execArgv,
    sentinel: process.env.SQLITE_CPU_PROOF, data: workerData,
    byte: message.input ? new Uint8Array(message.input)[0] : undefined });
});
`,
);
await fs.writeFile(
  path.join(install, "unrelated.mjs"),
  `import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ argv: process.execArgv, sentinel: process.env.SQLITE_CPU_PROOF });
`,
);
const entry = path.join(install, "openclaw.mjs");
await fs.writeFile(
  entry,
  `import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
const target = new URL('./dist/infra/sqlite-store.worker.js', import.meta.url);
const unrelated = new Worker(new URL('./unrelated.mjs', import.meta.url), {
  execArgv: [], env: { ...process.env, SQLITE_CPU_PROOF: 'unrelated' }
});
const unrelatedExit = once(unrelated, 'exit');
const worker = new Worker(target, {
  execArgv: [], env: { ...process.env, SQLITE_CPU_PROOF: 'target' }, workerData: { proof: 23 }
});
try {
  const [other] = await once(unrelated, 'message');
  assert.deepEqual(other.argv, []);
  assert.equal(other.sentinel, 'unrelated');
  const openReply = once(worker, 'message');
  const input = new Uint8Array([91]).buffer;
  worker.postMessage({ type: 'open', id: 1, actor: 1,
    moduleUrl: new URL('./dist/state/openclaw-state.worker.js', import.meta.url).href,
    input }, [input]);
  assert.equal(input.byteLength, 0);
  const [opened] = await openReply;
  assert.equal(opened.byte, 91);
  assert.equal(opened.sentinel, 'target');
  assert.deepEqual(opened.data, { proof: 23 });
  assert.equal(opened.argv.length, 3);
  assert.equal(opened.argv[0], '--cpu-prof');
  const executeReply = once(worker, 'message');
  worker.postMessage({ type: 'execute', id: 2, actor: 1 });
  assert.equal((await executeReply)[0].ok, true);
  assert.deepEqual(await unrelatedExit, [0]);
} finally {
  await Promise.all([worker.terminate(), unrelated.terminate()]);
}
`,
);
const captures = path.join(directory, "capture");
await fs.mkdir(captures);
const observer = new URL("./observer.mjs", import.meta.url);
observer.searchParams.set("entry", entry);
observer.searchParams.set("parentPid", String(process.pid));
observer.searchParams.set("directory", captures);
const log = [];
const child = spawn(process.execPath, ["--import", observer.href, entry], {
  stdio: ["ignore", "pipe", "pipe"],
  signal: AbortSignal.timeout(15_000),
});
child.stdout.on("data", (data) => log.push(data));
child.stderr.on("data", (data) => log.push(data));
const exit = await new Promise((resolve) => {
  let failed = false;
  child.once("error", () => {
    failed = true;
  });
  child.once("close", (code, signal) => resolve({ code, signal, failed }));
});
await fs.writeFile(path.join(directory, "child.log"), Buffer.concat(log));
await fs.writeFile(path.join(directory, "child-exit.json"), JSON.stringify(exit) + "\n");
assert.deepEqual(exit, { code: 0, signal: null, failed: false });
const verified = await verifyWorkerCapture(captures);
const raw = JSON.parse(await fs.readFile(path.join(captures, verified.profile), "utf8"));
assert.ok(raw.nodes.some((node) => node.callFrame.functionName === "sqliteWorkerSyntheticLoad"));
assert.equal((await fs.readdir(captures)).filter((name) => name.endsWith(".cpuprofile")).length, 1);
const result = {
  runtime: process.version,
  executable: process.execPath,
  platform: process.platform,
  executableSha256: createHash("sha256")
    .update(await fs.readFile(process.execPath))
    .digest("hex"),
  argv: process.argv,
  observer: fileURLToPath(new URL("./observer.mjs", import.meta.url)),
  exit,
  verified,
  covered: [
    "native terminate flush",
    "unrelated worker excluded",
    "env and workerData preserved",
    "transfer list detaches buffer and delivers bytes",
    "first open/execute envelopes retained",
  ],
};
await fs.writeFile(path.join(directory, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
