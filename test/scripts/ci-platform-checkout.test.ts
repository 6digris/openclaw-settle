import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeAll, expect, it, vi } from "vitest";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { isProcessAlive, waitForDead } from "../helpers/process-wait.js";
import {
  ciCheckoutFixture,
  expectCiCheckoutCleanup,
  projectWindowsCheckoutDiagnostics,
  readCiCheckoutStep,
  renderGitTestClock,
  withCiCheckoutFixture,
} from "./ci-checkout.test-support.js";
import { runCiGitStep } from "./ci-git-owner.test-support.js";
import {
  censusPreload,
  expectCensusClosed,
  registerWindowsCensusTests,
} from "./ci-windows-process-census.test-support.js";

// Each case owns its checkout and process trees. Overlap their real deadline
// and drain waits while keeping subprocess pressure bounded within one worker.
beforeAll(() => {
  vi.setConfig({ maxConcurrency: 2 });
  return () => vi.resetConfig();
});

it("bounds and redacts Windows checkout observations without changing cleanup evidence", () => {
  const sample = {
    emitter: "census",
    phase: "sample",
    sequence: 1,
    pid: 101,
    alive: true,
    creationTime: "5001",
    start: "10",
    end: "12",
    frequency: "1000",
    clockError: null,
    waitResult: 258,
    openError: null,
    inJob: null,
    membershipError: null,
    diagnosticError: false,
    python: [3, 13, 7],
    request: { callerPid: 202, purpose: "exit", start: "30", end: "40" },
  };
  const complete = {
    status: "complete",
    records: [sample],
    runtime: { node: "24.21.0", windowsKernel: "10.0.26100" },
  };
  expect(projectWindowsCheckoutDiagnostics(complete)).toEqual(complete);
  const missingFrequency = { ...complete, records: [{ ...sample, frequency: null }] };
  expect(projectWindowsCheckoutDiagnostics(missingFrequency)).toEqual({
    ...missingFrequency,
    status: "unavailable",
  });
  for (const records of [
    [{ ...sample, commandLine: "PRIVATE_CANARY" }],
    [{ ...sample, creationTime: "PRIVATE_CANARY" }],
    [{ ...sample, request: { ...sample.request, purpose: "PRIVATE_CANARY" } }],
    [{ ...sample, waitResult: -1 }],
    [{ ...sample, alive: false }],
  ]) {
    const projected = projectWindowsCheckoutDiagnostics({ ...complete, records });
    expect(projected).toEqual({ status: "invalid", records: [] });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_CANARY");
  }
  expect(
    projectWindowsCheckoutDiagnostics({
      ...complete,
      records: Array.from({ length: 513 }, () => ({ ...sample })),
    }),
  ).toEqual({ status: "invalid", records: [] });
  expect(
    projectWindowsCheckoutDiagnostics({ ...complete, private: "x".repeat(512 * 1024) }),
  ).toEqual({ status: "overflow", records: [] });
  for (const status of ["missing", "invalid", "overflow", "unavailable"]) {
    expect(projectWindowsCheckoutDiagnostics({ status, records: [] })).toEqual({
      status,
      records: [],
    });
  }
  expect(
    projectWindowsCheckoutDiagnostics({
      ...complete,
      records: [{ ...sample, membershipError: 5 }],
    }).status,
  ).toBe("unavailable");
  const report = {
    code: 124,
    cancelledDuringCleanup: false,
    readyAttempts: [],
    commands: [],
    output: "",
    cleanupRemaining: [],
    ownedProcesses: [],
    boundaries: [
      {
        name: "exit",
        alive: [{ pid: 101, role: "parent", attempt: 2, instance: "owned" }],
        sentinelAlive: true,
      },
    ],
    windowsDiagnostics: projectWindowsCheckoutDiagnostics(complete),
  };
  expect(() => expectCiCheckoutCleanup(report)).toThrow(
    "Git descendants survived BEFORE deletion, reuse, consumption, or exit",
  );
});

it("renders Windows observations only into the reviewed private owner", () => {
  const source = readFileSync(".github/actions/git-owner/owner.py", "utf8");
  const options = {
    realClock: true,
    windowsDiagnosticsRoot: String.raw`C:\checkout proof\owner's directory\case`,
    windowsMembershipProbe: true,
  };
  const shell = renderGitTestClock(readCiCheckoutStep("checks-windows").run, options);
  const embedded = expectDefined(
    /^run_owner '([\s\S]*?)'\n# End generated CI Git owner\.$/mu.exec(shell)?.[1],
    "generated Python command argument",
  );
  const rendered = embedded.replaceAll("'\\''", "'");
  expect(rendered).toBe(renderGitTestClock(source, options));
  const compiled = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-I",
      "-S",
      "-c",
      String.raw`import ast, subprocess, sys
source = sys.stdin.read()
compile(source, "<private-owner>", "exec")
calls = [node for node in ast.walk(ast.parse(source)) if isinstance(node, ast.Call)
         and isinstance(node.func, ast.Subscript)
         and isinstance(node.func.value, ast.Name) and node.func.value.id == "_ci_observer"]
assert len(calls) == 2 and all(ast.literal_eval(call.args[1]) == sys.argv[1] for call in calls)
assert {ast.literal_eval(call.func.slice) for call in calls} == {"install_owner_observer", "install_membership_probe"}
command_line = subprocess.list2cmdline([r"C:\Program Files\Python\python.exe", "-I", "-S", "-c", source])
print(len(command_line.encode("utf-16-le")) // 2 + 1)
`,
      options.windowsDiagnosticsRoot,
    ],
    { input: rendered, encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024 },
  );
  expect(compiled.error, compiled.stderr).toBeUndefined();
  expect(compiled.status, compiled.stderr).toBe(0);
  expect(
    Number(compiled.stdout),
    "CRT-formatted launch-size model, not captured MSYS argv (UTF-16 units including NUL)",
  ).toBeLessThanOrEqual(32_767);
  expect(renderGitTestClock(source, { realClock: true })).toBe(source);
  expect(() =>
    renderGitTestClock(source + "\n", { windowsDiagnosticsRoot: "fixture-owned" }),
  ).toThrow("Windows diagnostic owner rendering drift");
});

