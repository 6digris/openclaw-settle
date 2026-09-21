// Temporary fixture-scoped observation, never an acceptance or production repair.
import fs from 'node:fs';
import cp from 'node:child_process';
import { basename } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { threadId } from 'node:worker_threads';

const limit = 512 * 1024;
const activeLimit = 32;
const observer = randomUUID(); // New even for repeated preload/context initialization.
const identity = { pid: process.pid, threadId, observer };
const own = process.env;
const key = Symbol.for('openclaw.crabbox.witness.v2');
const enabled = env => Boolean(env?.OPENCLAW_CRABBOX_WITNESS_FILE && env?.OPENCLAW_CRABBOX_WITNESS_PHASE);
let serial = 0, sequence = 0;
function row(env, event, detail = {}) {
  return { version: 2, at: new Date().toISOString(), monoMs: performance.now(),
    ...identity, ppid: process.ppid, sequence: ++sequence,
    phase: env.OPENCLAW_CRABBOX_WITNESS_PHASE,
    parentCommand: env.OPENCLAW_CRABBOX_WITNESS_PARENT ?? own.OPENCLAW_CRABBOX_WITNESS_PARENT ?? null, event, ...detail };
}
function append(env, data) {
  if (!enabled(env)) return;
  try {
    const file = env.OPENCLAW_CRABBOX_WITNESS_FILE;
    const line = JSON.stringify(data) + '\n';
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) + Buffer.byteLength(line) > limit - 256) {
      try {
        fs.writeFileSync(file + '.incomplete', 'size-cap\n', { flag: 'wx' });
        fs.appendFileSync(file, JSON.stringify({ event: 'incomplete', reason: 'size-cap' }) + '\n');
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
      return;
    }
    fs.appendFileSync(file, line);
  } catch {
    process.stderr.write('[crabbox-witness-unavailable]\n');
  }
}
const emit = (env, event, detail) => append(env, row(env, event, detail));
function descriptor(bin, args = []) {
  const evalIndex = args.findIndex(arg => arg === '-e' || arg === '--eval');
  // No environment values, eval bodies, command output, or arbitrary argv.
  return { bin: basename(String(bin)),
    entry: args.find(arg => /crabbox-wrapper\.(mjs|mts)$/.test(arg))?.split('/').pop(),
    verb: bin === 'git' ? args.find(arg => /^(status|rev-parse|diff|ls-files|archive|worktree|show|config|check-attr)$/.test(arg)) : undefined,
    evalSha256: evalIndex < 0 ? undefined : createHash('sha256').update(args[evalIndex + 1] ?? '').digest('hex') };
}
function invocation(args) {
  const index = Array.isArray(args[1]) ? 2 : 1;
  const options = args[index] ?? {};
  const env = options.env ?? own;
  const id = ++serial;
  const command = `${process.pid}:${threadId}:${observer}:${id}`;
  return { env, id, command, index, options,
    spec: descriptor(args[0], Array.isArray(args[1]) ? args[1] : []) };
}
function linkedArgs(args, call) {
  const linked = args.slice();
  linked[call.index] = { ...call.options, env: { ...call.env, OPENCLAW_CRABBOX_WITNESS_PARENT: call.command } };
  return linked;
}
function pipes(child) {
  const state = stream => stream ? { present: true, ended: stream.readableEnded,
    destroyed: stream.destroyed, closed: stream.closed } : { present: false };
  return { stdout: state(child.stdout), stderr: state(child.stderr) };
}

