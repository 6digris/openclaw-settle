// Temporary, fixture-scoped diagnostic preload. Never an acceptance repair.
import fs from 'node:fs';
import cp from 'node:child_process';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
const limit = 512 * 1024;
let serial = 0;
const own = process.env;
const enabled = env => Boolean(env?.OPENCLAW_CRABBOX_WITNESS_FILE && env?.OPENCLAW_CRABBOX_WITNESS_PHASE);
function emit(env, event, detail = {}) {
  if (!enabled(env)) return;
  try {
    const file = env.OPENCLAW_CRABBOX_WITNESS_FILE;
    const line = JSON.stringify({ at: new Date().toISOString(), monoMs: performance.now(), pid: process.pid, ppid: process.ppid, phase: env.OPENCLAW_CRABBOX_WITNESS_PHASE, event, ...detail }) + '\n';
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) + Buffer.byteLength(line) > limit - 256) {
      // Cross-process exclusive marker makes dropped events unambiguously incomplete.
      // In-flight appends can exceed the nominal limit by their bounded row sizes.
      try {
        fs.writeFileSync(file + '.incomplete', 'size-cap\n', { flag: 'wx' });
        fs.appendFileSync(file, JSON.stringify({ event: 'incomplete', reason: 'size-cap' }) + '\n');
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      return;
    }
    fs.appendFileSync(file, line);
  } catch (error) {
    // Instrumentation must not replace the original command outcome.
    process.stderr.write(`[crabbox-witness-unavailable] ${error.code ?? 'write-failed'}\n`);
  }
}
function descriptor(bin, args = []) {
  const evalIndex = args.findIndex(arg => arg === '-e' || arg === '--eval');
  // No environment values, eval bodies, output text, or arbitrary argv in logs.
  return { bin: basename(String(bin)), entry: args.find(arg => /crabbox-wrapper\.(mjs|mts)$/.test(arg))?.split('/').pop(), verb: bin === 'git' ? args.find(arg => /^(status|rev-parse|diff|ls-files|archive|worktree|show|config|check-attr)$/.test(arg)) : undefined, evalSha256: evalIndex < 0 ? undefined : createHash('sha256').update(args[evalIndex + 1] ?? '').digest('hex') };
}
function invocation(args) {
  const options = args[Array.isArray(args[1]) ? 2 : 1] ?? {};
  return { env: options.env ?? own, spec: descriptor(args[0], Array.isArray(args[1]) ? args[1] : []) };
}
const originalSpawn = cp.spawn;
cp.spawn = function (...args) {
  const { env, spec } = invocation(args);
  if (!enabled(env)) return Reflect.apply(originalSpawn, this, args);
  const id = ++serial;
  emit(env, 'spawn-begin', { id, ...spec });
  let child;
  try { child = Reflect.apply(originalSpawn, this, args); }
  catch (error) { emit(env, 'spawn-throw', { id, code: error.code }); throw error; }
  emit(env, 'spawn-ready', { id, child: child.pid });
  child.once('error', error => emit(env, 'child-error', { id, child: child.pid, code: error.code }));
  child.once('exit', (code, signal) => emit(env, 'child-exit', { id, child: child.pid, code, signal, stdoutEnded: child.stdout?.readableEnded, stderrEnded: child.stderr?.readableEnded }));
  child.once('close', (code, signal) => emit(env, 'child-close', { id, child: child.pid, code, signal }));
  for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) stream?.once('end', () => emit(env, 'pipe-end', { id, child: child.pid, stream: name }));
  return child;
};
for (const name of ['spawnSync', 'execFileSync']) {
  const original = cp[name];
  cp[name] = function (...args) {
    const { env, spec } = invocation(args);
    if (!enabled(env)) return Reflect.apply(original, this, args);
    const id = ++serial;
    emit(env, `${name}-begin`, { id, ...spec });
    try {
      const result = Reflect.apply(original, this, args);
      emit(env, `${name}-end`, { id, child: result?.pid, code: result?.status, signal: result?.signal, error: result?.error?.code });
      return result;
    } catch (error) { emit(env, `${name}-throw`, { id, code: error.code, status: error.status, signal: error.signal }); throw error; }
  };
}
syncBuiltinESMExports();
if (enabled(own)) {
  emit(own, 'process-start', descriptor(process.execPath, process.argv.slice(1)));
  process.once('beforeExit', code => emit(own, 'before-exit', { code, resources: process.getActiveResourcesInfo() }));
  process.once('exit', code => emit(own, 'process-exit', { code }));
  for (const ms of [10_000, 25_000]) setTimeout(() => emit(own, 'alive', { afterMs: ms, cpu: process.cpuUsage(), resources: process.getActiveResourcesInfo() }), ms).unref();
}