it("keeps Windows observation handles transient and preserves the original owner exception", () => {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-I",
      "-S",
      "-c",
      String.raw`
import contextlib, ctypes as c, io, json, os, pathlib, runpy, sys, tempfile, types
scope = runpy.run_path(sys.argv[1])
state = dict(error=0, clock=0, fail_membership=False)
handles = set()
def failure(code):
    error = OSError(code, "native fixture failure")
    error.winerror = code
    return error
c.get_last_error = lambda: state["error"]
c.set_last_error = lambda value: state.update(error=value)
c.WinError = failure
class Function:
    def __init__(self, callback): self.callback = callback
    def __call__(self, *args):
        result = self.callback(*args)
        return self.errcheck(result, self, args) if hasattr(self, "errcheck") else result
def opened(access, inherit, pid):
    assert access == 0x1000 | 0x100000 and not inherit
    if pid == 999:
        state["error"] = 87
        return 0
    handles.add(pid)
    return pid
def closed(handle):
    handles.remove(handle)
    return 1
def wait(handle, timeout):
    assert handle in handles and timeout == 0
    return 0 if handle == 102 else 258
def times(handle, *values):
    assert handle in handles
    values[0]._obj.dwHighDateTime, values[0]._obj.dwLowDateTime = 0, handle * 10
    return 1
def clock(value):
    state["clock"] += 1
    if state.pop("fail_clock_once", False):
        state["error"] = 6
        return 0
    value._obj.value = state["clock"]
    return 1
def frequency(value):
    value._obj.value = 1000
    return 1
def membership(handle, job, value):
    assert handle in handles and job == 77
    if state["fail_membership"]:
        state["error"] = 5
        return 0
    value._obj.value = int(handle == 101)
    return 1
kernel = types.SimpleNamespace(**{name: Function(callback) for name, callback in {
    "OpenProcess": opened, "CloseHandle": closed, "WaitForSingleObject": wait,
    "GetProcessTimes": times, "IsProcessInJob": membership,
    "QueryPerformanceCounter": clock, "QueryPerformanceFrequency": frequency,
}.items()})
c.WinDLL = lambda *args, **kwargs: kernel
read = scope["read_processes"]
plain = read([101, 102, 999])
assert plain == [
    dict(pid=101, alive=True, creationTime="1010"),
    dict(pid=102, alive=False, creationTime="1020"),
    dict(pid=999, alive=False, creationTime=None),
]
observed = read([101, 102, 999], 7, 77)
assert [{k: v for k, v in row.items() if k != "native"} for row in observed] == plain
assert not handles
assert observed[0]["native"]["inJob"] is True
assert observed[1]["native"]["inJob"] is False
assert observed[2]["native"]["openError"] == 87
assert all(int(row["native"]["start"]) < int(row["native"]["end"]) for row in observed)
state.update(error=73, fail_membership=True)
sample = read([101], 8, 77)[0]["native"]
assert sample["membershipError"] == 5 and sample["waitResult"] == 258
assert state["error"] == 73 and not handles
state["fail_membership"] = False
for pid in (101, 999):
    state["fail_clock_once"] = True
    assert read([pid], 9, 77)[0]["native"]["clockError"] == 6
helper = pathlib.Path(sys.argv[1]).read_text()
original_argv, original_stdin = sys.argv, sys.stdin
for enabled in (False, True):
    output = io.StringIO()
    sys.stdin = io.StringIO('{"id":1,"pids":[101]}\n{"id":2,"pids":[102]}\n')
    sys.argv = [original_argv[1], *(["--checkout-diagnostics"] if enabled else [])]
    try:
        with contextlib.redirect_stdout(output):
            exec(compile(helper, "<fixture-census>", "exec"), {"__name__": "__main__"})
    finally:
        sys.argv, sys.stdin = original_argv, original_stdin
    ready, *replies = map(json.loads, output.getvalue().splitlines())
    assert ready == dict(ready=True)
    assert all(set(reply) == {"id", "observations"} for reply in replies)
    assert replies[0]["observations"][0]["alive"] is True
    assert replies[1]["observations"][0]["alive"] is False
    assert sum("python" in row.get("native", {}) for reply in replies for row in reply["observations"]) == int(enabled)
    assert all(("native" in row) == enabled for reply in replies for row in reply["observations"])
assert not handles

def requests():
    for sequence in range(1, 1025):
        before = state["clock"]
        yield json.dumps(dict(id=sequence, pids=[101])) + "\n"
        if sequence == 1024:
            assert state["clock"] == before, "overflow must stop diagnostic sampling"
output = io.StringIO()
sys.stdin, sys.argv = requests(), [original_argv[1], "--checkout-diagnostics"]
try:
    with contextlib.redirect_stdout(output):
        exec(compile(helper, "<fixture-census>", "exec"), {"__name__": "__main__"})
finally:
    sys.argv, sys.stdin = original_argv, original_stdin
ready, *replies = map(json.loads, output.getvalue().splitlines())
assert ready == dict(ready=True) and len(replies) == 1024 and not handles
assert all({k: v for k, v in reply["observations"][0].items() if k != "native"} == plain[0] for reply in replies)
assert any(reply["observations"][0].get("native", {}).get("phase") == "overflow" for reply in replies)
assert "native" not in replies[-1]["observations"][0]

class Accounting(c.Structure):
    _fields_ = [(name, c.c_uint32) for name in ("ActiveProcesses", "TotalProcesses", "TotalTerminatedProcesses")]
primary = failure(123)
namespace = dict(Accounting=Accounting, create_job=lambda *_: 77, close_handle=lambda _: 1)
def query(*args):
    accounting = args[2]._obj
    accounting.ActiveProcesses, accounting.TotalProcesses, accounting.TotalTerminatedProcesses = 0, 3, 3
    return 1
def drain(child, job):
    assert not handles, "observer handles must close before original drain"
    accounting = Accounting()
    namespace["query_job"](job, 1, c.byref(accounting), c.sizeof(accounting), None)
    assert not handles, "query observations retained a handle"
    raise primary
checked_query = Function(query)
checked_query.errcheck = lambda value, function, args: value
namespace.update(query_job=checked_query, drain=drain)
with tempfile.TemporaryDirectory(prefix="checkout-observation-") as directory:
    root = pathlib.Path(directory)
    (root / "pids").mkdir()
    for pid, role, attempt in [(101, "parent", 2), (104, "child", 2), (105, "grandchild", 2),
                               (103, "sentinel", 0), (106, "git", 0), (107, "shell", 0)]:
        (root / "pids" / f"{pid}.json").write_text(json.dumps(
            dict(pid=pid, role=role, attempt=attempt, instance=f"fixture-{pid}",
                 creationTime=str(pid * 10))))
    # Only this observer namespace sees the emulated Windows API, not the test host.
    scope["install_owner_observer"].__globals__["os"] = types.SimpleNamespace(
        name="nt", path=os.path, listdir=os.listdir, getpid=lambda: 202)
    scope["install_owner_observer"](namespace, directory)
    job = namespace["create_job"](None, None)
    complete_rows = [json.loads(line) for line in (root / "windows-owner-diagnostic.jsonl").read_text().splitlines()]
    try:
        namespace["drain"](types.SimpleNamespace(pid=102), job)
        raise AssertionError("original drain failure was suppressed")
    except OSError as error:
        assert error is primary
    namespace["close_handle"](job)
    rows = [json.loads(line) for line in (root / "windows-owner-diagnostic.jsonl").read_text().splitlines()]
    after = next(row for row in rows if row["phase"] == "after-drain")
    assert after["returnPath"] == "exception" and after["errorCode"] == 123
    assert after["ownerCreationTime"] == "2020" and after["bootstrap"]["creationTime"] == "1020"
    assert after["actors"][0]["native"]["inJob"] and not after["sentinel"]["native"]["inJob"]
    assert next(row for row in rows if row["phase"] == "accounting")["accounting"] == dict(result=1, active=0, total=3, terminated=3)
    assert not handles
    # A failed checked API exposes the original native zero and exact exception.
    checked_query.callback = lambda *args: 0
    def checked_failure(value, function, args):
        assert value == 0
        raise primary
    # The observer calls the retained original checker, not a replaced policy.
    scope["install_owner_observer"].__globals__["read_processes"] = read
    namespace2 = dict(Accounting=Accounting, create_job=lambda *_: 77, close_handle=lambda _: 1,
                      query_job=Function(lambda *args: 0), drain=drain)
    namespace2["query_job"].errcheck = checked_failure
    scope["install_owner_observer"](namespace2, directory)
    namespace2["create_job"](None, None)
    try: namespace2["query_job"](77, 1, c.byref(Accounting()), c.sizeof(Accounting), None)
    except OSError as error: assert error is primary
    else: raise AssertionError("native query exception suppressed")
    rows = [json.loads(line) for line in (root / "windows-owner-diagnostic.jsonl").read_text().splitlines()]
    assert rows[-1]["accounting"]["result"] == 0 and rows[-1]["errorCode"] == 123
    checked_query.callback = query
    # An observer read failure must be recorded, never replace the same primary error.
    def unavailable(*args): raise ValueError("PRIVATE_CANARY")
    scope["install_owner_observer"].__globals__["read_processes"] = unavailable
    try: namespace["drain"](types.SimpleNamespace(pid=102), job)
    except OSError as error: assert error is primary
    rows = [json.loads(line) for line in (root / "windows-owner-diagnostic.jsonl").read_text().splitlines()]
    assert rows[-1]["phase"] == "observation-error" and "PRIVATE_CANARY" not in json.dumps(rows)
    scope["install_owner_observer"].__globals__["read_processes"] = read
    for samples in (10, 1024):
        next_owner = dict(Accounting=Accounting, create_job=lambda *_: 77, close_handle=lambda _: 1,
                          query_job=Function(query), drain=lambda *_: None)
        next_owner["query_job"].errcheck = lambda value, function, args: value
        scope["install_owner_observer"](next_owner, directory)
        for _ in range(samples):
            next_owner["create_job"](None, None)
    before = state["clock"]
    next_owner["create_job"](None, None)
    next_owner["close_handle"](77)
    assert state["clock"] == before and not handles
    owner_bytes = (root / "windows-owner-diagnostic.jsonl").read_bytes()
    capped_rows = [json.loads(line) for line in owner_bytes.splitlines()]
    assert len(capped_rows) <= 256 and len(owner_bytes) <= 256 * 1024
    assert sum(row["phase"] == "overflow" for row in capped_rows) == 1
    assert capped_rows[-1]["phase"] == "overflow"

# Model the observed 13-command schedule, not native Windows execution.
# Keep all five lifecycle phases and all retained actors, including exited ones.
registered, live = set(), set()
def model_opened(access, inherit, pid):
    if pid in registered and pid not in live:
        state["error"] = 87
        return 0
    return opened(access, inherit, pid)
def model_times(handle, *values):
    assert handle in handles
    birth = 134000000000000000 + handle * 10
    values[0]._obj.dwHighDateTime, values[0]._obj.dwLowDateTime = birth >> 32, birth & 0xffffffff
    return 1
def model_frequency(value):
    value._obj.value = 10000000
    return 1
def model_membership(handle, job, value):
    assert handle in handles and job == 777
    value._obj.value = int(handle not in (2000, 2001))
    return 1
kernel.OpenProcess.callback = model_opened
kernel.GetProcessTimes.callback = model_times
kernel.QueryPerformanceFrequency.callback = model_frequency
kernel.IsProcessInJob.callback = model_membership
state.update(error=0, clock=1000000000)
scope["install_owner_observer"].__globals__["os"] = types.SimpleNamespace(
    name="nt", path=os.path, listdir=os.listdir, getpid=lambda: 2000)
def model_drain(child, job):
    assert not handles
    accounting = Accounting()
    model_owner["query_job"](job, 1, c.byref(accounting), c.sizeof(accounting), None)
    assert not handles
with tempfile.TemporaryDirectory(prefix="checkout-budget-") as directory:
    root = pathlib.Path(directory)
    (root / "pids").mkdir()
    (root / "pids" / "2001.json").write_text(json.dumps(dict(
        pid=2001, role="sentinel", attempt=0, instance="fixture-sentinel",
        creationTime=str(134000000000020010))))
    model_owner = dict(Accounting=Accounting, create_job=lambda *_: 777,
                       close_handle=lambda _: 1, query_job=Function(query), drain=model_drain)
    model_owner["query_job"].errcheck = lambda value, function, args: value
    scope["install_owner_observer"](model_owner, directory)
    registrations = {4: 1, 5: 2, 6: 3, 12: 4}
    phases = ["job-created", "before-drain", "accounting", "after-drain", "before-job-close"]
    expected_actor_counts = []
    for generation in range(1, 14):
        expected_actor_counts.append(len(registered))
        job = model_owner["create_job"](None, None)
        attempt = registrations.get(generation)
        if attempt is not None:
            for offset, role in enumerate(("parent", "child", "grandchild")):
                pid = 2010 + attempt * 10 + offset
                registered.add(pid)
                if attempt <= 2:
                    live.add(pid)
                (root / "pids" / f"{pid}.json").write_text(json.dumps(dict(
                    pid=pid, role=role, attempt=attempt, instance=f"fixture-{pid}",
                    creationTime=str(134000000000000000 + pid * 10))))
        expected_actor_counts.extend([len(registered)] * 4)
        model_owner["drain"](types.SimpleNamespace(pid=2002), job)
        model_owner["close_handle"](job)
        live.clear()
    assert len(registered) == 12 and not handles
    filename = root / "windows-owner-diagnostic.jsonl"
    recovery_bytes = filename.read_bytes()
    recovery_rows = [json.loads(line) for line in recovery_bytes.splitlines()]
    assert [row["phase"] for row in recovery_rows] == phases * 13, (
        "full 13-command recovery must retain all 65 lifecycle records", len(recovery_rows))
    assert [row["sequence"] for row in recovery_rows] == list(range(1, 66))
    assert [row["jobGeneration"] for row in recovery_rows] == [
        generation for generation in range(1, 14) for _ in phases]
    assert [len(row["actors"]) for row in recovery_rows] == expected_actor_counts
    assert len(recovery_bytes) <= 256 * 1024 - 1024
    assert all(row["sentinel"] is not None and row["owner"] is not None for row in recovery_rows)
    assert all(row["bootstrap"] is not None for row in recovery_rows if row["phase"] != "job-created")
    # Reopening the owner must charge actual prior bytes, not census metadata.
    model_owner = dict(Accounting=Accounting, create_job=lambda *_: 777,
                       close_handle=lambda _: 1, query_job=Function(query), drain=model_drain)
    model_owner["query_job"].errcheck = lambda value, function, args: value
    scope["install_owner_observer"](model_owner, directory)
    model_owner["create_job"](None, None)
    reseeded_bytes = filename.read_bytes()
    reseeded_rows = [json.loads(line) for line in reseeded_bytes.splitlines()]
    assert reseeded_bytes.startswith(recovery_bytes) and len(reseeded_bytes) <= 256 * 1024
    assert len(reseeded_rows) == 66 and reseeded_rows[-1]["phase"] == "job-created", (
        "sequential owner must retain the fitting next record", len(reseeded_rows))
    assert not handles

for emitter, allowance in (("owner", 0), ("census", 512)):
    payload = dict(emitter=emitter, phase="sample")
    raw = scope["encoded_record"](payload)
    record, count, size, overflow = scope["bounded_record"](payload, 0, 0, False)
    assert record == payload and count == 1 and size == len(raw) + allowance and not overflow

for payload in (dict(emitter="census", phase="sample"), dict(emitter="owner", phase="sample", value="x" * 20000)):
    count, size, overflow, encoded = 0, 0, False, []
    for _ in range(1024):
        record, count, size, overflow = scope["bounded_record"](payload, count, size, overflow)
        if record is not None: encoded.append(scope["encoded_record"](record))
    assert len(encoded) <= 256 and sum(map(len, encoded)) <= 256 * 1024
    assert json.loads(encoded[-1])["phase"] == "overflow"
print(json.dumps(dict(api="emulated", transientHandles=True, primaryExceptionPreserved=True,
                     capRecords=512, capBytes=512*1024, completeRows=complete_rows, ownerRows=rows,
                     recoveryRows=recovery_rows, recoveryBytes=len(recovery_bytes),
                     reseededBytes=len(reseeded_bytes))))
`,
      fileURLToPath(new URL("./fixtures/ci-windows-process-census.py", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    api: "emulated",
    transientHandles: true,
    primaryExceptionPreserved: true,
  });
  const complete = projectWindowsCheckoutDiagnostics({
    status: "complete",
    records: JSON.parse(result.stdout).completeRows,
  });
  expect(complete.status).toBe("complete");
  expect(complete.records).toMatchObject([
    {
      actors: [
        { pid: 101, role: "parent", attempt: 2 },
        { pid: 104, role: "child", attempt: 2 },
        { pid: 105, role: "grandchild", attempt: 2 },
      ],
      sentinel: { pid: 103, role: "sentinel", attempt: 0 },
    },
  ]);
  expect(JSON.parse(result.stdout).completeRows[0].actors).toHaveLength(3);
  expect(
    projectWindowsCheckoutDiagnostics({
      status: "complete",
      records: JSON.parse(result.stdout).ownerRows,
    }).status,
  ).toBe("unavailable");
  const recovery = projectWindowsCheckoutDiagnostics({
    status: "complete",
    records: JSON.parse(result.stdout).recoveryRows,
  });
  expect(recovery.status).toBe("complete");
  expect(recovery.records).toHaveLength(65);
});

