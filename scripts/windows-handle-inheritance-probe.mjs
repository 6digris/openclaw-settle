// Diagnostic only: a controlled inheritance window, not a reproduction of a historical CI race.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData, threadId } from "node:worker_threads";

const SELF = fileURLToPath(import.meta.url);
const BUDGET = 5_000;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const PIPE_BROKEN = 109;
const INVALID_HANDLE_STATUS = 0xc0000008;
const mode = workerData?.mode ?? process.argv[2];
const role = workerData?.role ?? process.argv[3];
const jobName = workerData?.jobName ?? process.argv[4];

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function bounded(promise, deadline, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label}: deadline expired`)),
        Math.max(0, deadline - Date.now()),
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function native() {
  const { default: koffi } = await import("koffi");
  const { createWindowsJobBindings } =
    await import("../src/process/supervisor/service-child-windows-job-native.ts");
  const api = createWindowsJobBindings(koffi);
  api.assertLayouts();
  const kernel = koffi.load("kernel32.dll");
  const ntdll = koffi.load("ntdll.dll");
  const outDword = koffi.out(koffi.pointer("uint32_t"));
  const OpenProcess = kernel.func("__stdcall", "OpenProcess", "void *", [
    "uint32_t",
    "int32_t",
    "uint32_t",
  ]);
  const GetProcessId = kernel.func("__stdcall", "GetProcessId", "uint32_t", ["void *"]);
  const GetProcessTimes = kernel.func("__stdcall", "GetProcessTimes", "int32_t", [
    "void *",
    "void *",
    "void *",
    "void *",
    "void *",
  ]);
  const GetFileType = kernel.func("__stdcall", "GetFileType", "uint32_t", ["void *"]);
  const SetLastError = kernel.func("__stdcall", "SetLastError", "void", ["uint32_t"]);
  const QueryObject = ntdll.func("__stdcall", "NtQueryObject", "int32_t", [
    "void *",
    "uint32_t",
    "void *",
    "uint32_t",
    outDword,
  ]);
  const WriteFile = kernel.func("__stdcall", "WriteFile", "int32_t", [
    "void *",
    "void *",
    "uint32_t",
    outDword,
    "void *",
  ]);
  const identity = (handle) => {
    const created = Buffer.alloc(8);
    if (!GetProcessTimes(handle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8))) {
      throw api.lastError("GetProcessTimes");
    }
    const pid = GetProcessId(handle);
    assert(pid > 0 && created.readBigUInt64LE() > 0n, "missing process identity");
    return { pid, created: created.readBigUInt64LE().toString() };
  };
  const self = () => ({ ...identity(api.GetCurrentProcess()), threadId });
  const pin = (child, expected) => {
    assert.equal(child.pid, expected.pid, "IPC child PID differs from spawned PID");
    const handle = api.requireHandle(
      OpenProcess(0x0010_1101, 0, child.pid),
      "OpenProcess(owned child)",
    );
    try {
      assert.deepEqual(
        identity(handle),
        { pid: expected.pid, created: expected.created },
        "child creation identity differs",
      );
      assert.equal(
        api.WaitForSingleObject(handle, 0),
        WAIT_TIMEOUT,
        "child exited before admission",
      );
      return handle;
    } catch (error) {
      api.CloseHandle(handle);
      throw error;
    }
  };
  const objectName = async (handle) => {
    // Only query file/pipe names. A coincident process-local number is never authority.
    SetLastError(0);
    const type = GetFileType(handle);
    if (type === 0) {
      const code = api.getLastErrorCode();
      assert(code === 0 || code === 6, `GetFileType could not qualify handle: ${code}`);
      return { name: null, reason: code === 6 ? "invalid-handle" : "unknown-file-type" };
    }
    if (type !== 3) return { name: null, reason: "not-a-pipe" };
    const buffer = Buffer.alloc(131_072);
    const returned = [0];
    const result = await new Promise((resolve, reject) => {
      QueryObject.async(handle, 1, buffer, buffer.length, returned, (error, value) =>
        error ? reject(error) : resolve(value),
      );
    });
    if (result >>> 0 === INVALID_HANDLE_STATUS) return { name: null, reason: "invalid-handle" };
    assert(result >= 0, `NtQueryObject failed: 0x${(result >>> 0).toString(16)}`);
    assert(returned[0] >= 16 && returned[0] <= buffer.length, "invalid object-name result size");
    const length = buffer.readUInt16LE(0);
    const pointer = buffer.readBigUInt64LE(8);
    const offset = pointer - koffi.address(buffer);
    assert(
      length > 0 &&
        length % 2 === 0 &&
        offset >= 16n &&
        offset + BigInt(length) <= BigInt(buffer.length),
      "object name is not contained in its result buffer",
    );
    const name = buffer.toString("utf16le", Number(offset), Number(offset) + length);
    assert(name.startsWith("\\Device\\NamedPipe\\"), "unexpected pipe object namespace");
    return { name };
  };
  const qualify = async (descriptor) => {
    const observed = await objectName(BigInt(descriptor.handle));
    return {
      ...descriptor,
      observed: observed.name,
      reason: observed.reason,
      matched: observed.name === descriptor.name,
    };
  };
  const close = (handle, label) => {
    if (!api.CloseHandle(handle)) throw api.lastError(`CloseHandle(${label})`);
  };
  const waitProcess = async (handle, deadline) => {
    const remaining = Math.max(0, deadline - Date.now());
    const result = await new Promise((resolve, reject) => {
      api.WaitForSingleObject.async(handle, remaining, (error, value) =>
        error ? reject(error) : resolve(value),
      );
    });
    assert.equal(result, WAIT_OBJECT_0, "native process exit was not observed within budget");
    const code = [0];
    if (!api.GetExitCodeProcess(handle, code)) throw api.lastError("GetExitCodeProcess");
    return code[0];
  };
  const createJob = () => {
    const name = `Local\\OpenClawInheritanceProbe-${randomUUID()}`;
    const handle = api.requireHandle(api.CreateJobObjectW(null, name), "CreateJobObjectW");
    try {
      assert.notEqual(api.getLastErrorCode(), 183, "random Job name already existed");
      if (!api.SetExtendedLimits(handle, 9, api.extendedLimits, api.extendedLimitsSize))
        throw api.lastError("SetInformationJobObject");
      return { name, handle };
    } catch (error) {
      close(handle, "failed Job setup");
      throw error;
    }
  };
  const assign = (job, processHandle) => {
    if (!api.AssignProcessToJobObject(job, processHandle))
      throw api.lastError("AssignProcessToJobObject");
  };
  const readPipe = (handle) => {
    const available = [0];
    if (!api.PeekNamedPipe(handle, null, 0, null, available, null)) {
      const code = api.getLastErrorCode();
      assert.equal(code, PIPE_BROKEN, `unexpected PeekNamedPipe failure ${code}`);
      return { eof: true, bytes: "" };
    }
    assert(available[0] <= 4096, "unexpected diagnostic output size");
    if (!available[0]) return { eof: false, bytes: "" };
    const bytes = Buffer.alloc(available[0]);
    const count = [0];
    if (!api.ReadFile(handle, bytes, bytes.length, count, null))
      throw api.lastError("ReadFile(available diagnostic bytes)");
    assert.equal(count[0], bytes.length, "short diagnostic read");
    return { eof: false, bytes: bytes.toString("utf8") };
  };
  return {
    api,
    self,
    pin,
    identity,
    objectName,
    qualify,
    close,
    waitProcess,
    createJob,
    assign,
    readPipe,
    WriteFile,
  };
}

function peer(endpoint, send, label) {
  let next = 0;
  const pending = new Map();
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const failed = (error) => {
    rejectReady(error);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  endpoint.on("message", (message) => {
    if (message?.kind === "ready") resolveReady(message.value);
    if (message?.kind !== "reply") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`${label}: ${message.error}`));
    else waiter.resolve(message.value);
  });
  endpoint.on("error", failed);
  // Child exit may precede its last queued IPC reply; close joins that channel.
  endpoint.once(endpoint instanceof Worker ? "exit" : "close", () =>
    failed(new Error(`${label} exited`)),
  );
  return {
    ready,
    call(action, value = {}, deadline = Date.now() + BUDGET) {
      const id = ++next;
      const response = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          send({ kind: "request", id, action, value });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
      return bounded(response, deadline, `${label}/${action}`).finally(() => pending.delete(id));
    },
  };
}

function trackChild(child) {
  const output = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"]) {
    child[stream]?.on("data", (chunk) => {
      output[stream] = (output[stream] + chunk.toString()).slice(-8192);
    });
  }
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const rpc = peer(child, (message) => child.send(message), `child ${child.pid}`);
  return { child, output, closed, rpc };
}

async function serve(n, handler) {
  const endpoint = isMainThread ? process : parentPort;
  const send = (message) =>
    isMainThread
      ? new Promise((resolve, reject) =>
          process.send(message, (error) => (error ? reject(error) : resolve())),
        )
      : Promise.resolve(parentPort.postMessage(message));
  let admitted = false;
  let sequence = Promise.resolve();
  endpoint.on("message", (message) => {
    if (message?.kind !== "request") return;
    sequence = sequence
      .then(async () => {
        try {
          if (message.action === "admit") admitted = true;
          else assert(admitted, "operation before process/Job admission");
          const value =
            message.action === "admit" ? n.self() : await handler(message.action, message.value);
          await send({ kind: "reply", id: message.id, value });
          if (message.action === "shutdown") {
            if (isMainThread) process.disconnect();
            else parentPort.close();
          }
        } catch (error) {
          await send({ kind: "reply", id: message.id, error: errorText(error) });
        }
      })
      .catch((error) => {
        console.error(errorText(error));
        process.exitCode = 1;
      });
  });
  await send({ kind: "ready", value: n.self() });
}

async function sentinel(n) {
  let descriptors = [];
  let qualified = [];
  await serve(n, async (action, value) => {
    if (action === "qualify") {
      assert.equal(descriptors.length, 0, "qualification already performed");
      descriptors = value.descriptors;
      qualified = await Promise.all(descriptors.map(n.qualify));
      return qualified;
    }
    if (action === "write") {
      const results = [];
      for (const descriptor of qualified.filter((item) => item.matched)) {
        assert((await n.qualify(descriptor)).matched, "foreign pipe identity changed before write");
        const bytes = Buffer.from(`${value.nonce}:${descriptor.stream}\n`);
        const written = [0];
        if (!n.WriteFile(BigInt(descriptor.handle), bytes, bytes.length, written, null))
          throw n.api.lastError("WriteFile(qualified foreign writer)");
        assert.equal(written[0], bytes.length);
        results.push(descriptor.stream);
      }
      return { written: results, alive: n.self() };
    }
    if (action === "release") {
      const released = [];
      for (const descriptor of qualified.filter((item) => item.matched)) {
        assert((await n.qualify(descriptor)).matched, "foreign pipe identity changed before close");
        n.close(BigInt(descriptor.handle), `qualified foreign ${descriptor.stream}`);
        descriptor.matched = false;
        released.push(descriptor.stream);
      }
      return { released, alive: n.self() };
    }
    if (action === "alive") return n.self();
    throw new Error(`unsupported sentinel action ${action}`);
  });
}

function quoteWindows(value) {
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1")}"`;
}

