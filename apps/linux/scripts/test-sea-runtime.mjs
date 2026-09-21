import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSea } from "./build-sea-runtime.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sea-proof-"));
try {
  const source = path.join(root, "source");
  const pkg = path.join(source, "lib/node_modules/openclaw");
  fs.mkdirSync(path.join(source, "bin"), { recursive: true });
  fs.mkdirSync(pkg, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(source, "bin/node"));
  fs.writeFileSync(path.join(pkg, "lazy.mjs"), "export default await Promise.resolve(42);");
  fs.symlinkSync("lazy.mjs", path.join(pkg, "linked.mjs"));
  fs.writeFileSync(
    path.join(pkg, "worker.mjs"),
    "import {parentPort} from 'node:worker_threads'; parentPort.postMessage(await Promise.resolve(43));",
  );
  fs.writeFileSync(
    path.join(pkg, "child.mjs"),
    "process.send({value: await Promise.resolve(44), execPath: process.execPath});",
  );
  fs.writeFileSync(
    path.join(pkg, "openclaw.mjs"),
    "import assert from 'node:assert/strict';\nimport { fork, spawnSync } from 'node:child_process';\nimport { Worker } from 'node:worker_threads';\nimport { DatabaseSync } from 'node:sqlite';\nassert.equal((await import('./lazy.mjs')).default, 42);\nassert.equal((await import('./linked.mjs')).default, 42);\nassert.ok((await import('node:fs')).lstatSync(new URL('./linked.mjs', import.meta.url)).isSymbolicLink());\nconst worker = new Worker(new URL('./worker.mjs', import.meta.url));\nassert.equal(await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }), 43);\nawait worker.terminate();\nconst child = fork(new URL('./child.mjs', import.meta.url));\nconst result = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); });\nassert.equal(result.value, 44);\nassert.equal(result.execPath, process.execPath);\nawait new Promise(resolve => child.once('exit', resolve));\nconst evalResult = spawnSync(process.execPath, ['-e', 'process.stdout.write(\"eval-ok\")'], {encoding:'utf8'});\nassert.equal(evalResult.stdout, 'eval-ok');\nconst db = new DatabaseSync(':memory:');\nassert.equal(db.prepare('select 45 as n').get().n, 45);\ndb.close();\nconsole.log(JSON.stringify({execPath:process.execPath, argv:process.argv.slice(2), pid:process.pid}));\n",
  );
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.1.0" }));
  const binary = path.join(root, "runtime");
  const metrics = buildSea(source, binary);
  fs.rmSync(source, { recursive: true, force: true });
  const relocated = path.join(root, "relocated");
  fs.mkdirSync(relocated);
  fs.renameSync(binary, path.join(relocated, "runtime"));
  const env = {
    HOME: root,
    PATH: "/nonexistent",
    OPENCLAW_DESKTOP_RUNTIME_DIR: path.join(root, "materialized"),
  };
  const times = [];
  for (let i = 0; i < 2; i++) {
    const start = performance.now();
    const result = spawnSync(path.join(relocated, "runtime"), ["proof argument"], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed.argv, ["proof argument"]);
    assert.equal(observed.pid, result.pid);
    assert.ok(observed.execPath.startsWith(env.OPENCLAW_DESKTOP_RUNTIME_DIR));
    times.push(performance.now() - start);
  }
  console.log(JSON.stringify({ ...metrics, coldMs: times[0], warmMs: times[1] }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
