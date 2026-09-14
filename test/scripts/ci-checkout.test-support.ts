import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import {
  inspectManagedProcessGroup,
  terminateManagedChild,
} from "../../scripts/lib/managed-child-process.mts";

type Step = { name?: string; run?: string; env?: Record<string, string | number> };
const processRecord = z.object({
  pid: z.number().int().positive(),
  role: z.string(),
  attempt: z.number().int().nonnegative(),
  instance: z.string(),
  creationTime: z.string().regex(/^\d+$/u).optional(),
});
const reportSchema = z.object({
  code: z.number().nullable(),
  cancelledDuringCleanup: z.boolean(),
  error: z.string().optional(),
  boundaries: z.array(
    z.object({ name: z.string(), alive: z.array(processRecord), sentinelAlive: z.boolean() }),
  ),
  readyAttempts: z.array(z.number()),
  cleanupRemaining: z.array(processRecord).length(0),
  ownedProcesses: z.array(processRecord),
  commands: z.array(
    z.object({
      tool: z.string(),
      cwd: z.string(),
      args: z.array(z.string()),
      configuration: z.array(z.string()).optional(),
      envProbe: z.string().optional(),
    }),
  ),
  output: z.string(),
});
type Report = z.infer<typeof reportSchema>;
type CloseResult = { code: number | null; signal: NodeJS.Signals | null };

export const ciCheckoutFixture = fileURLToPath(
  new URL("./fixtures/ci-platform-checkout.mjs", import.meta.url),
);
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8")) as {
  jobs: Record<string, { steps: Step[] }>;
};

export function readCiCheckoutStep(job: string, name = "Checkout"): Step & { run: string } {
  const step = workflow.jobs[job]?.steps.find((entry) => entry.name === name);
  if (!step?.run) {
    throw new Error(`Missing executable workflow step ${job}/${name}`);
  }
  return { ...step, run: step.run };
}

function replaceWindowsObservationAnchor(source: string, anchor: string, replacement: string) {
  if (source.split(anchor).length !== 2) {
    throw new Error("Windows checkout observation anchor mismatch");
  }
  return source.replace(anchor, replacement);
}