async function actor(n) {
  const job = n.api.requireHandle(
    n.api.OpenJobObjectW(0x002d, 0, jobName),
    "OpenJobObjectW(actor)",
  );
  let stdio;
  let descriptors;
  let outputHandles;
  let childHandle;
  let childIdentity;
  let foreign;
  await serve(n, async (action, value) => {
    if (action === "create" && role === "A") {
      assert(!stdio, "pipe fixture already exists");
      stdio = n.api.createCommandStdio();
      outputHandles = stdio.takeOutputReadHandles();
      descriptors = await Promise.all(
        [
          { stream: "stdout", handle: stdio.stdoutWriteHandle.toString() },
          { stream: "stderr", handle: stdio.stderrWriteHandle.toString() },
        ].map(async (item) => {
          const { name } = await n.objectName(BigInt(item.handle));
          assert(name, "created pipe has no qualified native name");
          return { ...item, name };
        }),
      );
      assert.notEqual(
        descriptors[0].name,
        descriptors[1].name,
        "pipe names must distinguish endpoints",
      );
      return { descriptors, actor: n.self() };
    }
    if (action === "spawn" && role === "B") {
      assert(!foreign, "sentinel already exists");
      foreign = trackChild(
        spawn(process.execPath, [...process.execArgv, SELF, "--sentinel"], {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          windowsHide: true,
        }),
      );
      const ready = await bounded(foreign.rpc.ready, Date.now() + BUDGET, "sentinel ready");
      childHandle = n.pin(foreign.child, ready);
      childIdentity = n.identity(childHandle);
      n.assign(job, childHandle);
      await foreign.rpc.call("admit");
      const qualification = await foreign.rpc.call("qualify", { descriptors: value.descriptors });
      return { qualification, sentinel: ready, jobPids: n.api.readJobProcessIds(job) };
    }
    if (action === "launch" && role === "A") {
      assert(stdio && !childHandle, "A launch requires its unreleased pipe fixture");
      for (const descriptor of descriptors)
        assert((await n.qualify(descriptor)).matched, "A's own pipe identity changed");
      const attributes = n.api.createProcessAttributeList(stdio.inheritedHandles, job);
      const info = {};
      try {
        const commandLine = Buffer.from(
          [process.execPath, "-e", "process.exit(0)"].map(quoteWindows).join(" ") + "\0",
          "utf16le",
        );
        if (
          !n.api.CreateProcessW(
            process.execPath,
            commandLine,
            null,
            null,
            1,
            0x0808_0400,
            null,
            process.cwd(),
            {
              StartupInfo: {
                cb: n.api.startupInfoExSize,
                dwFlags: 0x100,
                hStdInput: stdio.stdinHandle,
                hStdOutput: stdio.stdoutWriteHandle,
                hStdError: stdio.stderrWriteHandle,
              },
              lpAttributeList: attributes.attributeList,
            },
            info,
          )
        )
          throw n.api.lastError("CreateProcessW(A with HANDLE_LIST/JOB_LIST)");
        childHandle = n.api.requireHandle(info.hProcess, "A process handle");
        n.close(n.api.requireHandle(info.hThread, "A thread handle"), "A thread");
        childIdentity = n.identity(childHandle);
        assert.equal(childIdentity.pid, Number(info.dwProcessId));
      } finally {
        attributes.release();
        stdio.closeChildHandles();
      }
      const exitCode = await n.waitProcess(childHandle, Date.now() + BUDGET);
      assert.equal(exitCode, 0, "A's short command must exit successfully");
      const jobPids = n.api.readJobProcessIds(job);
      assert.deepEqual(jobPids, [], "A Job still contains processes");
      return { identity: childIdentity, exitCode, jobPids };
    }
    if (action === "snapshot" && role === "A") {
      assert(childHandle && outputHandles, "snapshot before A launch");
      assert.equal(n.api.WaitForSingleObject(childHandle, 0), WAIT_OBJECT_0);
      assert.deepEqual(n.api.readJobProcessIds(job), []);
      return {
        stdout: n.readPipe(outputHandles.stdoutReadHandle),
        stderr: n.readPipe(outputHandles.stderrReadHandle),
      };
    }
    if (action === "sentinel" && role === "B") {
      assert(foreign && childHandle, "sentinel not admitted");
      assert.deepEqual(n.identity(childHandle), childIdentity);
      assert.equal(
        n.api.WaitForSingleObject(childHandle, 0),
        WAIT_TIMEOUT,
        "sentinel must remain alive",
      );
      const result = await foreign.rpc.call(value.action, value.value);
      assert.equal(
        n.api.WaitForSingleObject(childHandle, 0),
        WAIT_TIMEOUT,
        "sentinel exited during gate",
      );
      return result;
    }
    if (action === "shutdown") {
      // The coordinator terminates only its retained Jobs before asking actors to join.
      if (childHandle) await n.waitProcess(childHandle, value.deadline);
      if (foreign) {
        await bounded(foreign.closed, value.deadline, "sentinel close/output settlement");
        assert(
          foreign.child.stdout.closed && foreign.child.stderr.closed,
          "sentinel output remains open",
        );
      }
      assert.deepEqual(n.api.readJobProcessIds(job), [], "actor Job is not empty at cleanup");
      if (stdio) stdio.close();
      if (outputHandles) {
        for (const descriptor of descriptors) {
          const handle = outputHandles[`${descriptor.stream}ReadHandle`];
          assert.equal(
            (await n.objectName(handle)).name,
            descriptor.name,
            "A read endpoint identity changed before cleanup",
          );
          n.close(handle, `A ${descriptor.stream} read`);
        }
      }
      if (childHandle) n.close(childHandle, "retained child process");
      n.close(job, "actor Job reference");
      return { joined: true, childIdentity, output: foreign?.output };
    }
    throw new Error(`unsupported ${role} action ${action}`);
  });
}

