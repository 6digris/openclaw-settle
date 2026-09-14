#!/usr/bin/env node
// Standalone diagnostic: built-ins only. Never import tooling/candidate code or extract archives.
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const TOOLING = "56ea8d5fdc6734ee83414a7252a93ece850398c3";
const TARGET = "d69752a1c90715e74a36652b2e64c41e9409c5fd";
const BRANCH = "release/2026.9.2-mobile";
const REF = "refs/remotes/origin/mobile-authority-target";
const ORIGIN = "https://github.com/openclaw/openclaw";
const DEADLINE = 120_000;
const MiB = 1024 * 1024;
const SPARSE = [
  ".github/actions/mobile-release-authority",
  "scripts",
  "apps/mobile/version.json",
  "apps/android/version.json",
  "apps/android/Config/Version.properties",
  "apps/android/fastlane/metadata/android/en-US/release_notes.txt",
  "apps/ios/CHANGELOG.md",
];
// Retained cutter-closure.txt inventory; archived as data, never executed.
const CLOSURE = [
  "scripts/lib/android-version.ts",
  "scripts/lib/direct-run.mjs",
  "scripts/lib/ios-release-plan.ts",
  "scripts/lib/ios-version.ts",
  "scripts/lib/mobile-version.ts",
  "scripts/lib/release-version.mjs",
  "scripts/mobile-release-version.ts",
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const size = (name) => (fs.existsSync(name) ? fs.statSync(name).size : 0);
const self = fileURLToPath(import.meta.url);

// The measured Git child has exactly the authority's synchronous pipe/UTF-8
// wrapper. Only the enclosing Node worker is detached for owned-group cleanup.
function worker() {
  const spec = JSON.parse(process.argv[3]);
  process.send({ started: true });
  const start = performance.now();
  let stdout = "";
  let result = { status: 0, signal: null, code: null };
  try {
    stdout = execFileSync("git", spec.args, {
      encoding: "utf8",
      maxBuffer: 8 * MiB,
      stdio: [spec.input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
      timeout: spec.provisioning ? 600_000 : DEADLINE,
      ...(spec.input === undefined ? {} : { input: spec.input }),
    });
  } catch (error) {
    stdout = String(error.stdout ?? "");
    result = {
      status: error.status ?? null,
      signal: error.signal ?? null,
      code: error.code ?? null,
    };
  }
  process.send({ ...result, elapsedMs: performance.now() - start, stdout }, () =>
    process.disconnect(),
  );
}

function environment() {
  // Do not copy Actions tokens, user auth variables, Git config injection, or
  // trace selectors into Git. Preserve existing proxy and TLS/CA settings.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      /^(PATH|HOME|TMPDIR|LANG|LANGUAGE|TZ|RUNNER_TRACKING_ID|XDG_CONFIG_HOME|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|NODE_EXTRA_CA_CERTS)$/u.test(
        key,
      ) ||
      /^LC_/u.test(key) ||
      /^(https?|all|no)_proxy$/iu.test(key) ||
      /^GIT_SSL_(CAINFO|CAPATH|NO_VERIFY|VERSION|CIPHER_LIST)$/u.test(key)
    )
      env[key] = value;
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    SSH_ASKPASS: "/bin/false",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_TRACE2: "0",
    GIT_TRACE2_EVENT: "0",
    GIT_TRACE2_PERF: "0",
    GIT_TRACE2_CONFIG_PARAMS: "",
    GIT_TRACE2_ENV_VARS: "",
  };
}