it.skipIf(process.platform === "win32").each(["missing", "partial", "oversized"])(
  "retains original fixture outcome with %s Windows diagnostic files",
  async (kind) => {
    await withCiCheckoutFixture(
      "early-leader-exit",
      (root) => {
        writeFileSync(path.join(root, "checkout.sh"), "exit 23\n");
        writeFileSync(
          path.join(root, "fixture-options.json"),
          JSON.stringify({ windowsDiagnostics: true }),
        );
        if (kind !== "missing") {
          writeFileSync(
            path.join(root, "windows-owner-diagnostic.jsonl"),
            kind === "partial" ? '{"emitter":"owner"' : "x".repeat(256 * 1024 + 1),
          );
        }
      },
      (report, result) => {
        expect(result).toEqual({ code: 0, signal: null });
        expect(report.code).toBe(23);
        expect(report.error).toBeUndefined();
        expectCiCheckoutCleanup(report);
        expect(report.windowsDiagnostics?.status).toBe(kind === "missing" ? "missing" : "invalid");
      },
    );
  },
  55_000,
);

it("bounds membership probes without changing the original Windows drain", () => {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-I",
      "-S",
      "-c",
      String.raw`
import ctypes as c, json, os, pathlib, runpy, sys, tempfile, time, types
scope = runpy.run_path(sys.argv[1])
install = scope["install_membership_probe"]
install.__globals__["os"] = types.SimpleNamespace(**{**vars(os), "name": "nt"})
class Function:
    def __init__(self, callback): self.callback = callback
    def __call__(self, *args): return self.callback(*args)
class Accounting(c.Structure):
    _fields_ = [(name, c.c_uint32) for name in ("ActiveProcesses", "TotalProcesses", "TotalTerminatedProcesses")]
class ProcessList(c.Structure):
    _fields_ = [("assigned", c.c_uint32), ("count", c.c_uint32), ("pids", c.c_size_t * 256)]
summaries, close_failures = [], []
for fault in ("omitted", "covered", "no-interval", "signals-during-query", "truncated", "query",
              "birth", "sentinel-member", "open", "duplicate", "kill", "wait", "terminate",
              "count-cap", "short-buffer", "duplicate-pid", "zero-pid", "later-query-error",
              "close-normal", "close-open", "close-multiple", "close-kill", "close-wait", "close-terminate"):
    state = dict(error=73, clock=0, phase=0, reads=0, queried=False, ordinary=0)
    handles, calls, opened_pids, close_attempts, acquired_handles = {}, [], [], [], []
    close_fault = fault.startswith("close-")
    operation_fault = fault.removeprefix("close-")
    primary = OSError(123, "PRIMARY_CANARY")
    primary.winerror = 123
    c.get_last_error = lambda: state["error"]
    c.set_last_error = lambda value: state.update(error=value)
    def win_error(code):
        error = OSError(code, "PRIVATE_CANARY")
        error.winerror = code
        return error
    c.WinError = win_error
    def opened(access, inherit, pid):
        assert access == 0x101000 and inherit is False and pid != 102
        opened_pids.append(pid)
        if operation_fault == "open" and pid == 104:
            state["error"] = 5
            return 0
        handle = pid + 1000
        handles[handle] = pid
        acquired_handles.append(handle)
        return handle
    def duplicate(source_process, source, target_process, target, access, inherit, flags):
        assert (source_process, source, target_process, access, inherit, flags) == (900, 9999, 900, 0, False, 2)
        if fault == "duplicate": return 0
        target._obj.value = 1102
        handles[1102] = 102
        acquired_handles.append(1102)
        return 1
    def close(handle):
        assert handle != 9999
        close_attempts.append(handle)
        if close_fault and (handle == 1102 or fault == "close-multiple" and handle == 1103):
            state["error"] = 6 if handle == 1102 else 7
            return 0
        del handles[handle]
        state["error"] = 99
        return 1
    def waited(handle, timeout):
        assert timeout == 0 and handle in handles
        state["reads"] += 1
        if fault == "no-interval" and state["reads"] > 5: return 0
        if fault == "signals-during-query" and state["queried"]: return 0
        return 0 if handles[handle] == 102 and state["phase"] > 0 else 258
    def times(handle, *values):
        values[0]._obj.dwHighDateTime = 0
        values[0]._obj.dwLowDateTime = handles[handle] * 10 + int(fault == "birth")
        return 1
    def member(handle, job, value):
        assert job == 77
        value._obj.value = int(handles[handle] != 103 or fault == "sentinel-member")
        return 1
    def clock(value):
        state["clock"] += 1
        value._obj.value = state["clock"]
        return 1
    def frequency(value):
        value._obj.value = 1000
        return 1
    def query(job, kind, pointer, size, returned):
        assert job == 77
        if kind == 1:
            pointer._obj.ActiveProcesses = 0
            pointer._obj.TotalProcesses = 5
            return 1
        assert kind == 3 and size == c.sizeof(ProcessList)
        state["queried"] = True
        if fault == "query" or fault == "later-query-error" and state["phase"] == 2:
            state["error"] = 234
            return 0
        pids = [101, 102, 104, 105]
        if (fault == "signals-during-query" or fault == "omitted" and state["phase"] == 2
                or fault == "later-query-error" and state["phase"] == 1):
            pids.remove(101)
        if fault == "duplicate-pid": pids[0] = pids[1]
        if fault == "zero-pid": pids[0] = 0
        listing = pointer._obj
        listing.assigned = len(pids) + int(fault == "truncated")
        listing.count = len(pids)
        listing.pids[:len(pids)] = pids
        returned._obj.value = 8 + len(pids) * c.sizeof(c.c_size_t)
        if fault == "short-buffer": returned._obj.value -= 1
        if fault == "count-cap": listing.count = listing.assigned = 257
        return 1
    kernel = types.SimpleNamespace(**{name: Function(callback) for name, callback in {
        "GetCurrentProcess": lambda: 900, "DuplicateHandle": duplicate, "OpenProcess": opened,
        "CloseHandle": close, "WaitForSingleObject": waited, "GetProcessTimes": times,
        "IsProcessInJob": member, "QueryPerformanceCounter": clock,
        "QueryPerformanceFrequency": frequency, "QueryInformationJobObject": query,
    }.items()})
    c.WinDLL = lambda *_args, **_kwargs: kernel
    def operation(name, expected_error, result):
        assert state["error"] == expected_error, (fault, name, state)
        calls.append(name)
        state["error"] = {"kill": 74, "wait": 75, "terminate": 76}[name]
        if operation_fault == name: raise primary
        return result
    class Child:
        pid, _handle = 102, 9999
        def kill(self): return operation("kill", 73, "kill-result")
        def wait(self, *, timeout):
            assert 0 < timeout <= 10
            state["phase"] = 1
            return operation("wait", 74, "wait-result")
    child = Child()
    def terminate(job, code):
        assert (job, code) == (77, 1)
        state["phase"] = 2
        return operation("terminate", 75, "terminate-result")
    def original_drain(child, job):
        assert child.kill() == "kill-result"
        assert child.wait(timeout=10) == "wait-result"
        assert namespace["terminate_job"](job, 1) == "terminate-result"
        state["ordinary"] += 1
        assert not handles, "oracles survived into ordinary Accounting"
        assert state["error"] == 76
        return "original-result"
    with tempfile.TemporaryDirectory(prefix="membership-probe-") as directory:
        root = pathlib.Path(directory)
        (root / "pids").mkdir()
        (root / "ready-2.json").write_text("2")
        for pid, role, attempt in [(101, "parent", 2), (104, "child", 2), (105, "grandchild", 2),
                                   (103, "sentinel", 0), (106, "git", 0), (107, "shell", 0)]:
            (root / "pids" / f"{pid}.json").write_text(json.dumps(dict(
                pid=pid, role=role, attempt=attempt, creationTime=str(pid * 10))))
        namespace = dict(drain=original_drain, terminate_job=terminate, Accounting=Accounting,
                         time=time, cleanup_seconds=10)
        install(namespace, directory)
        caught = None
        try:
            assert namespace["drain"](child, 77) == "original-result"
        except BaseException as error:
            caught = error
        if close_fault:
            raw = (root / "windows-membership-probe.json").read_bytes()
            report = json.loads(raw)
            owner_failed = operation_fault in ("kill", "wait", "terminate")
            expected_calls = ["kill", "wait", "terminate"][:{"kill": 1, "wait": 2}.get(operation_fault, 3)]
            checks = {
                "ordinary-accounting-with-unreleased-oracle": state["ordinary"] == 0,
                "one-close-attempt-per-acquired-oracle": (
                    len(close_attempts) == len(set(close_attempts))
                    and set(close_attempts) == set(acquired_handles)
                ),
                "first-native-close-error": report.get("releaseErrorCode") == 6,
                "primary-exception-or-probe-gate": (
                    caught is primary if owner_failed else isinstance(caught, OSError) and caught.winerror == 6
                ),
                "exception-provenance": report.get("probeGateException") is (not owner_failed),
                "remaining-oracles": set(handles) == ({1102, 1103} if fault == "close-multiple" else {1102}),
                "original-calls-and-last-error": calls == expected_calls and state["error"] == 73 + len(calls),
                "source-handle-and-methods": child._handle == 9999 and not child.__dict__ and namespace["terminate_job"] is terminate,
                "bounded-invalid-report": (
                    len(raw) <= 65536 and "CANARY" not in raw.decode()
                    and report["status"] == "invalid" and report["released"] is False
                    and report["originalReturnPath"] == "exception"
                    and len(report["snapshots"]) + len(report["errors"]) + 2 <= 8
                ),
            }
            violations = [name for name, passed in checks.items() if not passed]
            summaries.append(dict(fault=fault, status=report["status"], calls=calls,
                                  ordinary=state["ordinary"], violations=violations, bytes=len(raw)))
            if violations:
                close_failures.append(dict(fault=fault, violations=violations))
            handles.clear()
            continue
        if operation_fault in ("kill", "wait", "terminate"):
            assert caught is primary
        else:
            assert caught is None, (fault, caught)
        assert not handles and child._handle == 9999 and not child.__dict__
        assert namespace["terminate_job"] is terminate
        assert calls == ["kill", "wait", "terminate"][:{"kill": 1, "wait": 2}.get(fault, 3)]
        expected_error = 73 + len(calls)
        assert state["error"] == expected_error
        raw = (root / "windows-membership-probe.json").read_bytes()
        report = json.loads(raw)
        assert len(raw) <= 65536 and report["released"] and "CANARY" not in raw.decode()
        assert len(report["snapshots"]) + len(report["errors"]) + 2 <= 8
        assert report["originalReturnPath"] == ("exception" if fault in ("kill", "wait", "terminate") else "normal")
        if fault == "omitted":
            assert report["status"] == "falsified" and report["snapshots"][-1]["active"] == 0
        elif fault in ("truncated", "query", "birth", "sentinel-member", "open", "duplicate",
                       "count-cap", "short-buffer", "duplicate-pid", "zero-pid", "later-query-error"):
            assert report["status"] == "invalid"
        else:
            assert report["status"] == "inconclusive", (fault, report)
        if fault in ("omitted", "covered", "no-interval", "signals-during-query"):
            assert len(report["snapshots"]) == 3
        if fault == "later-query-error":
            assert report["snapshots"][1]["status"] == "falsified"
        if fault in ("covered", "omitted"):
            assert report["pendingExitObserved"] is True
        if fault in ("no-interval", "signals-during-query"):
            assert report["pendingExitObserved"] is False and report["reason"] == "no-pending-interval"
        if fault == "covered":
            before = (root / "windows-membership-probe.json").read_bytes()
            # The same owner never repeats the probe for subsequent commands.
            state.update(error=73, phase=0)
            assert namespace["drain"](child, 77) == "original-result"
            assert (root / "windows-membership-probe.json").read_bytes() == before
        summaries.append(dict(fault=fault, status=report["status"], calls=calls, bytes=len(raw)))
print(json.dumps(summaries))
assert not close_failures, ("membership-close-regressions", close_failures)
`,
      fileURLToPath(new URL("./fixtures/ci-windows-process-census.py", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toHaveLength(24);
  console.log(`membership-probe emulation: ${result.stdout.trim()}`);
});

// Execute both workflow policies against the same owned tree fixture. A leader's
// exit must not authorize workspace deletion, Git reuse, or final success.
const platformCases = [
  { scenario: "timeouts-exhausted", attempts: 3, code: 124, checkout: false },
  { scenario: "recovery", attempts: 4, code: 0, checkout: true },
  { scenario: "early-leader-exit", attempts: 2, code: 0, checkout: true },
  { scenario: "harness-timeout", attempts: 2, code: 124, checkout: true },
  { scenario: "git-failure", attempts: 1, code: 23, checkout: false },
  { scenario: "git-exit-124", attempts: 1, code: 124, checkout: false },
  { scenario: "pre-existing-lock", attempts: 1, code: 128, checkout: false },
  // Windows has no POSIX signals/ps boundary; native Job cancellation proof is separate.
  ...(process.platform === "win32" ? [] : ["SIGTERM", "SIGINT", "SIGHUP"]).map((signal, index) => ({
    scenario: `cancel-${signal}`,
    attempts: 1,
    code: [143, 130, 129][index],
    checkout: false,
  })),
  ...(process.platform === "win32"
    ? []
    : [{ scenario: "cleanup-failure", attempts: 1, code: 125, checkout: false }]),
];
const linuxCases =
  process.platform === "win32"
    ? []
    : [
        { scenario: "timeouts-exhausted", attempts: 5, code: 1, checkout: false, deletions: 5 },
        { scenario: "recovery", attempts: 4, code: 0, checkout: true, deletions: 3 },
        { scenario: "early-leader-exit", attempts: 2, code: 0, checkout: true, deletions: 1 },
        { scenario: "git-failure", attempts: 5, code: 1, checkout: false, deletions: 5 },
        { scenario: "checkout-failure", attempts: 5, code: 1, checkout: true, deletions: 5 },
        { scenario: "harness-recovery", attempts: 4, code: 0, checkout: true, deletions: 2 },
        { scenario: "cancel-SIGTERM", attempts: 1, code: 143, checkout: false, deletions: 1 },
        { scenario: "cleanup-failure", attempts: 1, code: 125, checkout: false, deletions: 1 },
        { scenario: "non-executable-git", attempts: 0, code: null, checkout: false, deletions: 0 },
        { scenario: "non-executable-find", attempts: 0, code: null, checkout: false, deletions: 0 },
      ];

it.concurrent.each([
  ...platformCases.map((entry) => Object.assign(entry, { linux: false, deletions: 0 })),
  ...linuxCases.map((entry) => Object.assign(entry, { linux: true })),
])(
  "preserves checkout ownership and fixture isolation (Linux=$linux, $scenario)",
  async ({ scenario, attempts, code, checkout, linux, deletions }) => {
    const setupFailure = scenario.startsWith("non-executable-");
    const windowsDiagnostics =
      process.platform === "win32" &&
      !linux &&
      ["recovery", "early-leader-exit", "harness-timeout"].includes(scenario);
    const run = readCiCheckoutStep(linux ? "checks-fast-core" : "checks-windows").run;

    const policyScenario = `${linux ? "linux:" : ""}${scenario}`;
    await withCiCheckoutFixture(
      policyScenario,
      (root) => {
        const workspace = path.join(root, "workspace");
        if (scenario.startsWith("cancel-")) {
          // Inject slow startup before fetch, beyond the former cancellation readiness deadline.
          writeFileSync(
            path.join(root, "fixture-config.json"),
            JSON.stringify({ initDelayMs: 4_100 }),
          );
        }
        if (linux) {
          writeFileSync(path.join(workspace, ".previous-checkout"), "stale\n");
        }
        if (scenario === "recovery") {
          // Reproduce startup beyond the old wall-clock budget without delaying other consumers.
          writeFileSync(path.join(root, "tree-start-delay-3.json"), "2100");
        }
        if (scenario === "git-exit-124") {
          // Slow child startup must not replace Git's injected exit with a fixture timeout.
          writeFileSync(path.join(root, "tree-start-delay-1.json"), "4100");
        }
        if (windowsDiagnostics) {
          writeFileSync(
            path.join(root, "fixture-options.json"),
            JSON.stringify({ windowsDiagnostics: true }),
          );
        }
        const accelerated = renderGitTestClock(run, {
          realDrain: scenario.startsWith("cancel-"),
          ...(windowsDiagnostics
            ? {
                windowsDiagnosticsRoot: root,
                windowsMembershipProbe: scenario === "harness-timeout",
              }
            : {}),
        });
        expect(accelerated).not.toBe(run);
        // A broken preflight must never let these negative fixture tests run real Git.
        writeFileSync(
          path.join(root, "checkout.sh"),
          setupFailure ? "printf 'unexpected workflow invocation\\n' >&2\nexit 99\n" : accelerated,
        );
        if (process.platform === "win32") {
          return censusPreload(
            root,
            windowsDiagnostics
              ? `
const diagnosticSpawn = cp.spawn;
cp.spawn = (command, args, options) => diagnosticSpawn(command,
  command === "python" && args?.[2]?.endsWith("ci-windows-process-census.py")
    ? [...args, "--checkout-diagnostics"] : args, options);
syncFixtureBuiltinExports();
`
              : "",
            ["timeouts-exhausted", "recovery", "early-leader-exit", "harness-timeout"].includes(
              scenario,
            ),
          );
        }
        return undefined;
      },
      (report, result, stderr, root) => {
        const workspace = path.join(root, "workspace");
        // Emit evidence before assertions; it remains available even for this deliberately red test.
        console.log(`${scenario}: ${JSON.stringify(report)}`);
        let membershipProbe: { status?: string; released?: boolean } | undefined;
        if (windowsDiagnostics && scenario === "harness-timeout") {
          try {
            const filename = path.join(root, "windows-membership-probe.json");
            const info = lstatSync(filename);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
              throw new Error("invalid probe file");
            }
            membershipProbe = JSON.parse(readFileSync(filename, "utf8"));
            console.log(`Windows membership probe: ${JSON.stringify(membershipProbe)}`);
          } catch {
            membershipProbe = { status: "invalid", released: false };
          }
        }
        if (setupFailure) {
          expect(report.cleanupRemaining, "fixture cleanup left owned processes").toEqual([]);
          expect(report.error, report.output).toContain(
            "Fixture setup: mock command resolution failed",
          );
          expect(report.error).toContain(scenario.slice("non-executable-".length));
          expect(result, stderr).toEqual({ code: 1, signal: null });
          expect(report.code).toBeNull();
          expect(report.output).toBe("");
          expect(report.commands).toEqual([]);
          expect(report.boundaries).toEqual([]);
          return;
        }
        expect(result, stderr).toEqual({ code: 0, signal: null });
        expect(report.error, stderr).toBeUndefined();
        expectCiCheckoutCleanup(report);
        expectCensusClosed(
          root,
          report.ownedProcesses.map((entry) => entry.pid),
        );
        expect(report.code).toBe(code);
        expect(readFileSync(path.join(workspace, ".git/preexisting.lock"), "utf8")).toBe(
          "not invocation-owned\n",
        );
        if (scenario === "pre-existing-lock") {
          expect(readFileSync(path.join(workspace, ".git/shallow.lock"), "utf8")).toBe(
            "not invocation-owned\n",
          );
        }
        if (scenario === "recovery") {
          for (let attempt = 1; attempt <= attempts; attempt++) {
            expect(
              readFileSync(path.join(root, "shared-git-cache", `${attempt}.lock`), "utf8"),
            ).toBe("outside Git ownership\n");
          }
        }
        if (scenario === "git-exit-124") {
          expect(report.output).toBe("");
        }
        const readyAttempts =
          scenario === "pre-existing-lock" ? [] : Array.from({ length: attempts }, (_, i) => i + 1);
        expect(report.readyAttempts).toEqual(readyAttempts);
        expect(report.boundaries.filter((entry) => entry.name.startsWith("fetch:"))).toHaveLength(
          attempts,
        );
        expect(report.boundaries.some((entry) => entry.name === "checkout")).toBe(checkout);
        expect(report.boundaries.filter((entry) => entry.name === "delete")).toHaveLength(
          deletions,
        );
        expect(report.output.includes("refusing reuse or retry")).toBe(
          scenario === "cleanup-failure",
        );
        if (scenario.startsWith("cancel-")) {
          const alive = report.ownedProcesses.filter((entry) => entry.attempt === 1);
          expect(alive.map((entry) => entry.role).toSorted()).toEqual([
            "child",
            "grandchild",
            "parent",
          ]);
          const owner = expectDefined(
            report.ownedProcesses.find((entry) => entry.role === "shell"),
            "workflow owner",
          );
          expect(owner.pid).toBeGreaterThan(1);
          const signal = scenario.slice("cancel-".length);
          expect(report.output).toContain(
            `cancellation: ${JSON.stringify({ signal, owner: owner.pid, alive })}\n`,
          );
        }
        if (code === 0) {
          const fetches = report.commands.filter(({ args }) => args.includes("fetch"));
          const candidateFetch = expectDefined(fetches[0], "candidate fetch");
          expect(candidateFetch.args).toContain(
            `+${"a".repeat(40)}:refs/remotes/origin/${linux ? "ci-target" : "checkout"}`,
          );
          expect(
            candidateFetch.args.includes(`+${"c".repeat(40)}:refs/remotes/origin/ci-ratchet-base`),
          ).toBe(linux && scenario === "early-leader-exit");
          if (linux) {
            expect(
              report.commands.filter(
                ({ args }) =>
                  args.join(" ") === `config --global --add safe.directory ${workspace}`,
              ),
            ).toHaveLength(deletions);
            expect(
              report.commands
                .filter(({ cwd, args }) => cwd === workspace && args[0] === "checkout")
                .every(
                  ({ args }) => args.join(" ") === `checkout --force --detach ${"a".repeat(40)}`,
                ),
            ).toBe(true);
          }
          expect(candidateFetch.cwd).toBe(workspace);
          expect(fetches.at(-1)?.cwd).toBe(path.join(workspace, ".ci-harness"));
          for (const { args } of fetches) {
            expect(args).toEqual(
              expect.arrayContaining(["--no-tags", "--no-recurse-submodules", "--depth=1"]),
            );
          }
          expect(fetches.at(-1)?.args).toContain(
            `+${"b".repeat(40)}:refs/remotes/origin/ci-harness`,
          );
          expect(
            report.commands.some(
              ({ args }) =>
                args.join(" ") ===
                [
                  "sparse-checkout set --no-cone /.github/actions/ /scripts/ios-screenshot-evidence.mjs /scripts/lib/direct-run.mjs",
                  ...(linux
                    ? ["/scripts/lib/release-upgrade-baseline.mjs /scripts/lib/release-version.mjs"]
                    : []),
                ].join(" "),
            ),
          ).toBe(true);
          expect(report.commands.at(-1)?.args).toEqual([
            "checkout",
            "--force",
            "--detach",
            "b".repeat(40),
          ]);
        }
        if (windowsDiagnostics) {
          // Cleanup and policy assertions above win over diagnostic completeness.
          expect(report.windowsDiagnostics?.status).toBe("complete");
          expect(report.windowsDiagnostics?.runtime).toBeDefined();
          const diagnosticRecords = report.windowsDiagnostics?.records ?? [];
          expect(diagnosticRecords.some((entry) => entry.phase === "after-drain")).toBe(true);
          expect(
            diagnosticRecords.some(
              (entry) =>
                entry.emitter === "census" &&
                "request" in entry &&
                entry.request?.purpose === "exit",
            ),
          ).toBe(true);
          expect(diagnosticRecords.filter((entry) => "python" in entry)).toHaveLength(1);
        }
        if (windowsDiagnostics && scenario === "harness-timeout") {
          // Neither a covered sample nor an absent pending interval proves universal coverage.
          expect(["falsified", "inconclusive"]).toContain(membershipProbe?.status);
          expect(membershipProbe?.released).toBe(true);
        }
      },
    );
  },
  55_000,
);

it.concurrent.each([
  ...[
    ...(process.platform === "win32" ? [] : [{ kind: "linux-node", retained: false }]),
    ...(process.platform === "win32"
      ? []
      : [{ kind: "linux-node", retained: false, workflow: "previous", fetches: 2 }]),
    { kind: "platform", retained: false },
    { kind: "platform", retained: true },
    { kind: "platform", retained: false, workflow: "previous", fetches: 2 },
  ].map((entry) =>
    Object.assign(
      {
        event: "push",
        workflow: "same",
        target: "selected",
        code: 0,
        fetches: 1,
      },
      entry,
    ),
  ),
  ...(process.platform === "win32"
    ? []
    : [
        { event: "push", workflow: "same", target: "selected", code: 0, fetches: 2 },
        { event: "pull_request", workflow: "same", target: "selected", code: 0, fetches: 2 },
        { event: "pull_request", workflow: "previous", target: "selected", code: 0, fetches: 2 },
        {
          event: "workflow_dispatch",
          workflow: "previous",
          target: "selected",
          code: 0,
          fetches: 2,
        },
        {
          event: "workflow_dispatch",
          workflow: "previous",
          target: "missing-branch",
          code: 0,
          fetches: 3,
        },
        { event: "pull_request", workflow: "missing", target: "selected", code: 0, fetches: 2 },
        { event: "push", workflow: "missing-action", target: "selected", code: 1, fetches: 2 },
        {
          event: "workflow_dispatch",
          workflow: "previous",
          target: "moved-event",
          code: 0,
          fetches: 3,
        },
        { event: "push", workflow: "same", target: "missing-sha", code: 128, fetches: 1 },
        {
          event: "workflow_dispatch",
          workflow: "previous",
          target: "missing-sha",
          code: 1,
          fetches: 2,
        },
      ].map((entry) => Object.assign(entry, { kind: "preflight", retained: false }))),
])(
  "materializes $kind trusted harness ($event, workflow=$workflow, target=$target, retained=$retained) without mutating the candidate",
  async ({ kind, retained, event, workflow, target, code, fetches }) => {
    const linux = kind !== "platform";
    const preflight = kind === "preflight";
    const posix = process.platform !== "win32";
    const action = ".github/actions/setup-node-env/action.yml";
    const executable = ".github/actions/tool/line\nbreak.sh";
    const link = ".github/actions/tool/link";
    const files = {
      [action]: "name: trusted $Format:%H$\n",
      ".github/actions/tool/with space.txt": "literal action bytes\n",
      ...(posix ? { [executable]: "#!/bin/sh\nexit 0\n" } : {}),
    };
    const evidenceScripts = {
      "scripts/ios-screenshot-evidence.mjs": "workflow evidence script\n",
      "scripts/lib/direct-run.mjs": "workflow direct-run script\n",
    };
    const releasePolicy = Object.fromEntries(
      [
        "scripts/lib/release-context.mjs",
        "scripts/lib/release-version.mjs",
        "scripts/lib/release-upgrade-baseline.mjs",
      ].map((name) => [name, readFileSync(name, "utf8")]),
    );
    const candidateFiles = {
      "candidate-only.txt": "candidate stays intact\n",
      "extensions/browser/icon.png": "complete binary path\0\xff",
      "ui/src/i18n/.i18n/de-DE.tm.jsonl": '{"fixture":"complete inventory"}\n',
      "scripts/lib/candidate-only.mjs": "export const candidate = true;\n",
    };
    let revision = "";
    let workflowRevision = "";
    let candidateAction = files[action];
    let candidateEvidenceScripts: Record<string, string> = evidenceScripts;
    const existingExcludes = retained
      ? "/saved-artifact/\n/.ci-harness/\n"
      : "# Existing local excludes\r\n/saved-artifact/";
    let readSourceStatus: (() => string[]) | undefined;
    await withCiCheckoutFixture(
      `${linux ? "linux:" : ""}configured`,
      (root) => {
        const source = path.join(root, "source");
        mkdirSync(source);
        const git = execFileSync(process.platform === "win32" ? "where.exe" : "which", ["git"], {
          encoding: "utf8",
        })
          .trim()
          .split(/\r?\n/u)[0];
        const gitConfig = path.join(root, "gitconfig");
        writeFileSync(gitConfig, "");
        const gitTemplate = path.join(root, "git-template");
        mkdirSync(path.join(gitTemplate, "info"), { recursive: true });
        writeFileSync(path.join(gitTemplate, "info/exclude"), existingExcludes);
        const gitEnv = {
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: gitConfig,
          GIT_TEMPLATE_DIR: gitTemplate,
          GIT_TERMINAL_PROMPT: "0",
          GIT_AUTHOR_NAME: "Checkout fixture",
          GIT_AUTHOR_EMAIL: "checkout@example.invalid",
          GIT_COMMITTER_NAME: "Checkout fixture",
          GIT_COMMITTER_EMAIL: "checkout@example.invalid",
        };
        readSourceStatus = () =>
          execFileSync(
            expectDefined(git, "real Git executable"),
            ["-C", path.join(root, "workspace"), "status", "--porcelain", "--untracked-files=all"],
            {
              env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...gitEnv },
              encoding: "utf8",
            },
          )
            .split(/\r?\n/u)
            .filter(Boolean);
        const run = (...args: string[]) =>
          execFileSync(expectDefined(git, "real Git executable"), ["-C", source, ...args], {
            env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...gitEnv },
            encoding: "utf8",
          }).trim();
        run("init");
        for (const [name, contents] of Object.entries({
          ...files,
          ...evidenceScripts,
          ...releasePolicy,
          ...candidateFiles,
        })) {
          mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
          writeFileSync(path.join(source, name), contents);
        }
        // Archive export would omit or rewrite these trusted action bytes.
        writeFileSync(path.join(source, ".gitattributes"), "* -text export-ignore export-subst\n");
        if (posix) {
          chmodSync(path.join(source, executable), 0o755);
          symlinkSync("line\nbreak.sh", path.join(source, link));
        }
        if (workflow === "missing-action") {
          rmSync(path.join(source, action));
        }
        run("add", "--all");
        run("commit", "--no-gpg-sign", "-m", "fixture revision");
        revision = run("rev-parse", "HEAD");
        workflowRevision = revision;
        if (workflow === "previous") {
          candidateAction = "name: candidate action must not replace the trusted workflow\n";
          writeFileSync(path.join(source, action), candidateAction);
          candidateEvidenceScripts = Object.fromEntries(
            Object.keys(evidenceScripts).map((name) => [
              name,
              `candidate ${path.basename(name)} must not replace the trusted workflow\n`,
            ]),
          );
          for (const [name, contents] of Object.entries(candidateEvidenceScripts)) {
            writeFileSync(path.join(source, name), contents);
          }
          for (const name of Object.keys(releasePolicy)) {
            writeFileSync(path.join(source, name), "throw new Error('candidate policy');\n");
          }
          run("add", action, ...Object.keys(evidenceScripts), ...Object.keys(releasePolicy));
          run("commit", "--no-gpg-sign", "-m", "selected candidate");
          revision = run("rev-parse", "HEAD");
        } else if (workflow === "missing") {
          workflowRevision = "f".repeat(40);
        }
        if (target === "moved-event") {
          run("branch", "event", workflowRevision);
        }
        if (retained) {
          const staleAction = path.join(root, "workspace", ".ci-harness", action);
          mkdirSync(path.dirname(staleAction), { recursive: true });
          writeFileSync(staleAction, "name: stale platform action\n");
        }
        writeFileSync(
          path.join(root, "fixture-options.json"),
          JSON.stringify({
            localGit: { git, remote: source },
            fetchResults: [0, 0],
            cooperativeTrees: true,
            env: {
              ...gitEnv,
              CHECKOUT_KIND: kind,
              CHECKOUT_SHA: revision,
              CHECKOUT_REF:
                target === "missing-branch"
                  ? "refs/heads/missing"
                  : target === "missing-sha"
                    ? "f".repeat(40)
                    : revision,
              CHECKOUT_FALLBACK_REF: revision,
              CHECKOUT_EVENT_REF: target === "moved-event" ? "refs/heads/event" : "",
              GITHUB_EVENT_NAME: event,
              GITHUB_REPOSITORY: "fixture/checkout",
              CHECKOUT_TOKEN: "fixture-read-only-token",
              WORKFLOW_SHA: workflowRevision,
            },
          }),
        );
        writeFileSync(
          path.join(root, "checkout.sh"),
          renderGitTestClock(
            readCiCheckoutStep(
              preflight ? "preflight" : linux ? "checks-fast-core" : "checks-windows",
            ).run,
            {
              realClock: true,
            },
          ),
        );
      },
      (report, result, stderr, root) => {
        expect(result, `${stderr}\n${report.output}`).toEqual({ code: 0, signal: null });
        expect(report.error, report.output).toBeUndefined();
        expectCiCheckoutCleanup(report);
        expect(report.code, report.output).toBe(code);
        expect(report.commands.filter(({ args }) => args[0] === "fetch")).toHaveLength(fetches);
        const workspace = path.join(root, "workspace");
        const harness = path.join(workspace, ".ci-harness");
        if (target === "missing-sha") {
          expect(existsSync(path.join(root, "candidate-index"))).toBe(false);
          expect(existsSync(harness)).toBe(false);
          return;
        }
        expect(readFileSync(path.join(workspace, ".git/index"))).toEqual(
          readFileSync(path.join(root, "candidate-index")),
        );
        expect(readFileSync(path.join(workspace, ".git/HEAD"), "utf8").trim()).toBe(revision);
        expect(readFileSync(path.join(workspace, ".git/config"), "utf8")).not.toContain(
          "AUTHORIZATION",
        );
        for (const [name, contents] of Object.entries(candidateFiles)) {
          expect(readFileSync(path.join(workspace, name), "utf8")).toBe(contents);
          expect(existsSync(path.join(harness, name))).toBe(false);
        }
        const workflowOwnsEvidence = kind === "platform" || kind === "linux-node";
        for (const name of Object.keys(evidenceScripts)) {
          expect(readFileSync(path.join(workspace, name), "utf8")).toBe(
            candidateEvidenceScripts[name],
          );
        }
        if (workflow === "missing-action") {
          expect(existsSync(path.join(workspace, action))).toBe(false);
          expect(existsSync(path.join(harness, action))).toBe(false);
          return;
        }
        expect(readFileSync(path.join(workspace, action), "utf8")).toBe(candidateAction);
        if (preflight && workflow !== "same") {
          // A different workflow revision stays with the pinned Actions checkout.
          expect(existsSync(harness)).toBe(false);
          return;
        }
        const sourceStatus = expectDefined(readSourceStatus, "native source status");
        expect(sourceStatus()).toEqual([]);
        expect(readFileSync(path.join(workspace, ".git/info/exclude"), "utf8")).toBe(
          retained ? existingExcludes : `${existingExcludes}\n/.ci-harness/\n`,
        );
        if (workflow === "same") {
          expect(existsSync(path.join(harness, ".git"))).toBe(false);
        }
        for (const [name, contents] of Object.entries(files)) {
          expect(readFileSync(path.join(harness, name), "utf8")).toBe(contents);
        }
        for (const [name, contents] of Object.entries(evidenceScripts)) {
          expect(existsSync(path.join(harness, name))).toBe(workflowOwnsEvidence);
          if (workflowOwnsEvidence) {
            expect(readFileSync(path.join(harness, name), "utf8")).toBe(contents);
          }
        }
        for (const [name, contents] of Object.entries(releasePolicy)) {
          const ownsPolicy = preflight
            ? name !== "scripts/lib/release-upgrade-baseline.mjs"
            : kind === "linux-node" && name !== "scripts/lib/release-context.mjs";
          expect(existsSync(path.join(harness, name))).toBe(ownsPolicy);
          if (ownsPolicy) {
            expect(readFileSync(path.join(harness, name), "utf8")).toBe(contents);
            writeFileSync(path.join(workspace, name), "throw new Error('candidate policy');\n");
            expect(readFileSync(path.join(harness, name), "utf8")).toBe(contents);
          }
        }
        if (kind === "linux-node") {
          const versions = path.join(root, "published-versions.json");
          writeFileSync(versions, JSON.stringify(["2026.9.1", "2026.9.2", "2026.9.3"]));
          const resolved = spawnSync(
            process.execPath,
            [
              path.join(harness, "scripts/lib/release-upgrade-baseline.mjs"),
              "--candidate-version",
              "2026.9.3",
              "--versions-json",
              versions,
            ],
            { cwd: workspace, encoding: "utf8" },
          );
          expect(resolved.status, resolved.stderr).toBe(0);
          expect(resolved.stdout.trim()).toBe("openclaw@2026.9.2");
        }
        if (posix) {
          // Git tracks only executable state; checkout materialization applies the process umask.
          expect(statSync(path.join(harness, executable)).mode & 0o111).not.toBe(0);
          expect(readlinkSync(path.join(harness, link))).toBe("line\nbreak.sh");
        }
        if (workflow !== "same" && workflowOwnsEvidence) {
          expect(report.commands.find(({ args }) => args[0] === "sparse-checkout")?.args).toEqual([
            "sparse-checkout",
            "set",
            "--no-cone",
            "/.github/actions/",
            "/scripts/ios-screenshot-evidence.mjs",
            "/scripts/lib/direct-run.mjs",
            ...(kind === "linux-node"
              ? ["/scripts/lib/release-upgrade-baseline.mjs", "/scripts/lib/release-version.mjs"]
              : []),
          ]);
        }
        writeFileSync(path.join(workspace, action), "later candidate edit\n");
        expect(readFileSync(path.join(harness, action), "utf8")).toBe(files[action]);
        for (const name of [
          "saved-artifact/ignored.txt",
          "nested/.ci-harness/source.ts",
          "untracked-source.ts",
        ]) {
          mkdirSync(path.dirname(path.join(workspace, name)), { recursive: true });
          writeFileSync(path.join(workspace, name), "later source or artifact\n");
        }
        const dirty = sourceStatus();
        expect(dirty).toContain(` M ${action}`);
        expect(dirty.filter((line) => line.startsWith("?? "))).toEqual([
          "?? nested/.ci-harness/source.ts",
          "?? untracked-source.ts",
        ]);
      },
    );
  },
  55_000,
);

