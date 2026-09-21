import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const directory = ".artifacts/chromium-cache-benchmark";
const receiptPath = path.join(directory, "receipt.json");
const require = createRequire(import.meta.url);
const mode = process.argv[2];
// Fixed before the experiment from real-Gateway job 106183796561.
const criteria = { cpuCount: 8, memoryBytes: 33231855616, memoryToleranceBytes: 64 * 1024 ** 2 };

function readReceipt() {
  return JSON.parse(readFileSync(receiptPath, "utf8"));
}

function markdown(row) {
  return [
    "| Arm | Sample | Environment s | Browser setup s | Restore s | Installer s | Smoke s | Total setup s | Save s |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    "| " +
      [
        row.arm,
        row.sample,
        ...[
          "environmentMs",
          "browserSetupMs",
          "restoreMs",
          "installMs",
          "smokeMs",
          "totalSetupMs",
          "saveMs",
        ].map((key) => (typeof row[key] === "number" ? (row[key] / 1000).toFixed(3) : "n/a")),
      ].join(" | ") +
      " |",
    "",
    "Source: " +
      row.source +
      "; Node " +
      row.node +
      "; Playwright " +
      row.playwright +
      "; Chromium " +
      row.browserVersion +
      " (revision " +
      row.browserRevision +
      ").",
    "Actual CPUs: " +
      row.allocation.cpuCount +
      "; OS memory bytes: " +
      row.allocation.totalMemoryBytes +
      "; effective memory bytes: " +
      row.allocation.effectiveMemoryBytes +
      ".",
    "Browser setup includes archive restore, the unchanged pinned installer, and a real browser smoke/cleanup. Environment setup is separate. Cache-action logs own compressed bytes and transfer/extraction detail.",
    "",
  ].join("\n");
}

function save(row, report = false) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(row, null, 2) + "\n");
  writeFileSync(path.join(directory, "summary.md"), markdown(row));
  if (report && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(row));
  }
  console.log(JSON.stringify(row));
}

function allocation() {
  const rawCgroup = Object.fromEntries(
    [
      "/proc/self/cgroup",
      "/sys/fs/cgroup/cpu.max",
      "/sys/fs/cgroup/cpuset.cpus.effective",
      "/sys/fs/cgroup/memory.max",
      "/sys/fs/cgroup/memory.high",
      "/sys/fs/cgroup/memory.current",
    ].map((file) => {
      try {
        return [file, { value: readFileSync(file, "utf8").trim() }];
      } catch (error) {
        return [file, { unavailable: error.code }];
      }
    }),
  );
  const constrainedMemoryBytes = process.constrainedMemory();
  const rawLimit = rawCgroup["/sys/fs/cgroup/memory.max"]?.value;
  const cgroupLimit = rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : Infinity;
  const nodeLimit =
    Number.isSafeInteger(constrainedMemoryBytes) && constrainedMemoryBytes > 0
      ? constrainedMemoryBytes
      : Infinity;
  return {
    cpuCount: os.availableParallelism(),
    osLogicalCpuCount: os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    constrainedMemoryBytes,
    availableMemoryBytes: process.availableMemory(),
    effectiveMemoryBytes: Math.min(os.totalmem(), nodeLimit, cgroupLimit),
    loadAverage: os.loadavg(),
    rawCgroup,
  };
}

function qualifyAllocation(facts) {
  assert.equal(facts.cpuCount, criteria.cpuCount, "Unexpected actual CPU allocation");
  assert.equal(facts.osLogicalCpuCount, criteria.cpuCount, "Unexpected visible CPU allocation");
  for (const key of ["totalMemoryBytes", "effectiveMemoryBytes"]) {
    assert(
      Math.abs(facts[key] - criteria.memoryBytes) <= criteria.memoryToleranceBytes,
      key + " is outside the predeclared 64 MiB band",
    );
  }
}

async function pinnedExecutable(row) {
  const { chromium } = await import("playwright");
  const executable = chromium.executablePath();
  assert(executable.startsWith(row.browserRoot + path.sep));
  assert(existsSync(executable), "Pinned browser executable is absent");
  const version = execFileSync(executable, ["--version"], { encoding: "utf8" });
  assert(version.includes(row.browserVersion), "Pinned browser version differs");
  return chromium;
}

