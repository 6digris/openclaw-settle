import { errorMonitor } from "node:events";
// Fixed task-only observer for the first installed SQLite worker. Diagnostic timings only.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import workerThreads from "node:worker_threads";

const params = new URL(import.meta.url).searchParams;
const expectedEntry = params.get("entry");
const expectedParent = Number(params.get("parentPid"));
const active =
  workerThreads.isMainThread &&
  process.ppid === expectedParent &&
  path.resolve(process.argv[1] ?? "") === expectedEntry;

if (active) {
  const directory = params.get("directory");
  if (!directory || !path.isAbsolute(directory)) {
    throw new Error("Worker profile directory missing");
  }
  const workerEntry = pathToFileURL(
    path.join(path.dirname(expectedEntry), "dist/infra/sqlite-store.worker.js"),
  ).href;
  const backendEntry = pathToFileURL(
    path.join(path.dirname(expectedEntry), "dist/state/openclaw-state.worker.js"),
  ).href;
  const fd = fs.openSync(path.join(directory, "events.jsonl"), "wx");
  let count = 0;
  let dropped = 0;
  let claimed = false;
  let closed = false;
  const errors = [];
  const write = (event, final = false) => {
    if (!final && count++ >= 512) {
      dropped++;
      return;
    }
    try {
      fs.writeSync(
        fd,
        JSON.stringify({ monotonicUs: Number(process.hrtime.bigint() / 1000n), ...event }) + "\n",
      );
    } catch {
      if (!errors.length) {
        errors.push("Observer event write failed");
      }
    }
  };
  write({
    event: "attachment",
    pid: process.pid,
    parentPid: process.ppid,
    threadId: 0,
    entry: expectedEntry,
    workerEntry,
    backendEntry,
    node: process.version,
    timeOrigin: performance.timeOrigin,
    performanceMs: performance.now(),
  });
  const OriginalWorker = workerThreads.Worker;
  const filenameUrl = (filename) =>
    filename instanceof URL
      ? filename.href
      : typeof filename === "string" && path.isAbsolute(filename)
        ? pathToFileURL(filename).href
        : undefined;
  workerThreads.Worker = new Proxy(OriginalWorker, {
    construct(target, args, newTarget) {
      if (claimed || filenameUrl(args[0]) !== workerEntry) {
        return Reflect.construct(target, args, newTarget);
      }
      // The inspected installed broker deliberately sets []; do not silently broaden another caller.
      const options = args[1];
      if (!options || !Array.isArray(options.execArgv) || options.execArgv.length !== 0) {
        write({ event: "target-refused", reason: "Unexpected installed worker execArgv" });
        return Reflect.construct(target, args, newTarget);
      }
      claimed = true;
      const execArgv = ["--cpu-prof", `--cpu-prof-dir=${directory}`, "--cpu-prof-interval=1000"];
      const nextOptions = Object.create(Object.getPrototypeOf(options), {
        ...Object.getOwnPropertyDescriptors(options),
        execArgv: { value: execArgv, enumerable: true, writable: true, configurable: true },
      });
      write({ event: "construct-start" });
      let worker;
      try {
        worker = Reflect.construct(target, [args[0], nextOptions, ...args.slice(2)], newTarget);
      } catch (error) {
        write({ event: "construct-throw" });
        throw error;
      }
      const threadId = worker.threadId;
      write({ event: "created", threadId, execArgv });
      const postMessage = worker.postMessage;
      Object.defineProperty(worker, "postMessage", {
        configurable: true,
        writable: true,
        value(...messageArgs) {
          const message = messageArgs[0];
          if (message && typeof message === "object") {
            write({
              event: "send",
              threadId,
              id: message.id,
              type: message.type,
              actor: message.actor,
              ...(message.type === "open"
                ? { expectedBackend: message.moduleUrl === backendEntry }
                : {}),
            });
          }
          try {
            return Reflect.apply(postMessage, this, messageArgs);
          } catch (error) {
            write({ event: "send-throw", threadId });
            throw error;
          }
        },
      });
      worker.once("online", () => write({ event: "online", threadId }));
      worker.on("message", (reply) => {
        if (reply && typeof reply === "object") {
          write({
            event: "reply",
            threadId,
            id: reply.id,
            ok: reply.ok,
            transfer: reply.transfer,
            input: reply.input,
          });
        }
      });
      worker.on(errorMonitor, () => write({ event: "worker-error", threadId }));
      worker.once("exit", (code) => write({ event: "worker-exit", threadId, code }));
      return worker;
    },
  });
  syncBuiltinESMExports();
  process.once("exit", (code) => {
    if (closed) {
      return;
    }
    closed = true;
    write({ event: "observer-exit", code, claimed, dropped, errors }, true);
    fs.closeSync(fd);
  });
}