registerWindowsCensusTests();

it.each(["prepare", "inspect"])(
  "removes checkout artifacts after %s assertion failure",
  async (phase) => {
    let root: string | undefined;
    await expect(
      withCiCheckoutFixture(
        "early-leader-exit",
        (directory) => {
          root = directory;
          expect(phase, "injected prepare assertion").not.toBe("prepare");
          writeFileSync(path.join(directory, "checkout.sh"), "exit 0\n");
        },
        (report, result, stderr) => {
          expect(result, stderr).toEqual({ code: 0, signal: null });
          expectCiCheckoutCleanup(report);
          expect(report.code, "injected inspect assertion").toBe(99);
        },
      ),
    ).rejects.toThrow(`injected ${phase} assertion`);
    expect(existsSync(expectDefined(root, "created checkout root"))).toBe(false);
  },
  55_000,
);

it.skipIf(process.platform === "win32").each(["census", "corrupt-report", "timeout"])(
  "retains checkout artifacts across failed outer-runner cleanup (%s)",
  async (fault) => {
    const preload = String.raw`
import cp from "node:child_process";
import fs from "node:fs";
import { syncFixtureBuiltinExports } from ${JSON.stringify(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url).href)};
import path from "node:path";
if (process.argv[2] === "sentinel" && fault === "timeout") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
if (process.argv[2] === "supervise") {
  const root = process.argv[3], children = [], pending = new Set();
  const spawn = cp.spawn, spawnSync = cp.spawnSync, renameSync = fs.renameSync;
  cp.spawn = (...args) => {
    const child = spawn(...args);
    children.push(child.pid);
    pending.add(child);
    fs.writeFileSync(path.join(root, "creator-pids.json"), JSON.stringify([process.pid, ...children]));
    child.once("close", () => pending.delete(child));
    if (fault === "timeout") {
      // Notify after spawn returns and the fixture installs direct-child tracking.
      // Flush IPC before stalling; sentinel registration is deliberately blocked.
      queueMicrotask(() => {
        process.send({ type: "ci-checkout:sentinel-created", pids: [process.pid, child.pid] }, error => {
          if (error) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        });
      });
    }
    return child;
  };
  cp.spawnSync = (...args) => {
    if (fault === "census" && args[0] === "/bin/ps" && children.length === 2 && pending.size === 0) {
      fs.writeFileSync(path.join(root, "closed-before-census.json"), JSON.stringify(children));
      throw new Error("injected final census failure after direct child close");
    }
    return spawnSync(...args);
  };
  fs.renameSync = (...args) => {
    const result = renameSync(...args);
    if (fault === "corrupt-report" && args[1] === path.join(root, "report.json")) {
      fs.writeFileSync(args[1], "null");
    }
    return result;
  };
  syncFixtureBuiltinExports();
}
`;
    // Use the actual outer namespace owner, including its cleanup on exit code 1.
    const { child, completion } = spawnOwnedVitestProcess({
      command: process.execPath,
      args: [
        "--input-type=module",
        "-e",
        String.raw`
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { fixturePreloadEnv, syncFixtureBuiltinExports } from ${JSON.stringify(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url).href)};
import { tmpdir } from "node:os";
import path from "node:path";
import { mock } from "node:test";
const timeoutFault = process.argv[2] === "timeout";
let root, failure;
let supervisor, ready, onReady;
const fork = cp.fork;
if (timeoutFault) {
  ready = new Promise(resolve => {
    onReady = message => {
      if (message?.type === "ci-checkout:sentinel-created") resolve(message.pids);
    };
  });
  cp.fork = (...args) => {
    supervisor = fork(...args);
    supervisor.on("message", onReady);
    return supervisor;
  };
  syncFixtureBuiltinExports();
}
try {
  const { withCiCheckoutFixture } = await import(process.argv[1]);
  if (timeoutFault) mock.timers.enable({ apis: ["setTimeout"] });
  const completed = withCiCheckoutFixture("early-leader-exit", directory => {
    root = directory;
    fs.writeFileSync(path.join(root, "checkout.sh"), "exit 0\n");
    const preload = path.join(root, "fault.mjs");
    fs.writeFileSync(preload, "const fault = " + JSON.stringify(process.argv[2]) + ";\n" + process.argv[3]);
    return fixturePreloadEnv(preload);
  }, (report, result, stderr) => {
    throw new Error("unexpected completed report: " + JSON.stringify({ report, result, stderr }));
  }).catch(error => {
    console.error(error);
    failure = String(error);
  });
  try {
    if (timeoutFault) {
      const pids = await Promise.race([ready, completed.then(() => {
        throw new Error("supervisor completed before the timeout probe was ready");
      })]);
      assert.equal(pids.length, 2);
      assert.equal(pids[0], supervisor.pid);
      assert.notEqual(pids[1], supervisor.pid);
      for (const pid of pids) {
        assert(Number.isInteger(pid) && pid > 1);
        process.kill(pid, 0);
      }
    }
  } finally {
    if (timeoutFault) {
      // Creation belongs to the supervisor, not a child's delayed self-registration.
      // Restore timers before the expired controller deadline starts real cleanup.
      mock.timers.tick(50_000);
      mock.timers.reset();
    }
    await completed;
  }
} catch (error) {
  console.error(error);
  failure = String(error);
} finally {
  if (timeoutFault) {
    mock.timers.reset();
    supervisor?.off("message", onReady);
    cp.fork = fork;
    syncFixtureBuiltinExports();
  }
}
console.log(JSON.stringify({ root, outerRoot: tmpdir(), failure,
  pids: JSON.parse(fs.readFileSync(path.join(root, "creator-pids.json"), "utf8")),
  closedBeforeCensus: fs.existsSync(path.join(root, "closed-before-census.json")),
}));
process.exitCode = 1;
`,
        new URL("./ci-checkout.test-support.ts", import.meta.url).href,
        fault,
        preload,
      ],
      options: { stdio: ["ignore", "pipe", "pipe"] },
    });
    let stdout = "",
      stderr = "";
    child.stdout?.on("data", (data) => (stdout += String(data)));
    child.stderr?.on("data", (data) => (stderr += String(data)));
    const result = await completion;
    expect(stdout, stderr).not.toBe("");
    const evidence = JSON.parse(stdout) as {
      root: string;
      outerRoot: string;
      failure: string;
      pids: number[];
      closedBeforeCensus: boolean;
    };
    try {
      console.log(`${fault}: ${JSON.stringify({ result, ...evidence, stderr })}`);
      expect(result, stderr).toEqual({ code: 1, signal: null, groupJoined: true });
      expect(existsSync(evidence.outerRoot), "outer runner did not remove its own namespace").toBe(
        false,
      );
      expect(path.dirname(evidence.root)).toBe(
        realpathSync(fileURLToPath(new URL("../../.artifacts/ci-checkout/", import.meta.url))),
      );
      expect(existsSync(evidence.root), stderr).toBe(true);
      expect(
        evidence.pids.every((pid) => !isProcessAlive(pid)),
        "fixture left owned processes alive",
      ).toBe(true);
      expect(stderr).toContain(
        `Checkout fixture retained at ${evidence.root}; no completed report.`,
      );
      expect(stderr).toContain("Supervisor close: true; group extinction: true.");
      if (fault === "census") {
        expect(evidence.closedBeforeCensus).toBe(true);
        expect(evidence.pids).toHaveLength(3);
        expect(stderr).toContain("injected final census failure after direct child close");
        expect(existsSync(path.join(evidence.root, "report.json"))).toBe(false);
      } else if (fault === "timeout") {
        expect(evidence.pids).toHaveLength(2);
        expect(evidence.failure).toContain("did not close within 50000ms");
        expect(existsSync(path.join(evidence.root, "report.json"))).toBe(false);
      } else {
        expect(evidence.failure).not.toContain("unexpected completed report");
        expect(readFileSync(path.join(evidence.root, "report.json"), "utf8")).toBe("null");
      }
    } finally {
      await Promise.all(evidence.pids.map((pid) => waitForDead(pid, 4_000)));
      rmSync(evidence.root, { recursive: true, force: true });
    }
  },
  55_000,
);

