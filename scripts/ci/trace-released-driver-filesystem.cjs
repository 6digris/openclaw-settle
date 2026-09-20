"use strict";
// Diagnostic-only: observe real filesystem promises without replacing their result,
// deadline, cleanup, or return identity. A regular-file trace never holds Node alive.
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const { createHook } = require("node:async_hooks");
const expected = process.env.OPENCLAW_PROOF_TRACE_ENTRY;
const output = process.env.OPENCLAW_PROOF_TRACE_OUTPUT;
const root = process.env.OPENCLAW_PROOF_TRACE_ROOT;
const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
if (
  expected &&
  output &&
  root &&
  process.argv[1] &&
  process.argv[2] === "update" &&
  fold(path.resolve(process.argv[1])) === fold(path.resolve(expected))
) {
  let sequence = 0;
  let events = 0;
  const limit = 256;
  const record = (entry) => {
    if (events++ >= limit) {
      return;
    }
    try {
      fs.appendFileSync(
        `${output}.${process.pid}.jsonl`,
        JSON.stringify({
          diagnosticOnly: true,
          pid: process.pid,
          at: new Date().toISOString(),
          ...entry,
        }) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      /* observation never changes result */
    }
  };
  const owned = (value) =>
    typeof value === "string" &&
    fold(path.resolve(value)).startsWith(fold(path.resolve(root)) + path.sep);

  // Node's recursive remover captures these callback APIs lazily. Observe the
  // primitive errors that the promise-level trace cannot attribute to a leaf.
  // This diagnostic never changes retry options, callback values, or lifetimes.
  const leafCounts = new Map();
  let leafEvents = 0;
  let modulesRecorded = false;
  const leafLimit = 4096;
  const recordLeaf = (entry) => {
    if (leafEvents++ >= leafLimit) {
      return;
    }
    try {
      fs.appendFileSync(
        `${output}.${process.pid}.leaves.jsonl`,
        JSON.stringify({
          diagnosticOnly: true,
          pid: process.pid,
          at: new Date().toISOString(),
          ...entry,
        }) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      /* diagnostics cannot replace the released callback's result */
    }
  };
  for (const operation of ["chmod", "lstat", "readdir", "rmdir", "stat", "unlink"]) {
    const original = fs[operation];
    fs[operation] = function (...args) {
      const target = Buffer.isBuffer(args[0]) ? args[0].toString() : args[0];
      const callback = args.at(-1);
      if (
        typeof callback !== "function" ||
        !owned(target) ||
        !fold(target).includes(`${path.sep}.openclaw.package-backup-`)
      ) {
        return Reflect.apply(original, this, args);
      }
      args[args.length - 1] = function (...results) {
        try {
          const error = results[0];
          // ENOTEMPTY is the remover's normal directory-descent signal. The
          // occupied child's retryable error, not that signal, identifies a leaf.
          if (error && ["EBUSY", "EPERM", "EACCES", "EMFILE", "ENFILE"].includes(error.code)) {
            const key = `${operation}\0${target}\0${error.code}`;
            const count = (leafCounts.get(key) ?? 0) + 1;
            leafCounts.delete(key);
            if (leafCounts.size >= leafLimit) {
              leafCounts.delete(leafCounts.keys().next().value);
            }
            leafCounts.set(key, count);
            if ((count === 1 && leafEvents < 64) || (count > 1 && (count & (count - 1)) === 0)) {
              recordLeaf({
                state: "callback-error",
                operation,
                path: target,
                code: error.code,
                count,
              });
            }
            if (count >= 8 && !modulesRecorded) {
              modulesRecorded = true;
              // Select only module paths. Never serialize the report's environment,
              // command line, stacks, or other operator/process state.
              const sharedObjects = process.report.getReport().sharedObjects;
              recordLeaf({
                state: "loaded-modules",
                triggeringPath: target,
                modules: Array.isArray(sharedObjects) ? sharedObjects.filter(owned) : [],
              });
            }
          }
        } catch {
          /* inspection failure must not swallow or transform a callback */
        }
        return Reflect.apply(callback, this, results);
      };
      return Reflect.apply(original, this, args);
    };
  }
  recordLeaf({
    state: "enabled",
    scope: "obsolete package backup callback errors",
    limit: leafLimit,
  });

  let capturing = false;
  const promiseIds = new WeakMap();
  const settledDuringCall = new Set();
  const pending = new Map();
  createHook({
    init(id, type, trigger, resource) {
      if (capturing && type === "PROMISE") {
        promiseIds.set(resource, id);
      }
    },
    promiseResolve(id) {
      const item = pending.get(id);
      if (item) {
        pending.delete(id);
        record({
          id: item.id,
          operation: item.operation,
          state: "settled",
          elapsedMs: Date.now() - item.started,
        });
      } else if (capturing && settledDuringCall.size < limit) {
        settledDuringCall.add(id);
      }
    },
  }).enable();
  for (const operation of ["rm", "rename"]) {
    const original = fs.promises[operation];
    fs.promises[operation] = function (...args) {
      if (events >= limit || (!owned(args[0]) && !(operation === "rename" && owned(args[1])))) {
        return Reflect.apply(original, this, args);
      }
      const id = ++sequence;
      const started = Date.now();
      record({
        id,
        operation,
        state: "begin",
        paths: args.slice(0, operation === "rm" ? 1 : 2),
        stack: new Error("Filesystem operation").stack,
      });
      let promise;
      settledDuringCall.clear();
      capturing = true;
      try {
        promise = Reflect.apply(original, this, args);
      } catch (error) {
        record({ id, operation, state: "throw", code: error?.code });
        throw error;
      } finally {
        capturing = false;
      }
      const asyncId = promiseIds.get(promise);
      if (asyncId === undefined) {
        record({ id, operation, state: "unobserved-promise" });
      } else if (settledDuringCall.has(asyncId)) {
        record({ id, operation, state: "settled", elapsedMs: Date.now() - started });
      } else {
        pending.set(asyncId, { id, operation, started });
      }
      settledDuringCall.clear();
      // No then/catch is attached: handled/unhandled rejection semantics belong
      // exclusively to the released caller. "Settled" does not claim success.
      return promise;
    };
  }
  syncBuiltinESMExports();
  record({
    state: "enabled",
    limit,
    root,
    scope: "released-driver filesystem attribution; not acceptance",
  });
}
