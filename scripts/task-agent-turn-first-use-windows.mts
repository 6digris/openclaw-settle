// Task-only fixed first-use experiment, derived from installed-cohort owner at 705856070e3ac46e9e12ba4d22f0c72d447edd64.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";
import { writeJsonAtomic } from "../src/infra/json-files.ts";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild, stopGatewayGracefully } from "./lib/gateway-bench-child.ts";
import {
  assertSeparatePaths,
  hashFile,
  hashInstall,
  installedPackageSchema,
  prepareInstalledPackage,
  verifyInstalledDependencyParity,
} from "./lib/gateway-bench-installed-package.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  classifyGatewayReadyLog,
  collectOutputLines,
  createGatewayBenchEnv,
  summarizeNumbers,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";
import { inspectManagedProcessGroup, runManagedCommand } from "./lib/managed-child-process.mts";

const inputSchema = installedPackageSchema.extend({
  comparison: installedPackageSchema.optional(),
});

const sampleSchema = z.object({
  index: z.number().int().nonnegative(),
  arm: z.enum(["baseline", "candidate"]).optional(),
  armIndex: z.number().int().nonnegative().optional(),
  phase: z.enum(["fresh", "established"]),
  outcome: z.enum(["not-run", "running", "passed", "failed"]),
  observations: z.record(z.string(), z.unknown()),
  errors: z.array(z.string()),
  stdout: z.string(),
  stderr: z.string(),
  readyMs: z.number().nonnegative().optional(),
});
const checkpointSchema = z
  .object({
    outcome: z.enum(["pending", "running", "cohort-passed", "failed"]),
    samples: z.array(sampleSchema).min(9).max(18),
  })
  .passthrough();
type Sample = z.infer<typeof sampleSchema>;