it.skipIf(process.platform === "win32")(
  "waits for legal slow tree startup before cancellation",
  async () => {
    const report = await runCiGitStep({
      job: "checks-windows",
      env: { CHECKOUT_KIND: "platform" },
      fetchResults: ["hang"],
      scenario: "cancel-SIGTERM",
      startupDelay: { tree: 4_100 },
    });
    expect(report.code, report.output).toBe(143);
    expect(report.readyAttempts).toEqual([1]);
    expect(report.fetches).toHaveLength(1);
  },
  55_000,
);

it.skipIf(process.platform === "win32")(
  "reports owner exit and output instead of a cleanup readiness timeout",
  async () => {
    const report = await runCiGitStep({
      policy: 'print("owner exited before cleanup readiness", flush=True)\nraise SystemExit(23)\n',
      fetchResults: [],
      cancelDuringCleanup: true,
    });
    expect(report.code).toBe(23);
    expect(report.cancelledDuringCleanup).toBe(false);
    expect(report.output).toBe("owner exited before cleanup readiness\n");
    expect(report.readyAttempts).toEqual([]);
    expect(report.commands).toEqual([]);
  },
  55_000,
);

it("does not revive a terminated fixture instance when its PID is reused", () => {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      "-I",
      "-S",
      "-c",
      String.raw`
import contextlib, json, os, pathlib, runpy, subprocess, sys, tempfile

with tempfile.TemporaryDirectory(prefix="checkout-pid-reuse-") as directory:
    root = pathlib.Path(directory).resolve()
    workspace = root / "workspace"
    workspace.mkdir()
    records = root / "pids"
    records.mkdir()
    (root / "lease").write_text("owned")
    # Guard command scope while retaining the real OS liveness result.
    guard = root / "census.cjs"
    guard.write_text('''
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const spawnSync = cp.spawnSync;
const inspected = new Set();
cp.spawnSync = (command, args, options) => {
  if (command === "/bin/ps") {
    const index = args.indexOf("-p");
    assert(index >= 0 && args.filter(arg => arg === "-p").length === 1 && /^[1-9][0-9]*(?:,[1-9][0-9]*)*$/.test(args[index + 1]), "fixture census must query an explicit PID list");
    const selected = args[index + 1].split(",").map(Number);
    assert(process.platform === "linux" || selected.length === 1, "non-Linux census must query exactly one PID");
    assert(args.every(arg => !arg.startsWith("-") || ["-p", "-o"].includes(arg)), "fixture census must select owned PIDs only");
    const records = path.join(process.argv[3], "pids");
    const allowed = new Set(fs.readdirSync(records).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(records, name), "utf8"))).filter(record => !fs.existsSync(path.join(records, record.instance + ".dead"))).map(record => record.pid));
    for (const pid of selected) {
      assert(allowed.has(pid) && !inspected.has(pid), "fixture census escaped deduplicated registered ownership");
      inspected.add(pid);
    }
  }
  return spawnSync(command, args, options);
};
''' + "\nrequire(" + json.dumps(sys.argv[5]) + ").syncFixtureBuiltinExports();\n")
    with subprocess.Popen([sys.executable, "-I", "-S", "-c", "import sys; sys.stdin.read()"],
                          stdin=subprocess.PIPE) as child, contextlib.ExitStack() as cleanup:
        if os.name == "nt":
            broker = cleanup.enter_context(subprocess.Popen([
                sys.argv[1], "--input-type=module", "-e", """
const { createWindowsProcessCensus } = await import(process.argv[1]);
const owner = createWindowsProcessCensus({ root: process.argv[2], token: "owned",
  onFailure: error => { console.error(error); process.exitCode = 1; void owner.close(); } });
try {
  await owner.ready;
  console.log("ready");
  await new Promise(resolve => { process.stdin.once("end", resolve); process.stdin.resume(); });
} finally { await owner.close(); }
""", sys.argv[4], str(root)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True))
            # EOF retires the broker and sampler before the Python namespace owner leaves.
            cleanup.callback(lambda: broker.communicate(timeout=4))
            assert broker.stdout.readline().strip() == "ready", "census owner failed to initialize"
        retired = dict(pid=child.pid, role="grandchild", attempt=1, instance="retired")
        current = dict(pid=os.getpid(), role="grandchild", attempt=2, instance="current")
        if os.name == "nt":
            read_processes = runpy.run_path(sys.argv[3])["read_processes"]
            identities = read_processes([child.pid, os.getpid()])
            assert all(identity["alive"] for identity in identities)
            retired["creationTime"], current["creationTime"] = (
                identity["creationTime"] for identity in identities)
        child.communicate(timeout=10)
        (records / "retired.json").write_text(json.dumps(retired))
        (records / "current.json").write_text(json.dumps(current))
        (records / "sentinel.json").write_text(json.dumps(
            dict(current, role="sentinel", attempt=0, instance="sentinel")))

        def observe():
            subprocess.run([sys.argv[1], "--require", str(guard), sys.argv[2], "git", str(root), "early-leader-exit",
                            "-C", str(workspace), "checkout"], cwd=workspace, check=True)
            observed = json.loads((root / "events.jsonl").read_text().splitlines()[-1])
            assert observed["sentinelAlive"], "unrelated live sentinel was lost"
            return observed["alive"]

        assert observe() == [current], "first boundary must observe real child termination"
        # Fault-inject PID reuse only after actual death was observed. The fresh
        # instance at that live PID must remain visible, never hidden by retirement.
        retired["pid"] = current["pid"]
        (records / "retired.json").write_text(json.dumps(retired))
        assert observe() == [current], "a retired instance was revived by a reused PID"
        if os.name == "nt":
            # No death receipt exists for this instance: birth identity must
            # reject reuse even when no census observed the PID between lives.
            (records / "unobserved.json").write_text(json.dumps(
                dict(retired, instance="unobserved")))
            assert observe() == [current], "an unobserved retired birth was revived by PID reuse"
print("fixture lifetime contract passed")
`,
      process.execPath,
      ciCheckoutFixture,
      fileURLToPath(new URL("./fixtures/ci-windows-process-census.py", import.meta.url)),
      new URL("./fixtures/ci-windows-process-census.mjs", import.meta.url).href,
      fileURLToPath(new URL("./fixtures/ci-fixture-runtime.cjs", import.meta.url)),
    ],
    { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("fixture lifetime contract passed");
});

