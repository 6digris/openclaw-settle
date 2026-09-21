import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const receiptDirectory = ".artifacts/windows-store-cache-benchmark";
const receiptPath = path.join(receiptDirectory, "receipt.json");
const mode = process.argv[2];

function markdown(receipt) {
  return [
    "| Arm | Sample | Setup total | Cache restore | Frozen install | Cache save | Store files | Store MiB |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    "| " +
      [
        receipt.arm,
        receipt.sample,
        (receipt.setupMs / 1000).toFixed(3),
        (receipt.restoreMs / 1000).toFixed(3),
        (receipt.installMs / 1000).toFixed(3),
        receipt.saveMs === null ? "n/a" : (receipt.saveMs / 1000).toFixed(3),
        receipt.store.files,
        (receipt.store.bytes / 1024 / 1024).toFixed(1),
      ].join(" | ") +
      " |",
    "",
    "Source: " +
      receipt.source +
      "; Node: " +
      receipt.node +
      "; pnpm: " +
      receipt.pnpm +
      "; CPUs: " +
      receipt.availableParallelism +
      "; RAM GiB: " +
      (receipt.memoryBytes / 1024 ** 3).toFixed(2) +
      ".",
    "Store size is logical file bytes. Cache-action logs own compressed archive size and extraction detail.",
    "Setup includes Node, pnpm bootstrap, cache restore, and install; checkout and the native dependency smoke are separate.",
    "",
  ].join("\n");
}