const stopListenersSchema = z.object({
  type: z.literal("openclaw-startup-benchmark:signal-listeners"),
  signal: z.literal("SIGINT"),
  pid: z.number().int().positive(),
  listenerCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  listeners: z
    .array(
      z.object({
        index: z.number().int().nonnegative().max(63),
        name: z.string().max(128),
        once: z.boolean(),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(64),
});

const FRESH_TIMEOUT_MS = 180_000;
const RESTART_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 60_000;
const TOKEN = "synthetic-internal-turn-probe-token";
const MARKER = "OPENCLAW_INTERNAL_TURN_PROBE_OK";
const pluginRoot = fileURLToPath(
  new URL("./fixtures/task-agent-turn-first-use/plugin/", import.meta.url),
);
const turnPayload = z
  .object({
    accepted: z.object({ runId: z.string().min(1), sessionKey: z.string() }).passthrough(),
    terminal: z.object({ status: z.literal("ok") }).passthrough(),
    timings: z.object({
      acceptanceMs: z.number().finite().nonnegative(),
      completionMs: z.number().finite().nonnegative(),
      historyReadMs: z.number().finite().nonnegative(),
    }),
    history: z
      .object({
        messages: z.array(
          z
            .object({
              role: z.string(),
              content: z
                .union([
                  z.string(),
                  z.array(
                    z
                      .object({
                        type: z.string(),
                        text: z.string().optional(),
                      })
                      .passthrough(),
                  ),
                ])
                .optional(),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
  })
  .passthrough();

function taskEnv(root: string, config: string) {
  return createGatewayBenchEnv(root, config, {
    startupTrace: false,
    caseEnv: {
      USERPROFILE: root,
      APPDATA: path.join(root, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(root, "AppData", "Local"),
      TEMP: path.join(root, "temp"),
      TMP: path.join(root, "temp"),
      TMPDIR: path.join(root, "temp"),
      NODE_COMPILE_CACHE: path.join(root, "compile-cache"),
      OPENAI_API_KEY: "synthetic-local-mock-key",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}),
    },
  });
}

type MockHandle = {
  port: number;
  requests: string;
  child: ReturnType<typeof spawn>;
  closed: Promise<{ code: number | null; signal: string | null }>;
};

async function stopMock(mock: MockHandle) {
  if (mock.child.exitCode === null && mock.child.signalCode === null) {
    mock.child.kill("SIGTERM");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      mock.closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Mock close not observed")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function plannedSamples(comparison = false): Sample[] {
  const samples: Sample[] = [];
  for (let armIndex = 0; armIndex < 9; armIndex += 1) {
    const order = comparison
      ? armIndex > 0 && armIndex % 2 === 0
        ? ["candidate", "baseline"]
        : ["baseline", "candidate"]
      : [undefined];
    for (const arm of order) {
      samples.push(
        sampleSchema.parse({
          index: samples.length,
          ...(comparison ? { arm, armIndex } : {}),
          phase: armIndex === 0 ? "fresh" : "established",
          outcome: "not-run",
          observations: {},
          errors: [],
          stdout: "",
          stderr: "",
        }),
      );
    }
  }
  return samples;
}

function summarizeComparison(samples: Sample[]) {
  const completion = z.object({ completedAtMs: z.number().nonnegative() });
  const rows = samples
    .filter((sample) => sample.phase === "established")
    .map((sample) => ({
      arm: sample.arm,
      armIndex: sample.armIndex,
      readyMs: z.number().nonnegative().parse(sample.readyMs),
      statusCompletedAtMs: completion.parse(sample.observations.status).completedAtMs,
      healthCompletedAtMs: completion.parse(sample.observations.health).completedAtMs,
    }));
  const baseline = rows.filter((row) => row.arm === "baseline");
  const candidate = rows.filter((row) => row.arm === "candidate");
  const summarize = (values: typeof rows) => ({
    readyMs: summarizeNumbers(values.map((value) => value.readyMs)),
    statusCompletedAtMs: summarizeNumbers(values.map((value) => value.statusCompletedAtMs)),
    healthCompletedAtMs: summarizeNumbers(values.map((value) => value.healthCompletedAtMs)),
  });
  const differences = baseline.map((left) => {
    const right = candidate.find((row) => row.armIndex === left.armIndex);
    assert.ok(right, "Established comparison pair is incomplete");
    return {
      arm: right.arm,
      armIndex: right.armIndex,
      readyMs: right.readyMs - left.readyMs,
      statusCompletedAtMs: right.statusCompletedAtMs - left.statusCompletedAtMs,
      healthCompletedAtMs: right.healthCompletedAtMs - left.healthCompletedAtMs,
    };
  });
  return {
    baseline: summarize(baseline),
    candidate: summarize(candidate),
    candidateMinusBaseline: summarize(differences),
  };
}

function observe(sample: Sample, name: string, value: unknown) {
  sample.observations[name] = value;
  console.log(
    `[gateway-startup-observation] ${JSON.stringify({ index: sample.index, phase: sample.phase, arm: sample.arm, armIndex: sample.armIndex, name, value })}`,
  );
}

async function firstRequests(port: number, startedAt: number, sample: Sample) {
  const client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  try {
    await client.waitOpen();
    const hello = await client.request("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        displayName: "startup-benchmark",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin"],
      auth: { token: TOKEN },
      caps: [],
    });
    observe(sample, "hello", hello);
    assert.equal(hello.ok, true, "Gateway connect failed");
    for (const [method, params] of [
      ["status", { includeChannelSummary: false }],
      ["health", { probe: true }],
    ] as const) {
      const requestedAt = performance.now();
      const response = await client.request(method, params);
      observe(sample, method, {
        requestedAtMs: requestedAt - startedAt,
        completedAtMs: performance.now() - startedAt,
        requestMs: performance.now() - requestedAt,
        response,
      });
      assert.equal(response.ok, true, `Gateway ${method} request failed`);
      assert.ok(
        response.payload && typeof response.payload === "object",
        `Gateway ${method} payload missing`,
      );
      if (method === "health") {
        assert.equal(
          "ok" in response.payload && response.payload.ok,
          true,
          "Gateway health response is invalid",
        );
      }
    }
    for (const kind of ["cold", "warm"] as const) {
      const sampleId = `${kind}-${randomUUID()}`;
      const requestedAt = performance.now();
      observe(sample, `${kind}Requested`, { sampleId, requestedAtMs: requestedAt - startedAt });
      const response = await client.request(
        "startup-internal-turn-probe.run",
        { sampleId },
        75_000,
      );
      observe(sample, kind, {
        sampleId,
        requestedAtMs: requestedAt - startedAt,
        completedAtMs: performance.now() - startedAt,
        roundTripMs: performance.now() - requestedAt,
        response,
      });
      assert.equal(response.ok, true, JSON.stringify(response));
      const payload = turnPayload.parse(response.payload);
      assert.equal(
        payload.accepted.sessionKey,
        `agent:main:subagent:startup-internal-turn-probe-${sampleId}`,
      );
      const text = payload.history.messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) =>
          typeof message.content === "string"
            ? [message.content]
            : (message.content ?? [])
                .filter((part) => part.type === "text")
                .map((part) => part.text ?? ""),
        )
        .join("\n");
      assert.ok(text.includes(MARKER), "Expected assistant marker missing from persisted history");
      observe(sample, `${kind}Verified`, {
        runId: payload.accepted.runId,
        timings: payload.timings,
        marker: true,
      });
    }
  } finally {
    if (client.ws.readyState !== 3) {
      const closed = new Promise<void>((resolve) => {
        client.ws.once("close", () => resolve());
      });
      const timer = setTimeout(() => client.ws.terminate(), 8_000);
      try {
        client.close();
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

async function runSample(params: {
  sample: Sample;
  entry: string;
  installRoot: string;
  root: string;
  config: string;
}) {
  const { sample } = params;
  const port = await getFreePort();
  const env = taskEnv(params.root, params.config);
  const stopPreload = new URL("./lib/gateway-bench-stop-preload.mjs", import.meta.url);
  stopPreload.searchParams.set("parentPid", String(process.pid));
  stopPreload.searchParams.set("entry", params.entry);
  stopPreload.searchParams.set("signalListeners", "1");
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--import",
      stopPreload.href,
      params.entry,
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
    ],
    { cwd: params.installRoot, env, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true },
  );
  observe(sample, "launch", {
    controllerPid: process.pid,
    pid: child.pid,
    port,
    stateRoot: params.root,
    startedAt: new Date().toISOString(),
  });
  let exited = false;
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
    exited = true;
  });
  child.once("exit", () => {
    exited = true;
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  const onStopListeners = (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "openclaw-startup-benchmark:signal-listeners"
    ) {
      return;
    }
    const parsed = stopListenersSchema.safeParse(message);
    if (!parsed.success) {
      sample.errors.push("Invalid stop listener diagnostic");
      return;
    }
    const value = parsed.data;
    if (
      value.pid !== child.pid ||
      value.listeners.length !== Math.min(value.listenerCount, 64) ||
      value.truncated !== value.listenerCount > 64 ||
      value.listeners.some((listener, index) => listener.index !== index) ||
      sample.observations.stopSignalListeners !== undefined
    ) {
      sample.errors.push("Inconsistent or duplicate stop listener diagnostic");
      return;
    }
    observe(sample, "stopSignalListeners", value);
  };
  child.on("message", onStopListeners);
  child.once("close", () => child.off("message", onStopListeners));
  const buffers = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    const pipe = child[stream];
    assert.ok(pipe, `Gateway ${stream} pipe missing`);
    pipe.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      sample[stream] += text;
      process[stream].write(chunk);
      const parsed = collectOutputLines(buffers[stream], text);
      buffers[stream] = parsed.carry;
      for (const line of parsed.lines) {
        const kind = classifyGatewayReadyLog(line);
        if (kind && sample.observations[kind] === undefined) {
          observe(sample, kind, { ms: performance.now() - startedAt, line });
        }
      }
    });
  }
  try {
    const deadlineAt =
      startedAt + (sample.phase === "fresh" ? FRESH_TIMEOUT_MS : RESTART_TIMEOUT_MS);
    const probe = async (name: "healthz" | "readyz") => {
      const result = await waitForInitialProbe({
        deadlineAt,
        isDone: () => exited,
        path: `/${name}`,
        port,
        startAt: startedAt,
      });
      observe(sample, name, result);
      return result;
    };
    const [healthz, readyz] = await Promise.all([probe("healthz"), probe("readyz")]);
    if (spawnError) {
      throw spawnError;
    }
    assert.equal(healthz.status, 200, "Gateway healthz failed");
    assert.equal(readyz.status, 200, "Gateway readyz failed");
    assert.ok(readyz.ms !== null, "Gateway never became ready");
    sample.readyMs = readyz.ms;
    await firstRequests(port, startedAt, sample);
  } catch (error) {
    sample.errors.push(String(error));
  } finally {
    try {
      assert.equal(exited, false, "Gateway exited before teardown");
      observe(sample, "shutdown", await stopGatewayGracefully(child, STOP_TIMEOUT_MS));
    } catch (error) {
      sample.errors.push(String(error));
      sample.observations.forcedCleanup = await stopChild(child);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Gateway close not observed after forced cleanup")),
              10_000,
            );
          }),
        ]);
      } catch (cleanupError) {
        sample.errors.push(String(cleanupError));
      } finally {
        clearTimeout(timer);
      }
    }
    if (sample.observations.stopSignalListeners === undefined) {
      sample.errors.push(
        "Stop listener diagnostic not received; listener ownership remains unknown",
      );
    }
    sample.outcome = sample.errors.length ? "failed" : "passed";
  }
  return sample.outcome;
}