// One wrapper owner per realm. Re-imports have distinct identities, but never
// stack wrappers or reset the original observer's counters/child associations.
if (!globalThis[key]) {
  const active = new Map(), children = new WeakMap(), initialized = new Set();
  let overflow = false;
  function begin(call, kind) {
    const stream = call.env.OPENCLAW_CRABBOX_WITNESS_FILE + ':' + call.env.OPENCLAW_CRABBOX_WITNESS_PHASE;
    if (!initialized.has(stream)) {
      initialized.add(stream);
      emit(call.env, 'observer-init', { wrapperOwner: observer });
    }
    const detail = { id: call.id, command: call.command, phase: call.env.OPENCLAW_CRABBOX_WITNESS_PHASE, kind, ...call.spec };
    emit(call.env, kind + '-begin', detail);
    if (active.size < activeLimit) active.set(call.command, detail);
    else {
      overflow = true;
      emit(call.env, 'incomplete', { reason: 'active-state-cap' });
    }
    return detail;
  }
  globalThis[key] = {
    observer,
    captureTimeout(child, timeoutMs) {
      const call = children.get(child);
      if (!call) return undefined;
      // Memory-only bounded copy at the original timer, before stop() is invoked.
      // File I/O happens in a microtask scheduled only AFTER that invocation.
      const snapshot = row(call.env, 'timeout-snapshot', {
        id: call.id, command: call.command, child: child.pid, timeoutMs,
        boundary: 'before-cancellation', scope: 'current-observer',
        leader: { exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed },
        pipes: pipes(child), active: [...active.values()].map(value => ({ ...value })),
        activeTruncated: overflow,
      });
      return () => {
        const requested = row(call.env, 'cancellation-requested', {
          id: call.id, command: call.command, child: child.pid, snapshotSequence: snapshot.sequence,
        });
        queueMicrotask(() => { append(call.env, snapshot); append(call.env, requested); });
      };
    },
  };
  const originalSpawn = cp.spawn;
  cp.spawn = function (...args) {
    const call = invocation(args);
    if (!enabled(call.env)) return Reflect.apply(originalSpawn, this, args);
    const detail = begin(call, 'spawn');
    let child;
    try { child = Reflect.apply(originalSpawn, this, linkedArgs(args, call)); }
    catch (error) {
      active.delete(call.command);
      emit(call.env, 'spawn-throw', { ...detail, code: error.code }); throw error;
    }
    children.set(child, call);
    emit(call.env, 'spawn-ready', { id: call.id, command: call.command, child: child.pid, pipes: pipes(child) });
    const event = (name, values) => emit(call.env, name, { id: call.id, command: call.command, child: child.pid, ...values });
    child.once('error', error => event('child-error', { code: error.code }));
    child.once('exit', (code, signal) => event('child-exit', { code, signal, ...pipes(child) }));
    child.once('close', (code, signal) => {
      active.delete(call.command);
      event('child-close', { code, signal });
    });
    for (const [name, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
      stream?.once('end', () => event('pipe-end', { stream: name }));
    }
    return child;
  };
  for (const name of ['spawnSync', 'execFileSync']) {
    const original = cp[name];
    cp[name] = function (...args) {
      const call = invocation(args);
      if (!enabled(call.env)) return Reflect.apply(original, this, args);
      const detail = begin(call, name);
      try {
        const result = Reflect.apply(original, this, linkedArgs(args, call));
        emit(call.env, name + '-end', { ...detail, child: result?.pid, code: result?.status, signal: result?.signal, error: result?.error?.code });
        return result;
      } catch (error) {
        emit(call.env, name + '-throw', { ...detail, code: error.code, status: error.status, signal: error.signal });
        throw error;
      } finally { active.delete(call.command); }
    };
  }
  syncBuiltinESMExports();
  if (enabled(own)) {
    emit(own, 'process-start', descriptor(process.execPath, process.argv.slice(1)));
    process.once('beforeExit', code => emit(own, 'before-exit', { code }));
    process.once('exit', code => emit(own, 'process-exit', { code }));
    for (const ms of [10_000, 25_000]) {
      setTimeout(() => emit(own, 'alive', { afterMs: ms,
        active: [...active.values()].map(value => ({ ...value })), activeTruncated: overflow }), ms).unref();
    }
  }
}
if (enabled(own)) emit(own, 'observer-init', { wrapperOwner: globalThis[key].observer });