function renderWindowsCheckoutObservation(source: string): string {
  const replace = (anchor: string, replacement: string) => {
    source = replaceWindowsObservationAnchor(source, anchor, replacement);
  };
  replace(
    "def drain(child, job):",
    String.raw`# Test-rendered observation only: never replace the owner's cleanup or exit.
checkout_trace = None
checkout_fetch_count = 0


def checkout_diag_error(trace, error):
    try:
        if trace is not None:
            trace["complete"] = False
            trace["error"] = type(error).__name__[:64]
    except BaseException:
        pass


def checkout_diag_json(path):
    with open(path, "rb") as source:
        data = source.read(1025)
    if len(data) > 1024:
        raise ValueError("Oversized fixture record")
    return json.loads(data)


def checkout_diag_process(api, record, job):
    row = {key: record[key] for key in ("pid", "role", "attempt", "instance", "creationTime")}
    row["state"] = "unknown"
    handle = None
    try:
        handle = api["OpenProcess"](0x1000 | 0x100000, False, record["pid"])
        if not handle:
            row["openError"] = c.get_last_error()
            if row["openError"] == 87:
                row["state"] = "absent"
            return row
        times = [w.FILETIME() for _ in range(4)]
        if not api["GetProcessTimes"](handle, *(c.byref(value) for value in times)):
            row["timesError"] = c.get_last_error()
            return row
        row["observedCreationTime"] = str((times[0].dwHighDateTime << 32) | times[0].dwLowDateTime)
        if row["observedCreationTime"] != record["creationTime"]:
            row["state"] = "birth-mismatch"
            return row
        member = w.BOOL()
        if not api["IsProcessInJob"](handle, job, c.byref(member)):
            row["membershipError"] = c.get_last_error()
            return row
        row["inJob"] = bool(member.value)
        row["wait"] = int(api["WaitForSingleObject"](handle, 0))
        row["waitObservedNs"] = str(time.monotonic_ns())
        if row["wait"] in (0, 258):
            row["state"] = "sampled"
        else:
            row["waitError"] = c.get_last_error()
    except BaseException as error:
        row["error"] = type(error).__name__[:64]
    finally:
        if handle:
            try:
                row["handleClosed"] = bool(api["CloseHandle"](handle))
                if not row["handleClosed"]:
                    row["closeError"] = c.get_last_error()
                    row["state"] = "unknown"
            except BaseException as error:
                row["state"] = "unknown"
                row["closeError"] = type(error).__name__[:64]
    return row


def checkout_diag_start(child, job):
    global checkout_trace, checkout_fetch_count
    trace = None
    try:
        observed = str(time.monotonic_ns())
        checkout_fetch_count += 1
        if checkout_trace is None:
            checkout_trace = []
        if checkout_fetch_count > 2:
            return None
        trace = {"attempt": checkout_fetch_count, "bootstrapPid": child.pid,
                 "bootstrapWaitObservedNs": observed, "complete": False}
        checkout_trace.append(trace)
        if not job:
            raise ValueError("Missing owned Job")
        root = os.environ["TMPDIR"]
        attempt = checkout_diag_json(os.path.join(root, "tree-attempt.json"))
        if type(attempt) is not int or attempt != checkout_fetch_count:
            raise ValueError("Fixture attempt mismatch")
        ready = checkout_diag_json(os.path.join(root, f"ready-{attempt}.json"))
        if type(ready) is not int or ready != attempt:
            raise ValueError("Fixture tree not ready")
        actors, json_count = [], 0
        # Ten Git invocations + four descendants + sentinel/shell; each has at
        # most one PID record, retirement marker and atomic-write temporary.
        with os.scandir(os.path.join(root, "pids")) as entries:
            for index, entry in enumerate(entries):
                if index >= 48:
                    raise ValueError("Fixture inventory overflow")
                if not entry.name.endswith(".json"):
                    continue
                json_count += 1
                if json_count > 16 or not re.fullmatch(r"[1-9][0-9]{0,9}\.json", entry.name):
                    raise ValueError("Fixture PID inventory overflow")
                if not entry.is_file(follow_symlinks=False):
                    raise ValueError("Non-regular fixture record")
                record = checkout_diag_json(entry.path)
                if type(record) is not dict or type(record.get("attempt")) is not int:
                    raise ValueError("Invalid fixture record")
                if record["attempt"] == attempt:
                    actors.append(record)
        if len(actors) != 3 or {record.get("role") for record in actors} != {"parent", "child", "grandchild"}:
            raise ValueError("Incomplete fixture tree")
        for record in actors:
            pid, birth, instance = record.get("pid"), record.get("creationTime"), record.get("instance")
            if (type(pid) is not int or not 0 < pid <= 0xFFFFFFFF
                    or not isinstance(birth, str) or not re.fullmatch(r"[0-9]{1,20}", birth)
                    or not isinstance(instance, str)
                    or not re.fullmatch(r"[0-9a-f-]{36}-" + str(pid), instance)):
                raise ValueError("Invalid fixture actor identity")
        if len({record["pid"] for record in actors}) != 3:
            raise ValueError("Duplicate fixture PID")
        final_attempt = checkout_diag_json(os.path.join(root, "tree-attempt.json"))
        if type(final_attempt) is not int or final_attempt != attempt:
            raise ValueError("Fixture attempt changed")
        actors.sort(key=lambda record: ("parent", "child", "grandchild").index(record["role"]))
        # Fresh function objects keep diagnostics out of the owner's BOOL errcheck.
        library, api = c.WinDLL("kernel32", use_last_error=True), {}
        for name, result, arguments in (
            ("OpenProcess", w.HANDLE, (w.DWORD, w.BOOL, w.DWORD)),
            ("GetProcessTimes", w.BOOL, (w.HANDLE,) + (c.POINTER(w.FILETIME),) * 4),
            ("IsProcessInJob", w.BOOL, (w.HANDLE, w.HANDLE, c.POINTER(w.BOOL))),
            ("WaitForSingleObject", w.DWORD, (w.HANDLE, w.DWORD)),
            ("CloseHandle", w.BOOL, (w.HANDLE,)),
        ):
            function = library[name]
            function.restype, function.argtypes = result, arguments
            api[name] = function
        trace["beforeTerminate"] = [checkout_diag_process(api, record, job) for record in actors]
        return trace, actors, api
    except BaseException as error:
        checkout_diag_error(trace, error)
        return None


def checkout_diag_terminated(observation):
    trace = None
    try:
        if observation is not None:
            trace = observation[0]
            trace["terminateReturnedNs"] = str(time.monotonic_ns())
    except BaseException as error:
        checkout_diag_error(trace, error)


def checkout_diag_zero(observation, job, accounting):
    trace = None
    try:
        if observation is None:
            return
        trace, actors, api = observation
        trace["zeroAccountingObservedNs"] = str(time.monotonic_ns())
        trace["accounting"] = {"active": int(accounting.ActiveProcesses),
                               "total": int(accounting.TotalProcesses),
                               "terminated": int(accounting.TotalTerminatedProcesses)}
        trace["atZero"] = [checkout_diag_process(api, record, job) for record in actors]
        trace["complete"] = ("terminateReturnedNs" in trace
                             and all(row["state"] in ("absent", "sampled")
                                     for row in trace["beforeTerminate"] + trace["atZero"]))
    except BaseException as error:
        checkout_diag_error(trace, error)


def checkout_diag_emit(pending, exit_code):
    outcome = {"kind": "assigned-exit", "code": exit_code}
    if isinstance(pending, SystemExit):
        outcome = {"kind": "pending-SystemExit",
                   "code": pending.code if type(pending.code) is int else None}
    elif pending is not None:
        outcome = {"kind": "escaping-exception", "code": None}
    traces = checkout_trace or []
    payload = {"kind": "windows-checkout-owner-observation", "ownerOutcome": outcome,
               "python": {"executable": os.path.basename(sys.executable),
                          "version": ".".join(map(str, sys.version_info[:3]))},
               "git": {"executable": os.path.basename(git or ""),
                       "fixtureShim": os.path.normcase(os.path.abspath(git or "")) ==
                           os.path.normcase(os.path.join(os.environ["TMPDIR"], "bin", "git.cmd"))},
               "bash": {"executable": os.path.basename(os.environ.get("CI_CHECKOUT_DIAG_BASH", ""))[:64],
                        "version": os.environ.get("CI_CHECKOUT_DIAG_BASH_VERSION", "")[:64]},
               "fetches": traces,
               "complete": checkout_fetch_count == 2 and len(traces) == 2
                           and all(trace["complete"] for trace in traces)}
    data = (json.dumps(payload, separators=(",", ":")) + "\n").encode()
    if len(data) > 7168:
        data = b'{"kind":"windows-checkout-owner-observation","complete":false,"error":"output-overflow"}\n'
    os.write(2, data)


def drain(child, job, observe_fetch=False):`,
  );
  replace(
    "            reclaim_locks=False):",
    "            reclaim_locks=False, observe_fetch=False):",
  );
  replace(
    "timeout=fetch_timeout_seconds, reclaim_locks=True)",
    "timeout=fetch_timeout_seconds, reclaim_locks=True, observe_fetch=True)",
  );
  replace(
    "                drain(child, job)\n",
    "                drain(child, job, observe_fetch)\n",
  );
  replace(
    "        terminate_job(job, 1)\n",
    "        observation = checkout_diag_start(child, job) if observe_fetch else None\n" +
      "        terminate_job(job, 1)\n" +
      "        checkout_diag_terminated(observation)\n",
  );
  replace(
    "            if accounting.ActiveProcesses == 0:\n                return",
    "            if accounting.ActiveProcesses == 0:\n" +
      "                checkout_diag_zero(observation, job, accounting)\n" +
      "                return",
  );
  replace(
    "    except Exception as error:\n        exit_code, terminal_error = 125, error\n",
    "    except Exception as error:\n        exit_code, terminal_error = 125, error\n" +
      "    finally:\n" +
      "        try:\n" +
      "            checkout_diag_emit(sys.exc_info()[1], exit_code)\n" +
      "        except BaseException:\n" +
      "            pass  # Observation must preserve pending SystemExit and the original result.\n",
  );
  return source;
}