async function runArm(n, arm, record) {
  const jobs = { A: n.createJob(), B: n.createJob() };
  const actors = [];
  let result;
  let failure;
  try {
    record({
      arm,
      stage: "arm-start",
      coordinator: n.self(),
      jobs: { A: jobs.A.name, B: jobs.B.name },
    });
    // Both actor parents exist and acknowledge readiness before any inheritable pipe is made.
    for (const actorRole of ["A", "B"]) {
      let actor;
      if (arm === "threads") {
        const worker = new Worker(SELF, {
          workerData: { mode: "--actor", role: actorRole, jobName: jobs[actorRole].name },
        });
        actor = {
          role: actorRole,
          endpoint: worker,
          rpc: peer(worker, (message) => worker.postMessage(message), `worker ${actorRole}`),
          exited: new Promise((resolve) => worker.once("exit", resolve)),
        };
      } else {
        const actorJob = n.createJob();
        const tracked = trackChild(
          spawn(
            process.execPath,
            [...process.execArgv, SELF, "--actor", actorRole, jobs[actorRole].name],
            { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true },
          ),
        );
        actor = {
          role: actorRole,
          endpoint: tracked.child,
          rpc: tracked.rpc,
          exited: tracked.closed,
          tracked,
          actorJob,
        };
      }
      actors.push(actor);
    }
    const readiness = await Promise.all(
      actors.map((item) =>
        bounded(item.rpc.ready, Date.now() + BUDGET, `${arm}/${item.role} ready`),
      ),
    );
    for (let index = 0; index < actors.length; index++) {
      const actor = actors[index];
      if (actor.tracked) {
        actor.handle = n.pin(actor.endpoint, readiness[index]);
        n.assign(actor.actorJob.handle, actor.handle);
      }
      await actor.rpc.call("admit");
    }
    record({ arm, stage: "actors-ready-before-handles", actors: readiness });
    assert.equal(
      readiness[0].pid === readiness[1].pid,
      arm === "threads",
      "actor process boundary differs from selected arm",
    );
    const [a, b] = actors;
    const created = await a.rpc.call("create");
    record({ arm, stage: "pipes-created", ...created });
    const spawned = await b.rpc.call("spawn", { descriptors: created.descriptors });
    record({ arm, stage: "foreign-qualification", ...spawned });
    const matched = spawned.qualification.filter((item) => item.matched);
    assert.equal(matched.length, arm === "threads" ? 2 : 0, "unexpected inherited endpoint set");
    const exited = await a.rpc.call("launch");
    record({ arm, stage: "A-exited-and-Job-empty", ...exited });
    const before = await a.rpc.call("snapshot");
    record({ arm, stage: "before-foreign-release", pipes: before });
    const nonce = randomUUID();
    const written = await b.rpc.call("sentinel", { action: "write", value: { nonce } });
    record({ arm, stage: "foreign-write", ...written });
    const observed = await a.rpc.call("snapshot");
    for (const stream of ["stdout", "stderr"]) {
      assert.equal(before[stream].bytes, "");
      assert.equal(
        before[stream].eof,
        arm === "processes",
        "EOF must reflect actual foreign writer lifetime",
      );
      assert.equal(
        observed[stream].bytes,
        arm === "threads" ? `${nonce}:${stream}\n` : "",
        "pipe nonce differs",
      );
      assert.equal(observed[stream].eof, arm === "processes");
    }
    record({ arm, stage: "nonce-observed", pipes: observed });
    const released = await b.rpc.call("sentinel", { action: "release" });
    record({ arm, stage: "foreign-writers-closed-sentinel-alive", ...released });
    const after = await a.rpc.call("snapshot");
    for (const stream of ["stdout", "stderr"])
      assert.deepEqual(after[stream], { eof: true, bytes: "" });
    const stillAlive = await b.rpc.call("sentinel", { action: "alive" });
    record({ arm, stage: "EOF-with-sentinel-still-alive", pipes: after, sentinel: stillAlive });
    result = { arm, foreignWriters: matched.length, nonceVerified: true, eofVerified: true };
  } catch (error) {
    failure = error;
    record({ arm, stage: "control-failed", error: errorText(error) });
  } finally {
    const deadline = Date.now() + BUDGET;
    const cleanupErrors = [];
    for (const job of Object.values(jobs)) {
      try {
        if (n.api.readJobProcessIds(job.handle).length && !n.api.TerminateJobObject(job.handle, 1))
          throw n.api.lastError("TerminateJobObject(owned diagnostic children)");
      } catch (error) {
        cleanupErrors.push(errorText(error));
      }
    }
    const joined = await Promise.allSettled(
      actors.map(async (actor) => {
        const receipt = await actor.rpc.call("shutdown", { deadline }, deadline);
        const exit = await bounded(actor.exited, deadline, `join ${arm}/${actor.role}`);
        if (actor.tracked)
          assert.deepEqual(exit, { code: 0, signal: null }, "actor did not exit cleanly");
        else assert.equal(exit, 0, "worker did not exit cleanly");
        if (actor.handle) {
          await n.waitProcess(actor.handle, deadline);
          assert(
            actor.endpoint.stdout.closed && actor.endpoint.stderr.closed,
            "actor pipes remain open",
          );
          assert.deepEqual(n.api.readJobProcessIds(actor.actorJob.handle), []);
          n.close(actor.handle, "actor process");
          actor.handle = undefined;
        }
        return { role: actor.role, receipt, exit };
      }),
    );
    for (const outcome of joined)
      if (outcome.status === "rejected") cleanupErrors.push(errorText(outcome.reason));
    for (const actor of actors) {
      if (!actor.actorJob) continue;
      try {
        const survivors = n.api.readJobProcessIds(actor.actorJob.handle);
        if (survivors.length) {
          cleanupErrors.push(`actor ${actor.role} remains in owned Job: ${survivors.join(",")}`);
          if (!n.api.TerminateJobObject(actor.actorJob.handle, 1))
            throw n.api.lastError("TerminateJobObject(unjoined actor)");
        }
        n.close(actor.actorJob.handle, "actor Job");
        if (actor.handle) n.close(actor.handle, "unjoined actor retained process");
      } catch (error) {
        cleanupErrors.push(errorText(error));
      }
    }
    for (const job of Object.values(jobs)) {
      try {
        const survivors = n.api.readJobProcessIds(job.handle);
        if (survivors.length) cleanupErrors.push(`owned Job still contains ${survivors.join(",")}`);
        n.close(job.handle, "coordinator Job");
      } catch (error) {
        cleanupErrors.push(errorText(error));
      }
    }
    record({
      arm,
      stage: "cleanup",
      budgetMs: BUDGET,
      confirmed: cleanupErrors.length === 0,
      joined: joined.map((item) =>
        item.status === "fulfilled" ? item.value : { error: errorText(item.reason) },
      ),
      actorOutput: actors
        .filter((item) => item.tracked)
        .map((item) => ({ role: item.role, ...item.tracked.output })),
      errors: cleanupErrors,
    });
    if (cleanupErrors.length)
      failure = new AggregateError(
        [failure, ...cleanupErrors].filter(Boolean),
        "diagnostic cleanup is unconfirmed; retain all evidence",
      );
  }
  if (failure) throw failure;
  return result;
}