type InstalledOptions = { inputPath: string; outputPath: string; child: boolean; argv: string[] };

async function runTaskFirstUse(options: InstalledOptions): Promise<number> {
  assert.equal(process.platform, "win32", "This frozen task proof is Windows only");
  const output = path.resolve(options.outputPath);
  const inputPath = path.resolve(options.inputPath);
  const input = inputSchema.parse(JSON.parse(await fs.readFile(inputPath, "utf8")));
  const plan = plannedSamples(input.comparison !== undefined);
  if (!options.child) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    // A retained failed attempt is immutable; callers choose a fresh artifact path.
    await fs.writeFile(output, JSON.stringify({ outcome: "pending", inputPath, samples: plan }), {
      flag: "wx",
    });
    let beforeCleanup: ReturnType<typeof inspectManagedProcessGroup> | undefined;
    let exitCode: number | undefined;
    let error: string | undefined;
    try {
      exitCode = await runManagedCommand({
        bin: process.execPath,
        args: [...process.execArgv, process.argv[1]!, ...options.argv, "--task-child"],
        shell: false,
        requireProcessTreeExit: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: (input.comparison ? 60 : 30) * 60_000,
        onReady(child) {
          child.stdout?.pipe(process.stdout, { end: false });
          child.stderr?.pipe(process.stderr, { end: false });
          child.once("exit", () => {
            beforeCleanup = inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" });
          });
        },
      });
    } catch (failure) {
      error = String(failure);
    }
    const outerSettlement = {
      outcome: "failed",
      beforeCleanup,
      exitCode,
      error,
      joined: exitCode !== undefined,
    };
    await writeJsonAtomic(`${output}.outer.json`, outerSettlement);
    let report: z.infer<typeof checkpointSchema>;
    try {
      report = checkpointSchema.parse(JSON.parse(await fs.readFile(output, "utf8")));
    } catch {
      return 1;
    } // Preserve malformed raw evidence alongside the independent settlement receipt.
    report.outerSettlement = outerSettlement;
    for (const sample of report.samples) {
      if (sample.outcome === "running") {
        sample.outcome = "failed";
        sample.errors.push("Benchmark controller ended before this launched sample settled");
      }
    }
    // Windows normal cleanup may kill lingering Job members and still return zero.
    // Require the pre-cleanup observation as well as the inner acknowledged stop.
    const passed =
      exitCode === 0 &&
      beforeCleanup === "dead" &&
      report.outcome === "cohort-passed" &&
      report.samples.length === plan.length &&
      report.samples.every(
        (sample, index) =>
          sample.index === index &&
          sample.phase === plan[index]?.phase &&
          sample.arm === plan[index]?.arm &&
          sample.armIndex === plan[index]?.armIndex &&
          sample.outcome === "passed" &&
          sample.readyMs !== undefined,
      );
    const finalReport = {
      ...report,
      outcome: passed ? "passed" : "failed",
      establishedReadySummary:
        passed && !input.comparison
          ? summarizeNumbers(
              report.samples
                .slice(1)
                .flatMap((sample) => (sample.readyMs === undefined ? [] : [sample.readyMs])),
            )
          : null,
      comparisonSummary: passed && input.comparison ? summarizeComparison(report.samples) : null,
    };
    outerSettlement.outcome = finalReport.outcome;
    await writeJsonAtomic(`${output}.outer.json`, outerSettlement);
    await writeJsonAtomic(output, finalReport);
    return passed ? 0 : 1;
  }

  const baseline = await prepareInstalledPackage(input);
  const comparison = input.comparison ? await prepareInstalledPackage(input.comparison) : undefined;
  const targets = comparison ? [baseline, comparison] : [baseline];
  if (comparison) {
    assert.equal(comparison.input.toolingSha, input.toolingSha, "Comparison tooling differs");
    assert.deepEqual(comparison.input.runtime, input.runtime, "Comparison runtime differs");
    for (const left of [baseline.installRoot, baseline.root]) {
      for (const right of [comparison.installRoot, comparison.root]) {
        assertSeparatePaths(left, right);
        assertSeparatePaths(right, left);
      }
    }
  }
  const dependencyParity = comparison
    ? await verifyInstalledDependencyParity(baseline, comparison)
    : undefined;
  let mock: MockHandle | undefined;
  const mockLogs: Awaited<ReturnType<typeof fs.open>>[] = [];
  let mockLogsClosed = false;
  const mockEvidence: {
    started?: { pid: number | undefined; port: number; requests: string };
    settlement?: Awaited<ReturnType<typeof stopMock>>;
  } = {};
  const configs = new Map<string, string>();
  const harnessFiles = [
    process.argv[1]!,
    ...[
      "gateway-bench-installed.ts",
      "gateway-bench-installed-package.ts",
      "gateway-bench-stop-preload.mjs",
      "gateway-bench-child.ts",
      "gateway-bench-runtime.ts",
      "gateway-bench-probes.ts",
      "gateway-ws-client.ts",
      "managed-child-process.mts",
      "managed-windows-job.mts",
      "managed-windows-job-launcher.mts",
    ].map((name) => fileURLToPath(new URL(`./lib/${name}`, import.meta.url))),
  ];
  harnessFiles.push(
    ...["index.cjs", "package.json", "openclaw.plugin.json"].map((name) =>
      path.join(pluginRoot, name),
    ),
    fileURLToPath(new URL("./e2e/mock-openai-server.mjs", import.meta.url)),
    fileURLToPath(new URL("./e2e/lib/fixtures/mock-openai-config.mjs", import.meta.url)),
  );
  const hashHarness = async () =>
    Object.fromEntries(
      await Promise.all(harnessFiles.map(async (file) => [file, await hashFile(file)])),
    );
  const samples = plan;
  const report = {
    artifactKind: "task-installed-internal-first-use",
    diagnostic: "sigint-listeners-before-stop",
    mock: mockEvidence,
    outcome: "running",
    input,
    buildInfo: baseline.buildInfo,
    comparison,
    dependencyParity,
    runtime: {
      executable: process.execPath,
      version: process.version,
      versions: process.versions,
      sha256: await hashFile(process.execPath),
      platform: process.platform,
      arch: process.arch,
    },
    host: {
      runner: process.env.RUNNER_NAME ?? null,
      image: process.env.ImageOS ?? null,
      imageVersion: process.env.ImageVersion ?? null,
      os: os.release(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemory: os.totalmem(),
    },
    limitations: [
      "Stop listener diagnostic only; timings do not qualify a performance comparison",
      "Listener hashes identify callback source, not which callback caused process exit",
      "Fresh is the first Gateway launch after fixture plugin installation, not empty state or cold filesystem",
      "Public runtime.subagent facade only; ordinary chat is not represented",
      "One synthetic local model, tools disabled; cold and warm are separate new sessions per process",
      comparison
        ? "Two immutable installs; separate state/cache; fresh A,B then eight alternating restart pairs"
        : "One immutable install; first sample is separate from eight retained-state restarts",
      "A dedicated runner is a new baseline, not a causal comparison to desktop measurements",
      "No synchronous process sampling or startup profiling; the stop-only preload is retained",
      "RPC success is recorded separately from plugin availability and degraded diagnostic facts",
    ],
    deadlines: {
      freshMs: FRESH_TIMEOUT_MS,
      restartMs: RESTART_TIMEOUT_MS,
      shutdownMs: STOP_TIMEOUT_MS,
    },
    before: baseline.before,
    harnessHashes: await hashHarness(),
    inputSha256: await hashFile(inputPath),
    after: undefined as Awaited<ReturnType<typeof hashInstall>> | undefined,
    samples,
    errors: [] as string[],
    establishedReadySummary: null as ReturnType<typeof summarizeNumbers>,
  };
  const save = () => writeJsonAtomic(output, report);
  await save();
  try {
    const root = path.join(path.dirname(output), "mock-state");
    await fs.mkdir(root);
    await fs.mkdir(path.join(root, "temp"));
    const port = await getFreePort();
    const requests = path.join(path.dirname(output), "mock-requests.jsonl");
    for (const name of ["stdout", "stderr"]) {
      mockLogs.push(await fs.open(path.join(path.dirname(output), `mock.${name}.log`), "wx"));
    }
    const [stdoutLog, stderrLog] = mockLogs;
    assert.ok(stdoutLog && stderrLog, "Both mock log handles must be open");
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./e2e/mock-openai-server.mjs", import.meta.url))],
      {
        env: {
          ...taskEnv(root, path.join(root, "unused-config.json")),
          MOCK_PORT: String(port),
          MOCK_BIND_HOST: "127.0.0.1",
          MOCK_REQUEST_LOG: requests,
          SUCCESS_MARKER: MARKER,
        },
        windowsHide: true,
        stdio: ["ignore", stdoutLog.fd, stderrLog.fd],
      },
    );
    const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    mock = { port, requests, child, closed };
    report.mock.started = { pid: child.pid, port, requests };
    await save();
    await Promise.all(mockLogs.map((log) => log.close()));
    mockLogsClosed = true;
    const deadline = performance.now() + 60_000;
    while (true) {
      if (spawnError) {
        throw spawnError;
      }
      assert.equal(child.exitCode, null, "Mock exited before readiness");
      assert.equal(child.signalCode, null, "Mock was signaled before readiness");
      assert.ok(performance.now() < deadline, "Mock readiness deadline exceeded");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        await response.arrayBuffer();
        if (response.ok) {
          break;
        }
      } catch {
        /* The bounded readiness loop admits the listener, not a model response. */
      }
      await delay(100);
    }
    for (const target of targets) {
      await fs.mkdir(target.root);
      await fs.mkdir(path.join(target.root, "temp"));
      const config = {
        ...structuredClone(BASE_GATEWAY_BENCH_CONFIG),
        agents: { defaults: { workspace: path.join(target.root, "workspace") } },
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: { mode: "token", token: TOKEN },
          controlUi: { enabled: false },
          tailscale: { mode: "off" },
        },
        plugins: { enabled: true },
      };
      applyMockOpenAiModelConfig(config, { mockPort: mock.port });
      const configPath = writeGatewayBenchConfig(target.root, config, {});
      const pluginLog = await fs.open(
        path.join(
          path.dirname(output),
          `${target === baseline ? "baseline" : "candidate"}-plugin-install.log`,
        ),
        "wx",
      );
      try {
        assert.equal(
          await runManagedCommand({
            bin: process.execPath,
            args: [
              target.entry,
              "plugins",
              "install",
              pluginRoot,
              "--force",
              "--accept-capabilities",
            ],
            cwd: target.installRoot,
            env: taskEnv(target.root, configPath),
            shell: false,
            stdio: ["ignore", pluginLog.fd, pluginLog.fd],
            timeoutMs: 120_000,
            requireProcessTreeExit: false,
          }),
          0,
          "Fixture plugin installation failed",
        );
      } finally {
        await pluginLog.close();
      }
      const installedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
      assert.equal(installedConfig.plugins.entries["startup-internal-turn-probe"].enabled, true);
      configs.set(target.root, configPath);
    }
    await save();
    for (const sample of samples) {
      sample.outcome = "running";
      const target = sample.arm === "candidate" ? comparison : baseline;
      assert.ok(target, "Planned sample has no installation");
      const config = configs.get(target.root);
      assert.ok(config, "Prepared installation has no config");
      sample.observations.stateRoot = target.root;
      await save();
      const outcome = await runSample({ sample, ...target, config });
      await save();
      console.log(
        `[gateway-startup-bench] installed ${sample.arm ?? "single"} ${sample.phase} ${sample.index}: ${sample.outcome} ready=${sample.readyMs ?? "missing"}ms`,
      );
      if (outcome !== "passed") {
        break;
      }
    }
  } catch (error) {
    report.errors.push(String(error));
    for (const sample of samples) {
      if (sample.outcome === "running") {
        sample.errors.push(String(error));
        sample.outcome = "failed";
      }
    }
  } finally {
    if (mock) {
      try {
        report.mock.settlement = await stopMock(mock);
      } catch (error) {
        report.errors.push(String(error));
      }
    }
    if (!mockLogsClosed) {
      try {
        await Promise.all(mockLogs.map((log) => log.close()));
      } catch (error) {
        report.errors.push(String(error));
      }
    }
    try {
      const passedSamples = samples.filter((sample) => sample.outcome === "passed").length;
      if (mock && passedSamples > 0) {
        const requests = (await fs.readFile(mock.requests, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const modelRequests = requests.filter(
          (request) => request.method === "POST" && request.path === "/v1/responses",
        );
        assert.ok(
          modelRequests.length >= passedSamples * 2,
          "Both turns in every successful sample must reach the local mock",
        );
      }
    } catch (error) {
      report.errors.push(String(error));
    }
    try {
      for (const target of targets) {
        target.after = await hashInstall(target.installRoot);
        assert.deepEqual(target.after, target.before, "Installed tree changed during measurement");
        assert.equal(
          await hashFile(target.input.tarball),
          target.input.candidate.sha256,
          "Package tarball changed during measurement",
        );
      }
      report.after = baseline.after;
      assert.equal(
        await hashFile(process.execPath),
        input.runtime.sha256,
        "Runtime changed during measurement",
      );
      assert.deepEqual(
        await hashHarness(),
        report.harnessHashes,
        "Benchmark helpers changed during measurement",
      );
      assert.equal(
        await hashFile(inputPath),
        report.inputSha256,
        "Benchmark input changed during measurement",
      );
    } catch (error) {
      report.errors.push(String(error));
    }
    report.outcome =
      !report.errors.length && samples.every((sample) => sample.outcome === "passed")
        ? "cohort-passed"
        : "failed";
    await save();
  }
  return report.outcome === "cohort-passed" ? 0 : 1;
}

const args = process.argv.slice(2);
assert.ok(
  args.length === 2 || (args.length === 3 && args[2] === "--task-child"),
  "Expected input.json output.json [--task-child]",
);
assert.ok(args[0] && args[1], "Input and output paths must be nonempty");
process.exitCode = await runTaskFirstUse({
  inputPath: args[0],
  outputPath: args[1],
  child: args[2] === "--task-child",
  argv: args.slice(0, 2),
});