export function renderGitTestClock(
  source: string,
  options: { realClock?: boolean; realDrain?: boolean; observeWindowsExit?: boolean } = {},
): string {
  // Change Python before shell quoting, so injected clock literals cannot alter
  // the generated argument or reintroduce a pipe-backed source transport.
  const embedded = /^(run_owner ')([\s\S]*?)('\n# End generated CI Git owner\.)$/mu;
  if (embedded.test(source)) {
    const rendered = source.replace(
      embedded,
      (_match, prefix: string, body: string, suffix: string) => {
        const adjusted = renderGitTestClock(body.replaceAll("'\\''", "'"), options);
        return prefix + adjusted.replaceAll("'", "'\\''") + suffix;
      },
    );
    // The existing file branch stays inside this fixture's owned RUNNER_TEMP;
    // its release receipt controls removal after owner and census extinction.
    return options.observeWindowsExit
      ? replaceWindowsObservationAnchor(
          rendered,
          'run_owner() {\n  if [ "$RUNNER_OS" = "Linux" ]; then',
          "run_owner() {\n" +
            '  export CI_CHECKOUT_DIAG_BASH="${BASH##*/}" CI_CHECKOUT_DIAG_BASH_VERSION="$BASH_VERSION" || :\n' +
            '  if [ "$RUNNER_OS" = "Linux" ] || [ "$RUNNER_OS" = "Windows" ]; then',
        )
      : rendered;
  }
  if (options.observeWindowsExit) {
    source = renderWindowsCheckoutObservation(source);
  }
  // Command deadlines and TERM grace are independent. Real-clock callers keep
  // real grace unless they explicitly opt into the fixture's immediate escalation.
  const clockSource =
    (options.realDrain ?? options.realClock)
      ? source
      : source.replace("kill_at = deadline - cleanup_seconds / 2", "kill_at = time.monotonic()");
  if (options.realClock) {
    return clockSource;
  }
  // Only a ready, deliberately stalled tree advances the fetch clock. Real
  // process startup and teardown retain their independent wall-clock watchdogs.
  return (
    clockSource
      .replace(/fetch_timeout_seconds = [^\n]+/u, "fetch_timeout_seconds = 2")
      .replace(
        "def run_git(",
        `def fetch_clock():
    return 2 * sum(name.startswith("fetch-tick-") and name.endswith(".json")
                   for name in os.listdir(os.environ["TMPDIR"]))


def run_git(`,
      )
      .replace("deadline = time.monotonic() + timeout", "deadline = fetch_clock() + timeout")
      .replace(
        "deadline is not None and time.monotonic() >= deadline",
        "deadline is not None and fetch_clock() >= deadline",
      )
      .replace(/\btimeout=(?:30|60|120)(?=[,)])/gu, "timeout=2")
      .replace(
        /retry_at = time\.monotonic\(\) \+ [^\n]+/u,
        'print(f"fixture backoff: {seconds}", flush=True)\n    retry_at = time.monotonic() + 0.05',
      )
      .replace(/--((?:checkout-)?git) 120\b/gu, "--$1 2")
      // Keep pre-fix standalone shell bodies executable for red/green proof.
      .replaceAll("120s git", "2s git")
      .replaceAll("sleep $((attempt * 2))", 'echo "fixture backoff: $((attempt * 2))"')
      .replaceAll("sleep $((attempt * 5))", "sleep 0.05")
      .replaceAll("sleep 5", "sleep 0.05")
  );
}