async function main() {
  const directory = process.argv[2];
  assert(directory && path.isAbsolute(directory), "supply an absolute task-owned output directory");
  fs.mkdirSync(directory, { recursive: true });
  const log = path.join(directory, "handle-inheritance-receipts.jsonl");
  const fd = fs.openSync(log, "wx", 0o600);
  const record = (value) => {
    const line = JSON.stringify({ time: new Date().toISOString(), ...value });
    fs.writeSync(fd, `${line}\n`);
    console.log(line);
  };
  let exitCode = 1;
  try {
    assert.equal(process.platform, "win32", "native Windows is required");
    record({
      stage: "start",
      node: process.version,
      versions: process.versions,
      execPath: process.execPath,
      cleanupBudgetMs: BUDGET,
      scope: "Controlled dependency mechanism; no historical root-cause claim",
    });
    assert.equal(
      process.version,
      "v24.19.0",
      "this control targets the retained Node 24.19.0 dependency sources",
    );
    const n = await native();
    const results = [];
    for (const arm of ["threads", "processes"]) results.push(await runArm(n, arm, record));
    record({
      stage: "outcome",
      outcome: "shared-process-inheritance-demonstrated-and-separate-process-control-clean",
      results,
    });
    exitCode = 0;
  } catch (error) {
    record({
      stage: "outcome",
      outcome: "failed-or-unqualified",
      error: errorText(error),
      details: error instanceof AggregateError ? error.errors.map(errorText) : undefined,
      retainEvidence: true,
    });
  } finally {
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  }
  // An uncertain thread cleanup must not turn into a successful or indefinitely running probe.
  // Process exit releases only this diagnostic process's retained handles; receipts say unconfirmed.
  process.exit(exitCode);
}

if (mode === "--actor" || mode === "--sentinel") {
  try {
    assert.equal(process.platform, "win32");
    const n = await native();
    if (mode === "--sentinel") await sentinel(n);
    else await actor(n);
  } catch (error) {
    console.error(errorText(error));
    process.exitCode = 1;
    if (isMainThread && process.connected) process.disconnect();
    else parentPort?.close();
  }
} else {
  await main();
}
