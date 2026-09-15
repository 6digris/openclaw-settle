import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
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
const decimal = z.string().regex(/^\d{1,20}$/u);
const requestSample = z.strictObject({
  callerPid: z.number().int().positive(),
  purpose: z.enum(["registration", "boundary", "exit", "cleanup"]),
  start: decimal,
  end: decimal,
});
const nativeSample = z
  .strictObject({
    emitter: z.literal("census"),
    phase: z.literal("sample"),
    sequence: z.number().int().positive(),
    pid: z.number().int().positive(),
    alive: z.boolean(),
    creationTime: decimal.nullable(),
    start: decimal.nullable(),
    end: decimal.nullable(),
    frequency: decimal.nullable(),
    clockError: z.number().int().nonnegative().nullable(),
    waitResult: z.union([z.literal(0), z.literal(258)]).nullable(),
    openError: z.literal(87).nullable(),
    inJob: z.boolean().nullable(),
    membershipError: z.number().int().nonnegative().nullable(),
    diagnosticError: z.boolean(),
    python: z
      .tuple([
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
      ])
      .optional(),
    request: requestSample.optional(),
  })
  .refine((sample) =>
    sample.openError === 87
      ? !sample.alive && sample.creationTime === null && sample.waitResult === null
      : sample.creationTime !== null &&
        sample.alive === (sample.waitResult === 258) &&
        sample.waitResult !== null,
  );
const diagnosticActor = z.strictObject({
  pid: z.number().int().positive(),
  creationTime: decimal.nullable(),
  role: z.enum(["parent", "child", "grandchild", "sentinel"]),
  attempt: z.number().int().nonnegative(),
  native: nativeSample,
});
const ownerSample = z.strictObject({
  emitter: z.literal("owner"),
  phase: z.enum([
    "job-created",
    "before-drain",
    "accounting",
    "accounting-error",
    "after-drain",
    "before-job-close",
  ]),
  ownerPid: z.number().int().positive(),
  ownerCreationTime: decimal,
  jobGeneration: z.number().int().positive(),
  jobHandle: decimal.nullable(),
  sequence: z.number().int().positive(),
  accounting: z
    .strictObject({
      result: z.number().int(),
      active: z.number().int().nonnegative().nullable(),
      total: z.number().int().nonnegative().nullable(),
      terminated: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  returnPath: z.enum(["normal", "exception"]).nullable(),
  exceptionType: z
    .enum([
      "OSError",
      "RuntimeError",
      "SystemExit",
      "KeyboardInterrupt",
      "FetchTimeout",
      "GitFailure",
      "other",
    ])
    .nullable(),
  errorCode: z.number().int().nonnegative().nullable(),
  actors: z.array(diagnosticActor).max(128),
  sentinel: diagnosticActor.nullable(),
  owner: nativeSample,
  bootstrap: nativeSample.nullable(),
});
const diagnosticRecord = z.union([
  nativeSample,
  ownerSample,
  z.strictObject({
    emitter: z.enum(["owner", "census"]),
    phase: z.literal("overflow"),
    request: requestSample.optional(),
  }),
  z.strictObject({
    emitter: z.literal("owner"),
    phase: z.literal("observation-error"),
    ownerPid: z.number().int().positive(),
    ownerCreationTime: decimal,
    jobGeneration: z.number().int().positive(),
    sequence: z.number().int().positive(),
  }),
]);
const diagnosticReport = z.strictObject({
  status: z.enum(["complete", "missing", "overflow", "invalid", "unavailable"]),
  records: z.array(diagnosticRecord).max(512),
  runtime: z
    .strictObject({
      node: z.string().regex(/^\d+\.\d+\.\d+$/u),
      windowsKernel: z.string().regex(/^\d+\.\d+\.\d+$/u),
    })
    .optional(),
});
export function projectWindowsCheckoutDiagnostics(value: unknown) {
  try {
    if (Buffer.byteLength(JSON.stringify(value) ?? "") > 512 * 1024) {
      return { status: "overflow" as const, records: [] };
    }
    const parsed = diagnosticReport.safeParse(value);
    if (!parsed.success) {
      return { status: "invalid" as const, records: [] };
    }
    const report = parsed.data;
    if (report.records.some((row) => row.phase === "overflow")) {
      report.status = "overflow";
    }
    const samples = report.records.flatMap((row) =>
      row.phase === "sample"
        ? [row]
        : "actors" in row
          ? [
              row.owner,
              ...row.actors.map((actor) => actor.native),
              ...(row.bootstrap ? [row.bootstrap] : []),
              ...(row.sentinel ? [row.sentinel.native] : []),
            ]
          : [],
    );
    if (
      report.status === "complete" &&
      (report.records.some((row) => row.phase === "observation-error") ||
        samples.some(
          (sample) =>
            sample.diagnosticError ||
            sample.clockError !== null ||
            sample.membershipError !== null ||
            sample.frequency === null ||
            sample.start === null ||
            sample.end === null,
        ))
    ) {
      report.status = "unavailable";
    }
    return report;
  } catch {
    return { status: "invalid" as const, records: [] };
  }
}
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
  windowsDiagnostics: z
    .unknown()
    .optional()
    .transform((value) =>
      value === undefined ? undefined : projectWindowsCheckoutDiagnostics(value),
    ),
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

export function renderGitTestClock(
  source: string,
  options: { realClock?: boolean; realDrain?: boolean; windowsDiagnosticsRoot?: string } = {},
): string {
  // Change Python before shell quoting, so injected clock literals cannot alter
  // the generated argument or reintroduce a pipe-backed source transport.
  const embedded = /^(run_owner ')([\s\S]*?)('\n# End generated CI Git owner\.)$/mu;
  if (embedded.test(source)) {
    return source.replace(embedded, (_match, prefix: string, body: string, suffix: string) => {
      const adjusted = renderGitTestClock(body.replaceAll("'\\''", "'"), options);
      return prefix + adjusted.replaceAll("'", "'\\''") + suffix;
    });
  }
  // Command deadlines and TERM grace are independent. Real-clock callers keep
  // real grace unless they explicitly opt into the fixture's immediate escalation.
  let clockSource =
    (options.realDrain ?? options.realClock)
      ? source
      : source.replace("kill_at = deadline - cleanup_seconds / 2", "kill_at = time.monotonic()");
  if (options.windowsDiagnosticsRoot) {
    const marker = "\ndef backoff(seconds):";
    // This private instrumentation was reviewed against this exact owner, not
    // arbitrary future ctypes bindings or a changed bootstrap/drain contract.
    if (
      createHash("sha256").update(source).digest("hex") !==
        "2e7fc4f936f819e46c0305efc4e60c000c30bca91d7d708f17de5d98e269738c" ||
      clockSource.split(marker).length !== 2
    ) {
      throw new Error("Windows diagnostic owner rendering drift");
    }
    const observer = fileURLToPath(
      new URL("./fixtures/ci-windows-process-census.py", import.meta.url),
    );
    clockSource = clockSource.replace(
      marker,
      `
if os.name == "nt":
    try:
        _ci_observer = {"__name__": "checkout_diagnostic"}
        with open(${JSON.stringify(observer)}, encoding="utf-8") as _ci_observer_file:
            exec(_ci_observer_file.read(), _ci_observer)
        _ci_observer["install_owner_observer"](globals(), ${JSON.stringify(options.windowsDiagnosticsRoot)})
    except BaseException:
        pass  # Missing observations cannot change the original owner outcome.
${marker}`,
    );
  }
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