export function expectCiCheckoutCleanup(report: Report) {
  assert.deepEqual(report.cleanupRemaining, [], "fixture cleanup left owned processes");
  assert.equal(report.boundaries.at(-1)?.name, "exit");
  assert(
    report.boundaries.every((entry) => entry.sentinelAlive),
    "unrelated process killed",
  );
  assert.deepEqual(
    report.boundaries.filter((entry) => entry.alive.length > 0),
    [],
    "Git descendants survived BEFORE deletion, reuse, consumption, or exit",
  );
}

export async function withCiCheckoutFixture<T>(
  scenario: string,
  prepare: (root: string) => NodeJS.ProcessEnv | void,
  inspect: (report: Report, result: CloseResult, stderr: string, root: string) => T | Promise<T>,
): Promise<T> {
  // Detached writers can outlive Vitest's oc-vt TMPDIR. Retained diagnostics must
  // start outside that recursively deleted namespace, including on setup failure.
  const artifacts = fileURLToPath(new URL("../../.artifacts/ci-checkout/", import.meta.url));
  mkdirSync(artifacts, { recursive: true });
  const root = realpathSync(mkdtempSync(path.join(artifacts, "checkout ")));
  let supervisor: ChildProcess;
  try {
    mkdirSync(path.join(root, "workspace"));
    const env = { ...process.env, ...prepare(root) };
    supervisor = fork(ciCheckoutFixture, ["supervise", root, scenario], {
      detached: true,
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env,
    });
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  let stderr = "";
  // An error can precede close, including failed spawn. Never reject this join.
  const closed = new Promise<CloseResult>((resolve) => {
    supervisor.once("close", (code, signal) => {
      resolve({ code, signal });
    });
  });
  supervisor.stderr?.on("data", (data) => (stderr += String(data)));
  supervisor.on("error", (error) => (stderr += `${error}\n`));
  let timer: NodeJS.Timeout | undefined;
  let report: Report | undefined;
  try {
    const completed = await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Checkout supervisor did not close within 50000ms")),
          50_000,
        );
      }),
    ]);
    clearTimeout(timer);
    report = reportSchema.parse(JSON.parse(readFileSync(path.join(root, "report.json"), "utf8")));
    return await inspect(report, completed, stderr, root);
  } finally {
    clearTimeout(timer);
    if (report) {
      // A consumer assertion failure does not revoke the producer's release receipt.
      rmSync(root, { recursive: true, force: true });
    } else {
      const deadline = Date.now() + 4_000;
      // Keep IPC attached through termination: explicit disconnect can suppress Node's close.
      // Let lease-bound Git descendants stop even if the supervisor cannot run cleanup.
      rmSync(path.join(root, "lease"), { force: true });
      const termination = terminateManagedChild(supervisor, "SIGKILL", {
        taskkillTimeoutMs: 2_000,
        processGroupFallback: "never",
      });
      const groupDead = () =>
        !supervisor.pid ||
        (process.platform === "win32"
          ? termination?.processTreeState === "terminated"
          : inspectManagedProcessGroup(supervisor, { errorPolicy: "indeterminate" }) === "dead");
      // Join actual close before checking extinction, sharing the original cleanup budget.
      const didClose = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
        }),
      ]);
      clearTimeout(timer);
      while (!groupDead()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          break;
        }
        await delay(Math.min(10, remaining));
      }
      console.error(
        `Checkout fixture retained at ${root}; no completed report. ` +
          `Supervisor close: ${didClose}; group extinction: ${groupDead()}. ` +
          `Inspect workflow.log and stop remaining owned writers before removing this exact directory.\n${stderr}`,
      );
    }
  }
}