// Inspect only processes in our fresh worker group; never match command names
// or kill unrelated Git jobs. Zombies cannot execute and are recorded separately.
function groupMembers(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return [];
  const members = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const fields = fs.readFileSync(`/proc/${entry}/stat`, "utf8").split(") ")[1].split(" ");
      if (Number(fields[2]) === pgid) members.push({ pid: Number(entry), state: fields[0] });
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes(error.code)) throw error;
    }
  }
  return members;
}
function signalGroup(pgid, signal) {
  if (!Number.isSafeInteger(pgid) || pgid <= 1) return;
  try {
    process.kill(-pgid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function main() {
  assert.equal(process.platform, "linux", "Linux process-group supervision is required");
  const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "mobile-authority-git-"));
  const out = path.join(process.env.RUNNER_TEMP, "mobile-authority-git-artifacts");
  fs.mkdirSync(out, { recursive: true });
  const fixture = path.join(root, "fixture");
  const empty = path.join(root, "empty-template");
  fs.mkdirSync(fixture);
  fs.mkdirSync(empty);
  const env = { ...environment(), GIT_TEMPLATE_DIR: empty };
  const mode = process.env.DIAGNOSTIC_CASE;
  const report = {
    diagnosticOnly: true,
    releaseQualification: false,
    case: mode,
    tooling: TOOLING,
    target: TARGET,
    source: process.env.GITHUB_SHA,
    versions: { node: process.version },
    commands: [],
    limits: {
      commandMs: DEADLINE,
      provisioningFetchMs: 600_000,
      cleanupGraceMs: 2_000,
      traceOrStderrBytes: 8 * MiB,
      archiveBytes: 128 * MiB,
      diskGrowthBytes: 4 * 1024 * MiB,
      maxObjects: 20_000,
      reportBytes: 4 * MiB,
      artifactFileBytes: 8 * MiB,
    },
    differences: [
      "Public HTTPS fixture: no checkout token, credential helpers, cookies, client credentials, or auth headers; proxy/TLS settings are preserved and not printed.",
      "Manual fixture provisioning reproduces the recorded all-branch/all-tag blob:none fetch, sparse cone setup, and pinned checkout. Only initial full-history provisioning fetch gets 600s (recorded checkout took >120s); measured fetch/archive deadlines remain 120s.",
      "Node execFileSync retains UTF-8, 8MiB stdout pipe, inherited stderr, default SIGTERM, and 120s timeout. Worker stderr inherits a bounded regular log descriptor rather than the Actions log pipe.",
      "Only the Node supervisor worker starts a new session/process group. If synchronous timeout does not return, the external guard starts owned-group cleanup after 120s plus 2s grace, then SIGKILL after 1s. Bounds/cancellation also clean that group; no broad kills. The runner tracking marker is retained for last-resort runner cleanup after an uncatchable supervisor SIGKILL.",
      "Local metadata probes set GIT_NO_LAZY_FETCH=1; cat-file batch-check alone uses piped stdin. Actual archives may lazy-fetch missing objects, and traces record that. No pre-archive object hydration is added.",
      "The seven-file comparison inventory is not a validated executable cutter replacement. Whole-scripts archive runs before the seven-file closure in the same fixture. Checkout/probes/first fetch/first archive warm state. Matrix cases use independent runners. Timings do not establish a causal fix.",
      "External attribute files must be absent. Empty init template, disabled hooks/fsmonitor and skipped LFS smudge prevent candidate execution. Disk/trace watchdog samples every 250ms; ceilings can overshoot between samples. No archives are extracted or uploaded.",
    ],
  };
  const save = () => {
    const text = JSON.stringify(report, null, 2) + "\n";
    assert.ok(Buffer.byteLength(text) <= 4 * MiB, "Report bound exceeded");
    fs.writeFileSync(path.join(out, "report.json"), text);
  };
  const initialFree = Number(fs.statfsSync(root).bavail) * Number(fs.statfsSync(root).bsize);
  let active;
  let cancelled;
  const cancel = (signal) => {
    cancelled = signal;
    if (active) signalGroup(active, "SIGTERM");
  };
  const cancelTerm = () => cancel("SIGTERM");
  const cancelInt = () => cancel("SIGINT");
  process.on("SIGTERM", cancelTerm);
  process.on("SIGINT", cancelInt);

  async function git(label, args, options = {}) {
    assert.ok(!cancelled, "Diagnostic cancelled");
    const stem = `${String(report.commands.length + 1).padStart(2, "0")}-${label}`;
    const files = ["event.jsonl", "perf.txt", "stderr.txt"].map((suffix) =>
      path.join(out, `${stem}.${suffix}`),
    );
    const commandEnv = {
      ...env,
      ...(options.noLazy ? { GIT_NO_LAZY_FETCH: "1" } : {}),
      ...(options.trace ? { GIT_TRACE2_EVENT: files[0], GIT_TRACE2_PERF: files[1] } : {}),
    };
    const fd = fs.openSync(files[2], "wx", 0o600);
    const spec = {
      args: ["-C", fixture, ...args],
      input: options.input,
      provisioning: options.provisioning,
    };
    const record = {
      label,
      args: spec.args,
      noLazyFetch: !!options.noLazy,
      timeoutMs: options.provisioning ? 600_000 : DEADLINE,
      stdin: options.input === undefined ? "ignore" : "pipe (metadata probe only)",
      trace: options.trace ? files.slice(0, 2).map((file) => path.basename(file)) : [],
      stderr: path.basename(files[2]),
      startedAt: new Date().toISOString(),
    };
    report.commands.push(record);
    save();
    const start = performance.now();
    const child = fork(self, ["--worker", JSON.stringify(spec)], {
      env: commandEnv,
      detached: true,
      stdio: ["ignore", "ignore", fd, "ipc"],
      execArgv: [],
    });
    fs.closeSync(fd);
    active = child.pid;
    let result;
    let stopReason;
    let deadline;
    let forceKill;
    let killSent = false;
    const stop = (reason) => {
      if (stopReason) return;
      stopReason = reason;
      signalGroup(child.pid, "SIGTERM");
      forceKill = setTimeout(() => {
        killSent = true;
        signalGroup(child.pid, "SIGKILL");
      }, 1_000);
    };
    // Includes startup failure, independently of the worker's started message.
    deadline = setTimeout(() => stop("worker-start-or-return-deadline"), record.timeoutMs + 2_000);
    const watchdog = setInterval(() => {
      try {
        const disk = fs.statfsSync(root);
        const free = Number(disk.bavail) * Number(disk.bsize);
        if (cancelled) stop(`cancelled-${cancelled}`);
        else if (files.some((file) => size(file) > 8 * MiB)) stop("trace-or-stderr-bound");
        else if (options.archive && size(options.archive) > 128 * MiB) stop("archive-bound");
        else if (initialFree - free > 4 * 1024 * MiB || free < 2 * 1024 * MiB) stop("disk-bound");
      } catch {
        stop("watchdog-error");
      }
    }, 250);
    child.on("message", (message) => {
      if (message.started) {
        clearTimeout(deadline);
        deadline = setTimeout(
          () => stop("wrapper-did-not-return-after-deadline"),
          record.timeoutMs + 2_000,
        );
      } else result = message;
    });
    const workerExit = await new Promise((resolve) => {
      child.once("error", (error) => resolve({ error: error.code }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(deadline);
    clearInterval(watchdog);
    clearTimeout(forceKill);
    let remaining = groupMembers(child.pid);
    const cleanup = { observedAfterWorker: remaining, term: !!stopReason, kill: killSent };
    if (remaining.some((entry) => entry.state !== "Z")) {
      cleanup.term = true;
      signalGroup(child.pid, "SIGTERM");
      await delay(1_000);
      remaining = groupMembers(child.pid);
      if (remaining.some((entry) => entry.state !== "Z")) {
        cleanup.kill = true;
        signalGroup(child.pid, "SIGKILL");
        await delay(100);
      }
    }
    cleanup.remaining = groupMembers(child.pid);
    const stdout = result?.stdout ?? "";
    Object.assign(record, {
      elapsedMs: performance.now() - start,
      gitElapsedMs: result?.elapsedMs ?? null,
      status: result?.status ?? null,
      signal: result?.signal ?? null,
      code: result?.code ?? null,
      stdoutBytes: Buffer.byteLength(stdout),
      stdoutSha256: sha256(stdout),
      workerExit,
      stopReason,
      cleanup,
    });
    for (const file of files) {
      if (size(file) > 8 * MiB) {
        fs.truncateSync(file, 8 * MiB);
        record.truncated = true;
      }
    }
    save();
    assert.ok(
      !cleanup.remaining.some((entry) => entry.state !== "Z"),
      "Owned Git processes survived cleanup",
    );
    assert.ok(!stopReason || stopReason.includes("deadline"), `Safety stop: ${stopReason}`);
    active = undefined;
    const ok = result?.status === 0 && !result?.code && !stopReason;
    if (!options.allowFailure) assert.ok(ok, `${label} failed; see command record`);
    return { ok, stdout, record };
  }
  const value = async (label, args) => (await git(label, args, { noLazy: true })).stdout.trim();
  const pin = async (label, ref, expected) =>
    assert.equal(await value(label, ["rev-parse", "--verify", ref]), expected, `${label} moved`);

  try {
    save();
    assert.ok(["baseline", "control"].includes(mode), "Unexpected diagnostic case");
    assert.equal(process.version, "v24.19.0", "Exact pinned Node runtime required");
    assert.ok(
      !Object.keys(process.env).some(
        (key) => /^GIT_CONFIG/u.test(key) || /^GIT_SSL_(CERT|KEY)/u.test(key),
      ),
      "Injected Git configuration or client credentials require review; refusing to silently discard proxy/TLS configuration",
    );
    report.versions.git = await value("git-version", ["--version"]);
    assert.equal(report.versions.git, "git version 2.55.0", "No Git installation/upgrade fallback");
    // Keep system/global proxy and TLS configuration, but refuse auth, trace,
    // executable hooks, or rewriting instead of copying human credentials.
    const forbidden = execFileSync("git", ["config", "--list", "--name-only"], {
      cwd: fixture,
      env,
      encoding: "utf8",
      maxBuffer: MiB,
      timeout: DEADLINE,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter((key) =>
        /^(credential\.|url\.|include|trace2\.)|^http\..*(extraheader|cookiefile|savecookies|sslcert|sslkey)$|^core\.(askpass|sshcommand|hookspath|fsmonitor)$/iu.test(
          key,
        ),
      );
    assert.equal(
      forbidden.length,
      0,
      "Unexpected inherited authentication/rewrite/trace/execution configuration (values withheld)",
    );
    for (const file of [".netrc", "_netrc", ".git-credentials"]) {
      assert.ok(
        !fs.existsSync(path.join(env.HOME, file)),
        "Unexpected credential file (not read/copied)",
      );
    }
    report.externalAttributes = [];
    for (const variable of ["GIT_ATTR_SYSTEM", "GIT_ATTR_GLOBAL"]) {
      const attributePath = await value("attribute-path", ["var", variable]);
      const present = !!attributePath && fs.existsSync(attributePath);
      report.externalAttributes.push({ source: variable, present });
      assert.ok(
        !present,
        "External attribute file requires review; refusing an unrecorded archive/filter input",
      );
    }
    await git("init", ["init"]);
    await git("origin", ["remote", "add", "origin", ORIGIN]);
    await git("gc-auto", ["config", "--local", "gc.auto", "0"]);
    await git("disable-hooks", ["config", "--local", "core.hooksPath", empty]);
    await git("disable-fsmonitor", ["config", "--local", "core.fsmonitor", "false"]);
    // Exact recorded checkout fetch: depth 0, all heads AND tags, sparse-induced filter.
    await git(
      "provision-full-history",
      [
        "-c",
        "protocol.version=2",
        "fetch",
        "--no-tags",
        "--prune",
        "--no-recurse-submodules",
        "--filter=blob:none",
        "origin",
        "+refs/heads/*:refs/remotes/origin/*",
        "+refs/tags/*:refs/tags/*",
      ],
      { provisioning: true, trace: true },
    );
    await git("sparse-cone", ["sparse-checkout", "init", "--cone"]);
    await git("sparse-paths", ["sparse-checkout", "set", ...SPARSE]);
    await git("checkout-tooling", ["checkout", "--progress", "--force", TOOLING], { trace: true });
    await pin("tooling-before", "HEAD", TOOLING);
    await pin("target-before", `refs/remotes/origin/${BRANCH}`, TARGET);
    const configKeys = [
      "core.repositoryformatversion",
      "core.bare",
      "core.filemode",
      "core.logallrefupdates",
      "core.sparsecheckout",
      "core.sparsecheckoutcone",
      "index.sparse",
      "gc.auto",
      "core.fsmonitor",
      "core.hookspath",
      "core.compression",
      "http.version",
      "http.sslverify",
      "http.sslversion",
      "http.postbuffer",
      "http.maxrequests",
      "pack.threads",
      "remote.origin.url",
      "remote.origin.fetch",
      "remote.origin.promisor",
      "remote.origin.partialclonefilter",
      "extensions.partialclone",
      "fetch.writecommitgraph",
      "fetch.negotiationalgorithm",
      "fetch.parallel",
      "maintenance.auto",
      "protocol.version",
    ];
    report.benignConfig = {};
    for (const key of configKeys) {
      const answer = await git("config", ["config", "--get-all", key], {
        noLazy: true,
        allowFailure: true,
      });
      assert.ok(answer.ok || answer.record.status === 1, "Config probe failed");
      if (answer.ok) report.benignConfig[key] = answer.stdout.trim();
    }
    assert.equal(report.benignConfig["remote.origin.url"], ORIGIN);
    assert.equal(report.benignConfig["remote.origin.promisor"], "true");
    assert.equal(report.benignConfig["remote.origin.partialclonefilter"], "blob:none");
    assert.equal(report.benignConfig["core.sparsecheckout"], "true");
    assert.equal(report.benignConfig["core.sparsecheckoutcone"], "true");
    report.sparsePatterns = fs.readFileSync(
      path.join(fixture, ".git/info/sparse-checkout"),
      "utf8",
    );
    report.shallowBefore = await value("shallow-before", ["rev-parse", "--is-shallow-repository"]);
    assert.equal(report.shallowBefore, "false", "Fixture must start with fetch-depth 0");
    const fetchArgs = [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--depth=33",
      "origin",
      `+refs/heads/${BRANCH}:${REF}`,
    ];
    const first = await git("fetch-1-depth33", fetchArgs, { trace: true, allowFailure: true });
    if (first.ok) {
      await pin("target-after-first", REF, TARGET);
      const secondArgs =
        mode === "baseline" ? fetchArgs : fetchArgs.filter((arg) => arg !== "--depth=33");
      await git(mode === "baseline" ? "fetch-2-depth33" : "fetch-2-no-depth", secondArgs, {
        trace: true,
        allowFailure: true,
      });
      await pin("target-after-second", REF, TARGET);
    } else
      report.secondFetchSkipped =
        "First fetch failed; a repeated-fetch comparison would not be valid";
    await pin("tooling-after-fetches", "HEAD", TOOLING);
    report.shallowAfter = await value("shallow-after", ["rev-parse", "--is-shallow-repository"]);
    report.objectCounts = await value("count-objects", ["count-objects", "-v"]);
    const tree = await value("script-attribute-inventory", [
      "ls-tree",
      "-r",
      TOOLING,
      "--",
      "scripts",
      ".gitattributes",
    ]);
    const objects = tree
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = /^(\d+) (blob|tree|commit) ([0-9a-f]{40})\t(.+)$/u.exec(line);
        assert.ok(match, "Unexpected tree entry");
        return { mode: match[1], type: match[2], oid: match[3], path: match[4] };
      });
    assert.ok(objects.length > 0 && objects.length <= 20_000, "Object inventory bound exceeded");
    assert.ok(
      objects.every((entry) => entry.type === "blob"),
      "Unexpected non-blob in archive scope",
    );
    for (const file of CLOSURE)
      assert.ok(
        objects.some((entry) => entry.path === file && ["100644", "100755"].includes(entry.mode)),
        "Closure file missing/not regular",
      );
    const availability = async (label) => {
      const checked = await git(
        label,
        ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        {
          noLazy: true,
          input: objects.map((entry) => entry.oid).join("\n") + "\n",
        },
      );
      const rows = checked.stdout.trim().split("\n");
      assert.equal(rows.length, objects.length, "Incomplete object availability probe");
      return objects.map((entry, index) => {
        const row = rows[index].split(" ");
        assert.equal(row[0], entry.oid);
        assert.ok(row[1] === "missing" || (row[1] === "blob" && /^\d+$/u.test(row[2])));
        return {
          ...entry,
          available: row[1] === "blob",
          bytes: row[1] === "blob" ? Number(row[2]) : null,
        };
      });
    };
    report.objectsBeforeWhole = await availability("availability-before-whole");
    report.archives = [];
    for (const [name, paths] of [
      ["whole-scripts", ["scripts"]],
      ["seven-file-closure", CLOSURE],
    ]) {
      if (name === "seven-file-closure")
        report.objectsBeforeClosure = await availability("availability-before-closure");
      const archive = path.join(root, name === "whole-scripts" ? "scripts.tar" : "closure.tar");
      const measured = await git(
        `archive-${name}`,
        ["archive", "--format=tar", `--output=${archive}`, TOOLING, "--", ...paths],
        { trace: true, allowFailure: true, archive },
      );
      const bytes = size(archive);
      assert.ok(bytes <= 128 * MiB, "Archive bound exceeded");
      const hash = createHash("sha256");
      if (fs.existsSync(archive))
        for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
      report.archives.push({
        name,
        paths,
        ok: measured.ok,
        bytes,
        sha256: fs.existsSync(archive) ? hash.digest("hex") : null,
        partial: !measured.ok,
      });
      fs.rmSync(archive, { force: true });
      save();
    }
    report.objectsAfterArchives = await availability("availability-after-archives");
    await pin("tooling-final", "HEAD", TOOLING);
    await pin("target-final", `refs/remotes/origin/${BRANCH}`, TARGET);
    if (first.ok) await pin("authority-target-final", REF, TARGET);
    const remote = await git(
      "remote-target-final",
      ["ls-remote", "--exit-code", "origin", `refs/heads/${BRANCH}`],
      { trace: true },
    );
    assert.equal(
      remote.stdout.trim(),
      `${TARGET}\trefs/heads/${BRANCH}`,
      "Remote target changed during diagnostic",
    );
    report.completed = true;
    report.measurementFailures = report.commands
      .filter(
        (entry) =>
          (entry.label.startsWith("fetch-") || entry.label.startsWith("archive-")) &&
          (entry.status !== 0 || entry.code || entry.stopReason),
      )
      .map((entry) => entry.label);
    if (report.measurementFailures.length) process.exitCode = 1;
  } catch (error) {
    // No command Error.message/stack: those can contain inherited stderr/auth.
    report.completed = false;
    report.failure =
      error instanceof assert.AssertionError
        ? error.message.slice(0, 500)
        : { name: error.name, code: error.code ?? null };
    process.exitCode = 1;
  } finally {
    if (active) {
      signalGroup(active, "SIGKILL");
      await delay(1_000);
      report.emergencyCleanup = groupMembers(active);
    }
    report.cancelled = cancelled ?? null;
    report.fixtureRetained = !!report.emergencyCleanup?.some((entry) => entry.state !== "Z");
    save();
    // Only our mkdtemp fixture; source checkout, logs and unrelated paths survive.
    if (!report.fixtureRetained) fs.rmSync(root, { recursive: true, force: true });
    process.removeListener("SIGTERM", cancelTerm);
    process.removeListener("SIGINT", cancelInt);
    console.log(
      `Diagnostic ${report.completed ? "completed" : "stopped"}; evidence: ${path.join(out, "report.json")}; NOT release qualification.`,
    );
  }
}

if (process.argv[2] === "--worker") worker();
else await main();