if (mode === "initialize") {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.equal(process.versions.node, "24.19.0");
  const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(source, process.env.GITHUB_SHA);
  assert.equal(source, process.env.BENCH_SOURCE);
  assert(["seed", "cold", "warm"].includes(process.env.BENCH_ARM));
  const browserRoot = path.resolve(".cache/chromium-cache-benchmark");
  assert(!existsSync(browserRoot), "Benchmark browser directory is not fresh");
  assert(!process.env.PLAYWRIGHT_BROWSERS_PATH, "Unexpected browser path override");
  const coreRoot = path.dirname(require.resolve("playwright-core/package.json"));
  const browser = JSON.parse(
    readFileSync(path.join(coreRoot, "browsers.json"), "utf8"),
  ).browsers.find((entry) => entry.name === "chromium");
  assert(browser?.revision && browser.browserVersion);
  const facts = allocation();
  qualifyAllocation(facts);
  const browserStartedMs = Date.now();
  const jobStartedMs = Number(process.env.BENCH_JOB_STARTED_MS);
  assert(Number.isFinite(jobStartedMs) && jobStartedMs <= browserStartedMs);
  appendFileSync(process.env.GITHUB_ENV, "PLAYWRIGHT_BROWSERS_PATH=" + browserRoot + "\n");
  save({
    schema: 1,
    source,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    arm: process.env.BENCH_ARM,
    sample: Number(process.env.BENCH_SAMPLE),
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    playwright: JSON.parse(readFileSync(require.resolve("playwright/package.json"), "utf8"))
      .version,
    lockSha256: createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex"),
    browserRevision: browser.revision,
    browserVersion: browser.browserVersion,
    browserRoot,
    cacheKey: process.env.BENCH_CACHE_KEY,
    cacheHit: false,
    restoreMs: 0,
    environmentMs: browserStartedMs - jobStartedMs,
    jobStartedMs,
    browserStartedMs,
    allocation: facts,
    criteria,
    verified: false,
    saveStepCompleted: false,
  });
} else if (mode === "restored") {
  const row = readReceipt();
  assert.equal(row.arm, "warm");
  assert.equal(process.env.BENCH_CACHE_HIT, "true");
  assert.equal(process.env.BENCH_MATCHED_KEY, row.cacheKey);
  row.restoreMs = Date.now() - row.browserStartedMs;
  await pinnedExecutable(row);
  row.cacheHit = true;
  save(row);
} else if (mode === "installed") {
  const row = readReceipt();
  const [start, end, code] = process.argv.slice(3).map(Number);
  assert(start >= row.browserStartedMs && end >= start && Number.isInteger(code));
  row.installMs = end - start;
  row.installExitCode = code;
  save(row);
  assert.equal(code, 0, "Pinned browser installation failed");
} else if (mode === "verify") {
  const row = readReceipt();
  assert.equal(row.installExitCode, 0);
  if (row.arm === "warm") {
    assert.equal(row.cacheHit, true);
    assert(
      !readFileSync(path.join(directory, "install.log"), "utf8").includes("Downloading "),
      "Restored consumer downloaded browser assets again",
    );
  }
  const start = Date.now();
  const chromium = await pinnedExecutable(row);
  const browser = await chromium.launch({ headless: true });
  try {
    assert.equal(browser.version(), row.browserVersion);
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    await page.setContent("<!doctype html><title>Chromium cache probe</title><p>ready</p>");
    assert.equal(await page.title(), "Chromium cache probe");
    assert.equal(await page.locator("p").textContent(), "ready");
    await context.close();
  } finally {
    await browser.close();
  }
  const end = Date.now();
  row.smokeMs = end - start;
  row.browserSetupMs = end - row.browserStartedMs;
  row.totalSetupMs = end - row.jobStartedMs;
  row.verified = true;
  const files = readdirSync(row.browserRoot, { recursive: true, withFileTypes: true }).filter(
    (entry) => entry.isFile(),
  );
  row.payload = {
    files: files.length,
    logicalBytes: files.reduce(
      (sum, entry) => sum + statSync(path.join(entry.parentPath, entry.name)).size,
      0,
    ),
  };
  save(row, row.arm !== "seed");
} else if (mode === "saved") {
  const row = readReceipt();
  assert.equal(row.arm, "seed");
  assert.equal(row.verified, true);
  row.saveMs = Date.now() - Number(process.env.BENCH_SAVE_STARTED_MS);
  assert(Number.isFinite(row.saveMs) && row.saveMs >= 0);
  row.saveStepCompleted = true;
  save(row, true);
} else if (mode === "summarize") {
  const rows = process.argv.slice(3).map((file) => JSON.parse(readFileSync(file, "utf8")));
  assert.equal(rows.length, 7);
  const seed = rows.find((row) => row.arm === "seed");
  assert(seed?.saveStepCompleted && seed.verified);
  assert(Number.isFinite(seed.saveMs) && seed.saveMs >= 0);
  for (const row of rows) {
    for (const key of [
      "schema",
      "source",
      "runId",
      "runAttempt",
      "node",
      "platform",
      "arch",
      "playwright",
      "lockSha256",
      "browserRevision",
      "browserVersion",
      "cacheKey",
    ]) {
      assert.equal(row[key], seed[key], key + " differs");
    }
    assert.deepEqual(row.criteria, criteria);
    qualifyAllocation(row.allocation);
    for (const file of [
      "/sys/fs/cgroup/cpu.max",
      "/sys/fs/cgroup/memory.max",
      "/sys/fs/cgroup/memory.high",
    ]) {
      assert.deepEqual(row.allocation.rawCgroup[file], seed.allocation.rawCgroup[file], file);
    }
    assert.equal(row.verified, true);
    assert.equal(row.installExitCode, 0);
    for (const key of [
      "environmentMs",
      "browserSetupMs",
      "restoreMs",
      "installMs",
      "smokeMs",
      "totalSetupMs",
    ]) {
      assert(Number.isFinite(row[key]) && row[key] >= 0, "Invalid " + key);
    }
  }
  const median = (values) => values.toSorted((a, b) => a - b)[1];
  const arms = ["cold", "warm"].map((arm) => {
    const selected = rows.filter((row) => row.arm === arm);
    assert.deepEqual(
      selected.map((row) => row.sample).toSorted((a, b) => a - b),
      [1, 2, 3],
    );
    if (arm === "warm") {
      assert(selected.every((row) => row.cacheHit));
    }
    return {
      arm,
      browserMedianMs: median(selected.map((row) => row.browserSetupMs)),
      totalMedianMs: median(selected.map((row) => row.totalSetupMs)),
      browserSumMs: selected.reduce((sum, row) => sum + row.browserSetupMs, 0),
      totalSumMs: selected.reduce((sum, row) => sum + row.totalSetupMs, 0),
    };
  });
  for (const key of ["totalMemoryBytes", "effectiveMemoryBytes"]) {
    const values = rows.map((row) => row.allocation[key]);
    assert(
      Math.max(...values) - Math.min(...values) <= criteria.memoryToleranceBytes,
      key + " differs by more than the predeclared 64 MiB cohort tolerance",
    );
  }
  for (const row of rows.toSorted((a, b) => a.sample - b.sample || a.arm.localeCompare(b.arm))) {
    console.log(markdown(row));
  }
  console.log(
    "Browser setup median cold/warm: " +
      arms.map((arm) => (arm.browserMedianMs / 1000).toFixed(3)).join(" / ") +
      "s",
  );
  console.log(
    "Complete environment+browser median cold/warm: " +
      arms.map((arm) => (arm.totalMedianMs / 1000).toFixed(3)).join(" / ") +
      "s",
  );
  console.log(
    "Producer browser+save: " + ((seed.browserSetupMs + seed.saveMs) / 1000).toFixed(3) + "s",
  );
  console.log(
    "Producer complete setup+save: " + ((seed.totalSetupMs + seed.saveMs) / 1000).toFixed(3) + "s",
  );
  console.log(
    "Three cold browser setups versus producer browser+save plus three warm: " +
      (arms[0].browserSumMs / 1000).toFixed(3) +
      " / " +
      ((seed.browserSetupMs + seed.saveMs + arms[1].browserSumMs) / 1000).toFixed(3) +
      "s",
  );
  console.log(
    "Three cold complete setups versus producer complete setup+save plus three warm: " +
      (arms[0].totalSumMs / 1000).toFixed(3) +
      " / " +
      ((seed.totalSetupMs + seed.saveMs + arms[1].totalSumMs) / 1000).toFixed(3) +
      "s",
  );
  console.log("These are measured job-work costs, not parallel workflow wall savings.");
} else {
  throw new Error("Expected initialize, restored, installed, verify, saved, or summarize");
}
