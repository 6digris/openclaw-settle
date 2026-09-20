"use strict";
// Diagnostic-only preload. It never creates a timer, changes exit status, or retries work.
const fs = require("node:fs");
const path = require("node:path");
const { createHook } = require("node:async_hooks");
const expected = process.env.OPENCLAW_PROOF_TRACE_ENTRY;
const output = process.env.OPENCLAW_PROOF_TRACE_OUTPUT;
const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
if (
  expected &&
  output &&
  process.argv[1] &&
  process.argv[2] === "update" &&
  fold(path.resolve(process.argv[1])) === fold(path.resolve(expected))
) {
  const pending = new Map();
  const limit = 2048;
  let created = 0;
  let resolved = 0;
  let evicted = 0;
  const hook = createHook({
    init(id, type, triggerId) {
      if (type !== "PROMISE") return;
      created++;
      const stack = new Error("Promise created").stack;
      pending.set(id, { id, triggerId, stack });
      if (pending.size > limit) {
        pending.delete(pending.keys().next().value);
        evicted++;
      }
    },
    promiseResolve(id) {
      if (pending.delete(id)) resolved++;
    },
    // An unreachable unresolved promise may be collected before beforeExit. Keep its
    // bounded creation record, marking collection instead of losing the wait location.
    destroy(id) {
      const item = pending.get(id);
      if (item) item.destroyed = true;
    },
  });
  hook.enable();
  process.once("beforeExit", (code) => {
    hook.disable();
    const receipt = {
      scope: "released-driver promise-lifetime diagnostics; never native acceptance",
      pid: process.pid,
      beforeExitCode: code,
      processExitCode: process.exitCode ?? null,
      resources: process.getActiveResourcesInfo(),
      created,
      resolved,
      evicted,
      retainedLimit: limit,
      unresolvedPromiseObservations: [...pending.values()],
    };
    try {
      fs.writeFileSync(`${output}.${process.pid}.json`, JSON.stringify(receipt, null, 2), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      // A diagnostic write failure must not change the released updater's outcome.
      fs.writeSync(2, "Released-driver promise diagnostic could not be written.\n");
    }
  });
}