function save(receipt, publishSummary) {
  mkdirSync(receiptDirectory, { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  const summary = markdown(receipt);
  writeFileSync(path.join(receiptDirectory, "summary.md"), summary);
  if (publishSummary && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  console.log(JSON.stringify(receipt));
}

function storeSize(root) {
  let files = 0;
  let bytes = 0;
  let links = 0;
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      links++;
    } else if (entry.isFile()) {
      files++;
      bytes += statSync(path.join(entry.parentPath, entry.name)).size;
    }
  }
  return { files, bytes, links };
}

if (mode === "record") {
  const [installStart, installEnd, exitCode] = process.argv.slice(3).map(Number);
  const setupStart = Number(process.env.BENCH_SETUP_STARTED_MS);
  assert(installStart >= setupStart && installEnd >= installStart);
  assert(Number.isInteger(exitCode));
  const arm = process.env.BENCH_ARM;
  assert(["seed", "cold", "warm"].includes(arm));
  const source = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(source, process.env.BENCH_SOURCE);
  assert.equal(process.platform, "win32");
  assert.equal(process.versions.node, process.env.BENCH_NODE_VERSION);
  if (arm === "warm") {
    assert.equal(process.env.BENCH_CACHE_HIT, "true");
    assert.equal(process.env.BENCH_CACHE_MATCHED_KEY, process.env.BENCH_CACHE_KEY);
  }
  const storePath = process.env.PNPM_CONFIG_STORE_DIR || process.env.BENCH_OBSERVED_STORE_PATH;
  assert(storePath);
  const progress = [
    ...readFileSync(path.join(receiptDirectory, "install.log"), "utf8").matchAll(
      /Progress: resolved (\d+), reused (\d+), downloaded (\d+), added (\d+)/g,
    ),
  ].at(-1);
  if (exitCode === 0 && arm !== "seed") {
    assert(progress, "Install did not report package reuse");
    if (arm === "cold") {
      assert.equal(Number(progress[2]), 0, "Cold install reused existing package content");
    } else {
      assert(Number(progress[2]) > 0, "Restored-store install did not reuse package content");
    }
  }
  save(
    {
      schema: 1,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      source,
      lockSha256: createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex"),
      arm,
      sample: Number(process.env.BENCH_SAMPLE),
      node: process.versions.node,
      pnpm: process.env.BENCH_PNPM_VERSION,
      platform: process.platform,
      arch: process.arch,
      runner: process.env.RUNNER_NAME,
      availableParallelism: os.availableParallelism(),
      memoryBytes: os.totalmem(),
      setupMs: installEnd - setupStart,
      restoreMs: Number(process.env.BENCH_RESTORE_MS || 0),
      installMs: installEnd - installStart,
      saveMs: null,
      saveStepCompleted: false,
      cacheHit: arm === "warm",
      cacheKey: process.env.BENCH_CACHE_KEY,
      installExitCode: exitCode,
      installProgress: progress
        ? {
            resolved: Number(progress[1]),
            reused: Number(progress[2]),
            downloaded: Number(progress[3]),
            added: Number(progress[4]),
          }
        : null,
      nativeSmoke: false,
      store: storeSize(storePath),
    },
    false,
  );
} else if (mode === "verify") {
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.installExitCode, 0);
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  require("esbuild").transformSync("const answer: number = 42", { loader: "ts" });
  require("koffi");
  require("@lydell/node-pty");
  receipt.nativeSmoke = true;
  save(receipt, receipt.arm !== "seed");
} else if (mode === "saved") {
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.arm, "seed");
  assert.equal(receipt.nativeSmoke, true);
  receipt.saveMs = Date.now() - Number(process.env.BENCH_SAVE_STARTED_MS);
  assert(Number.isFinite(receipt.saveMs) && receipt.saveMs >= 0);
  receipt.saveStepCompleted = true;
  save(receipt, true);
} else if (mode === "summarize") {
  const receipts = process.argv.slice(3).map((file) => JSON.parse(readFileSync(file, "utf8")));
  assert.equal(receipts.length, 7, "Expected one producer and six consumer receipts");
  const seed = receipts.find((receipt) => receipt.arm === "seed");
  assert(seed?.saveStepCompleted && seed.nativeSmoke);
  for (const receipt of receipts) {
    for (const key of [
      "runId",
      "runAttempt",
      "source",
      "lockSha256",
      "node",
      "pnpm",
      "platform",
      "arch",
      "cacheKey",
      "availableParallelism",
      "memoryBytes",
    ]) {
      assert.equal(receipt[key], seed[key], key + " differs across the comparison");
    }
    assert.equal(receipt.installExitCode, 0);
    assert.equal(receipt.nativeSmoke, true);
    assert.equal(receipt.platform, "win32");
    if (receipt.arm === "cold") {
      assert(receipt.installProgress, "Cold install did not report package reuse");
      assert.equal(
        receipt.installProgress.reused,
        0,
        "Cold install reused existing package content",
      );
    }
  }
  const median = (values) => values.toSorted((a, b) => a - b)[1];
  const arms = ["cold", "warm"].map((arm) => {
    const rows = receipts.filter((receipt) => receipt.arm === arm);
    assert.deepEqual(
      rows.map((receipt) => receipt.sample).toSorted((a, b) => a - b),
      [1, 2, 3],
    );
    if (arm === "warm") {
      assert(rows.every((receipt) => receipt.cacheHit));
      assert(
        rows.every((receipt) => receipt.installProgress?.reused > 0),
        "Restored-store installs did not report package reuse",
      );
    }
    return { arm, setup: median(rows.map((receipt) => receipt.setupMs)) };
  });
  for (const receipt of receipts.toSorted(
    (a, b) => a.sample - b.sample || a.arm.localeCompare(b.arm),
  )) {
    console.log(markdown(receipt));
  }
  console.log("Median cold setup: " + (arms[0].setup / 1000).toFixed(3) + "s");
  console.log("Median restored-store setup: " + (arms[1].setup / 1000).toFixed(3) + "s");
  console.log("Median setup saving: " + ((arms[0].setup - arms[1].setup) / 1000).toFixed(3) + "s");
  console.log(
    "Producer setup + save: " +
      ((seed.setupMs + seed.saveMs) / 1000).toFixed(3) +
      "s (separate overhead)",
  );
} else {
  throw new Error("Usage: windows-store-cache-benchmark.mjs record|verify|saved|summarize");
}