it.skipIf(process.platform === "win32")(
  "recognizes terminated POSIX groups without accepting live signal denials",
  () => {
    const owner = readFileSync(".github/actions/git-owner/owner.py", "utf8");
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-S",
        "-c",
        String.raw`
import ast, contextlib, errno, io, json, os, pathlib, re, signal, subprocess, sys, tempfile, time

# Load only the actual boundary functions; never execute checkout or real Git.
functions = [node for node in ast.parse(sys.stdin.read()).body
             if isinstance(node, ast.FunctionDef) and node.name in ("group_alive", "group_signal")]
assert len(functions) == 2
exec(compile(ast.Module(body=functions, type_ignores=[]), "checkout-owner.py", "exec"))

# Retain the Popen handle without polling, so the owned zombie cannot be reaped or reused.
with subprocess.Popen([sys.executable, "-I", "-S", "-c", "pass"], start_new_session=True) as child:
    deadline = time.monotonic() + 10
    while True:
        state = subprocess.run(["ps", "-o", "stat=", "-p", str(child.pid)],
                               check=True, capture_output=True, text=True).stdout.strip()
        if state.startswith("Z"):
            break
        assert time.monotonic() < deadline, "owned child did not terminate"
        time.sleep(0.01)
    assert not group_alive(child.pid, deadline), "zombies are terminated, not checkout writers"
    group_signal(child.pid, signal.SIGTERM, deadline)
    group_signal(child.pid, signal.SIGKILL, deadline)
    with tempfile.TemporaryDirectory(prefix="checkout-zombie-") as directory:
        root = pathlib.Path(directory).resolve()
        (root / "workspace").mkdir()
        (root / "pids").mkdir()
        (root / "lease").write_text("owned")
        for pid, role, attempt in [(child.pid, "grandchild", 1), (os.getpid(), "sentinel", 0)]:
            (root / "pids" / f"{pid}.json").write_text(json.dumps(dict(pid=pid, role=role, attempt=attempt, instance=str(pid))))
        subprocess.run([sys.argv[1], sys.argv[2], "git", str(root), "early-leader-exit",
                        "-C", str(root / "workspace"), "checkout"], cwd=root / "workspace", check=True)
        observed = json.loads((root / "events.jsonl").read_text())
        assert observed["alive"] == [], "fixture counted a terminated zombie as a live writer"
        assert observed["sentinelAlive"]

# Reap the session/group leader while its real descendant still owns the pipe.
# A PID-only query or Darwin's legacy -g must not lose that remaining writer.
with subprocess.Popen([sys.executable, "-I", "-S", "-c", """
import os, sys
if os.fork():
    os._exit(0)
print(os.getpid(), os.getpgrp(), os.getsid(0), flush=True)
sys.stdin.read()
"""], start_new_session=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as child:
    descendant, pgid, sid = map(int, child.stdout.readline().split())
    assert descendant != child.pid and pgid == sid == child.pid
    child.wait(timeout=2)
    actual_run = subprocess.run
    command_mode = os.environ.get("COMMAND_MODE")
    def scoped_census(command, **options):
        assert "-g" in command and command[command.index("-g") + 1] == str(pgid), "owner census must select its owned group/session"
        assert not set(command) & {"-a", "-A", "-e", "-x", "-axo", "-p"}, "owner census broadened or lost descendants"
        result = actual_run(command, **options)
        assert result.returncode == 0 and result.stderr == ""
        assert [int(line.split()[0]) for line in result.stdout.splitlines()] == [pgid]
        return result
    try:
        subprocess.run = scoped_census
        for mode in ("legacy", "unix2003"):
            os.environ["COMMAND_MODE"] = mode
            assert group_alive(pgid, time.monotonic() + 2), "reaped leader hid a live descendant"
            assert os.environ["COMMAND_MODE"] == mode, "query changed its owner's environment"
    finally:
        subprocess.run = actual_run
        if command_mode is None:
            os.environ.pop("COMMAND_MODE", None)
        else:
            os.environ["COMMAND_MODE"] = command_mode
        child.communicate(timeout=2)
    deadline = time.monotonic() + 2
    while group_alive(pgid, deadline):
        assert time.monotonic() < deadline, "descendant survived pipe closure"
        time.sleep(0.01)

# A denied signal is safe to normalize only if the same census proves extinction.
with subprocess.Popen([sys.executable, "-I", "-S", "-c",
                       "import sys; print('ready', flush=True); sys.stdin.read()"],
                      start_new_session=True, stdin=subprocess.PIPE,
                      stdout=subprocess.PIPE, text=True) as child:
    assert child.stdout.readline().strip() == "ready"
    actual_killpg = os.killpg
    def denied(pgid, signum):
        assert pgid == child.pid and signum in (0, signal.SIGTERM)
        raise PermissionError(errno.EPERM, "test-owned signal denial")
    actual_run = subprocess.run
    try:
        for probe in (actual_killpg, denied):
            os.killpg = probe
            for code, output, diagnostic in [
                (1, "", ""), (0, "", ""), (0, " \n", ""), (2, "", ""), (-9, "", ""),
                (1, f"{child.pid} Z\n", ""),
                (0, f"{child.pid} Z\n", "injected census diagnostic\n"),
                (1, "", "injected census diagnostic\n"),
                ("timeout", "", "injected census diagnostic\n"),
                (0, f"{child.pid} Z\nbroken\n", ""),
                (0, f"{child.pid} S\nbroken\n", ""),
                (0, f"{child.pid} Z", ""),
                (0, f"{os.getpgrp()} S\n", ""),
                (0, "invalid Z\n", ""),
                (0, f"{child.pid} Zbogus\n", ""),
                (0, f"{child.pid} Z extra\n", ""),
            ]:
                def census_result(command, **options):
                    if code == "timeout":
                        raise subprocess.TimeoutExpired(command, options["timeout"], stderr=diagnostic.encode())
                    result = subprocess.CompletedProcess(command, code, output, diagnostic)
                    if options.get("check"):
                        result.check_returncode()
                    return result
                subprocess.run = census_result
                captured = io.StringIO()
                with contextlib.redirect_stderr(captured):
                    try:
                        group_alive(child.pid, time.monotonic() + 2)
                    except (RuntimeError, ValueError, PermissionError, subprocess.SubprocessError):
                        pass
                    else:
                        raise AssertionError(f"ambiguous census accepted: {(code, output, diagnostic)!r}")
                assert captured.getvalue() == diagnostic, "census lost its diagnostic"
    finally:
        subprocess.run = actual_run
        os.killpg = actual_killpg
    os.killpg = denied
    try:
        try:
            group_signal(child.pid, signal.SIGTERM, time.monotonic() + 10)
        except PermissionError:
            pass
        else:
            raise AssertionError("live denied group was accepted as terminated")
    finally:
        os.killpg = actual_killpg
    # Force the real probe/query race: the group exists at killpg(0), then exits
    # before native ps selects it. Only the subsequent native ESRCH proves absence.
    def census_after_exit(command, **options):
        child.communicate(timeout=2)
        result = actual_run(command, **options)
        assert result.returncode == 1 and result.stdout == result.stderr == ""
        return result
    try:
        subprocess.run = census_after_exit
        assert not group_alive(child.pid, time.monotonic() + 2)
    finally:
        subprocess.run = actual_run
print("group contract passed")
`,
        process.execPath,
        ciCheckoutFixture,
      ],
      { input: owner, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("group contract passed");
  },
);

const diagnosticSecret = "synthetic-diagnostic-secret";
const diagnosticPrefix = "[ci-git-owner] diagnostic=";

function runOwnerDiagnostic(policy: string) {
  const result = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    ["-I", "-S", path.resolve(".github/actions/git-owner/owner.py"), "--policy", "-"],
    {
      input: `import ci_git_owner as owner, os, sys
secret = ${JSON.stringify(diagnosticSecret)}
sys.argv.append(secret)
os.environ["OWNER_DIAGNOSTIC_SECRET"] = secret
${policy}`,
      encoding: "utf8",
      timeout: 15_000,
      killSignal: "SIGKILL",
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(125);
  expect(result.signal).toBeNull();
  expect(result.stdout).toBe("");
  expect(result.stderr).not.toContain(diagnosticSecret);
  expect(result.stderr).not.toContain(process.cwd());
  expect(result.stderr).not.toContain("Traceback");
  const lines = result.stderr.trim().split(/\r?\n/u);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(
    /^::error::Git ownership\/setup failed \([A-Za-z]+\); refusing reuse or retry$/u,
  );
  expect(lines[1]?.startsWith(diagnosticPrefix)).toBe(true);
  expect(result.stderr.length).toBeLessThan(4_096);
  return { annotation: lines[0], diagnostic: lines[1]!.slice(diagnosticPrefix.length) };
}

it.each([
  { scenario: "direct denial", setup: "", types: ["PermissionError"] },
  {
    scenario: "timeout context",
    setup: "error.__context__ = owner.FetchTimeout()",
    types: ["PermissionError", "FetchTimeout"],
  },
  {
    scenario: "explicit cause before context",
    setup: "error.__cause__ = owner.FetchTimeout()\nerror.__context__ = ValueError(secret)",
    types: ["PermissionError", "FetchTimeout"],
  },
  {
    scenario: "cyclic context",
    setup: "error.__context__ = error",
    types: ["PermissionError"],
  },
  {
    scenario: "bounded context",
    setup:
      "cursor = error\nfor _ in range(8):\n    cursor.__context__ = RuntimeError(secret)\n    cursor = cursor.__context__",
    types: ["PermissionError", "RuntimeError", "RuntimeError", "RuntimeError"],
  },
])("retains bounded terminal diagnostics: $scenario", ({ scenario, setup, types }) => {
  const { diagnostic } = runOwnerDiagnostic(`
error = PermissionError(13, secret, secret + "/private-path")
error.winerror = 5
${setup}
raise error
`);
  const chain = JSON.parse(diagnostic) as { type: string; via: string; owner_frames: unknown[] }[];
  expect(chain.map((record) => record.type)).toEqual(types);
  expect(chain.map((record) => record.via)).toEqual([
    "terminal",
    ...types.slice(1).map(() => (scenario.startsWith("explicit") ? "cause" : "context")),
  ]);
  expect(chain[0]).toEqual({
    type: "PermissionError",
    via: "terminal",
    errno: 13,
    winerror: 5,
    owner_frames: [
      { function: "<module>", line: expect.any(Number) },
      { function: "main", line: expect.any(Number) },
    ],
  });
  for (const record of chain.slice(1)) {
    expect(record).toEqual({ type: record.type, via: record.via, owner_frames: [] });
  }
});

it.each([
  { errno: "secret", winerror: "True" },
  { errno: "2 ** 100", winerror: "-(2 ** 100)" },
  { errno: "type('NumericSecret', (int,), {})(13)", winerror: "None" },
])("redacts terminal diagnostic metadata ($errno, $winerror)", ({ errno, winerror }) => {
  const { annotation, diagnostic } = runOwnerDiagnostic(`
error = type(secret, (Exception,), {"__module__": "builtins"})(secret)
error.errno, error.winerror = ${errno}, ${winerror}
# Even the owner's filename and globals cannot turn policy code into owner source.
owner.diagnostic_error = error
exec(compile("def synthetic_diagnostic_secret():\\n    raise diagnostic_error\\nsynthetic_diagnostic_secret()",
             owner.__file__, "exec"), vars(owner))
`);
  expect(annotation).toContain("(unknown)");
  expect(JSON.parse(diagnostic)).toEqual([
    {
      type: "unknown",
      via: "terminal",
      owner_frames: [
        { function: "<module>", line: expect.any(Number) },
        { function: "main", line: expect.any(Number) },
      ],
    },
  ]);
});

it("bounds terminal diagnostics to the last six actual owner frames", () => {
  const { diagnostic } = runOwnerDiagnostic(`
import io, sys
owner.diagnostic_depth = 0
owner.diagnostic_policy = '''import ci_git_owner as owner, io, sys
owner.diagnostic_depth += 1
if owner.diagnostic_depth == 12:
    raise ValueError("synthetic-diagnostic-secret")
sys.stdin = io.StringIO(owner.diagnostic_policy)
owner.main()
'''
sys.stdin = io.StringIO(owner.diagnostic_policy)
owner.main()
`);
  expect(JSON.parse(diagnostic)).toEqual([
    {
      type: "ValueError",
      via: "terminal",
      owner_frames: Array.from({ length: 6 }, () => ({
        function: "main",
        line: expect.any(Number),
      })),
    },
  ]);
});

it.each(
  ["raises", "malformed traceback"].flatMap((fault) =>
    [false, true].map((cyclic) => ({ fault, cyclic })),
  ),
)("keeps terminal exit 125 with $fault metadata (cyclic=$cyclic)", ({ fault, cyclic }) => {
  const { diagnostic } = runOwnerDiagnostic(`
class BrokenMetadata(Exception):
    def __getattribute__(self, name):
        if name == "errno" and ${JSON.stringify(fault)} == "raises":
            raise SystemExit(42)
        if name == "__traceback__" and ${JSON.stringify(fault)} == "malformed traceback":
            return self
        return super().__getattribute__(name)
error = BrokenMetadata(secret)
if ${cyclic ? "True" : "False"}:
    error.__context__ = error
raise error
`);
  expect(diagnostic).toBe("unavailable");
});

it.each([...(process.platform === "win32" ? ["setup"] : []), "launch", "timeout-drain"])(
  "distinguishes terminal diagnostic failure sites: %s",
  (site) => {
    const { diagnostic } = runOwnerDiagnostic(String.raw`
import os, shlex, subprocess, sys, tempfile
site = ${JSON.stringify(site)}
if os.name == "nt":
    import ctypes as c
    from ctypes import wintypes as w
    kernel = c.WinDLL("kernel32", use_last_error=True)
    duplicate = kernel.DuplicateHandle
    duplicate.argtypes = [w.HANDLE, w.HANDLE, w.HANDLE, c.POINTER(w.HANDLE), w.DWORD, w.BOOL, w.DWORD]
    duplicate.restype = w.BOOL
    current = kernel.GetCurrentProcess
    current.argtypes, current.restype = [], w.HANDLE
    def restricted_call(actual, rights, *args):
        handle = w.HANDLE()
        if not duplicate(current(), args[0], current(), c.byref(handle), rights, False, 0):
            raise c.WinError(c.get_last_error())
        try:
            return actual(handle, *args[1:])
        finally:
            owner.close_handle(handle)
    if site == "setup":
        actual = owner.set_job
        owner.set_job = lambda *args: restricted_call(actual, 0x4, *args)
    elif site == "timeout-drain":
        actual = owner.query_job
        owner.query_job = lambda *args: restricted_call(actual, 0x8, *args)
elif site == "timeout-drain":
    actual_drain = owner.drain
    def denied_drain(*args):
        actual_drain(*args)
        raise PermissionError(13, secret)
    owner.drain = denied_drain

# No files are created or removed after deliberately unverified Job cleanup.
directory = tempfile.gettempdir()
if site == "launch":
    actual_popen = subprocess.Popen
    def invalid_executable(*args, **kwargs):
        kwargs["executable"] = directory
        return actual_popen(*args, **kwargs)
    subprocess.Popen = invalid_executable
alias = "!" + shlex.join([sys.executable.replace("\\", "/"), "-I", "-S", "-c", "import time; time.sleep(30)"])
owner.run_git(directory, "-c", "alias.diagnostic=" + alias, "diagnostic", timeout=0.1,
              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
`);
    const chain = JSON.parse(diagnostic) as {
      type: string;
      errno?: number;
      winerror?: number;
      owner_frames: { function: string; line: number }[];
    }[];
    expect(chain.map((record) => record.type)).toEqual(
      site === "timeout-drain"
        ? ["RuntimeError", "PermissionError", "FetchTimeout"]
        : ["PermissionError"],
    );
    const denial = expectDefined(
      chain.find((record) => record.type === "PermissionError"),
      "recorded permission denial",
    );
    expect(denial.errno).toBe(13);
    expect(denial.winerror).toBe(process.platform === "win32" ? 5 : undefined);
    expect(denial.owner_frames.map((frame) => frame.function)).toContain("run_git");
    expect(denial.owner_frames.some((frame) => frame.function === "drain")).toBe(
      process.platform === "win32" && site === "timeout-drain",
    );
    for (const frame of chain.flatMap((record) => record.owner_frames)) {
      expect(Number.isInteger(frame.line) && frame.line > 0).toBe(true);
      expect(["<module>", "main", "run_git", "drain"]).toContain(frame.function);
    }
  },
);
