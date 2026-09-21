import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const bundle = path.dirname(fileURLToPath(import.meta.url));
const binding = JSON.parse(fs.readFileSync(path.join(bundle, "binding.json"), "utf8"));
const mode = process.argv[2];
const standaloneGroups = binding.standaloneGroups;
const normalPlan = [
  {
    name: "cohort-1",
    kind: "cohort",
    args: ["--skip", "AppStateIsolationTests|ProfileChatPreferencesTests"],
  },
  ...standaloneGroups.flatMap((group) =>
    Array.from({ length: 20 }, (_, index) => ({
      name: group.name + "-" + String(index + 1).padStart(2, "0"),
      kind: "standalone",
      sourceFile: group.sourceFile,
      expectedSuites: group.suites,
      args: ["--filter", group.filter],
    })),
  ),
  ...[2, 3].map((index) => ({
    name: "cohort-" + index,
    kind: "cohort",
    args: ["--skip", "AppStateIsolationTests|ProfileChatPreferencesTests"],
  })),
];
if (mode === "--plan-only") {
  console.log(
    JSON.stringify(
      {
        mode: "plan-only",
        binding: binding.candidateSha,
        normalBuilds: 1,
        normalInvocations: normalPlan.length,
        normalPlan,
        controls: binding.controls,
        controlsCountTowardNormalProof: false,
      },
      null,
      2,
    ),
  );
} else if (mode === "--run") {
  await run();
} else {
  throw new Error("Select --plan-only or --run explicitly");
}

async function run() {
  if (
    process.platform !== "darwin" ||
    process.env.CI !== "true" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.RUNNER_OS !== "macOS"
  ) {
    throw new Error("This task proof runs only in the approved disposable hosted macOS job");
  }
  if (
    !binding.bound ||
    !/^[0-9a-f]{40}$/.test(binding.candidateSha) ||
    binding.candidateSha !== process.env.PROOF_CANDIDATE_SHA ||
    binding.toolingSha !== process.env.PROOF_TOOLING_SHA
  ) {
    throw new Error("Proof binding is absent or does not match the workflow");
  }
  const repo = fs.realpathSync(process.env.GITHUB_WORKSPACE);
  const root = path.join(process.env.RUNNER_TEMP, "native-deflake-proof");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const initialMs = Number(process.env.PROOF_STARTED_MS);
  if (!Number.isFinite(initialMs) || initialMs <= 0 || Date.now() < initialMs) {
    throw new Error("Missing or invalid job-start timestamp");
  }
  const remainingAtStart = 50 * 60_000 - (Date.now() - initialMs);
  const monotonicStart = process.hrtime.bigint();
  const remaining = () =>
    remainingAtStart - Number(process.hrtime.bigint() - monotonicStart) / 1_000_000;
  const report = {
    schema: 1,
    candidateSha: binding.candidateSha,
    toolingSha: binding.toolingSha,
    baselineSha: binding.baselineSha,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    state: "running",
    normal: [],
    controls: [],
    commands: [],
    cleanupUncertain: false,
  };
  const writeReport = () => {
    const temporary = path.join(root, "proof.json.tmp");
    fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, path.join(root, "proof.json"));
  };
  const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const gitRead = (...args) =>
    execFileSync("/usr/bin/git", args, {
      cwd: repo,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const verifySource = (spec) => {
    if (gitRead("rev-parse", "HEAD") !== spec.sha) throw new Error("Source HEAD moved");
    for (const [relative, expected] of Object.entries(spec.hashes)) {
      const file = path.join(repo, relative);
      if (
        expected === null ? fs.existsSync(file) : !fs.existsSync(file) || hash(file) !== expected
      ) {
        throw new Error("Source hash mismatch: " + relative);
      }
    }
    const changed = gitRead("diff", "HEAD", "--name-only").split("\n").filter(Boolean).sort();
    if (JSON.stringify(changed) !== JSON.stringify([...spec.changedPaths].sort())) {
      throw new Error("Unexpected tracked source modifications: " + changed.join(", "));
    }
    return { sha: spec.sha, hashes: spec.hashes, changedPaths: changed };
  };
  verifySource(binding.states.candidate);
  const { runManagedCommand } = await import(
    pathToFileURL(path.join(repo, "scripts/lib/managed-child-process.mts"))
  );
  const activeLog = path.join(root, "active-invocation.json");
  async function command(name, bin, args, options = {}) {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const log = path.join(directory, "run.log");
    const budget = Math.min(options.limitMs ?? 10 * 60_000, remaining() - 120_000);
    if (budget <= 0) throw new Error("Managed proof envelope exhausted before " + name);
    console.log(
      "[native-proof] start " + name + " (remaining " + Math.floor(remaining() / 1000) + "s)",
    );
    const entry = {
      name,
      bin,
      args,
      startedAt: new Date().toISOString(),
      timeoutMs: budget,
      log: path.relative(root, log),
      sourceState: options.sourceState ?? null,
    };
    report.commands.push(entry);
    writeReport();
    fs.writeFileSync(activeLog, JSON.stringify(entry, null, 2) + "\n");
    const fd = fs.openSync(log, "wx", 0o600);
    const started = process.hrtime.bigint();
    let code;
    try {
      code = await runManagedCommand({
        bin,
        args,
        cwd: repo,
        env: { ...process.env, ...options.env, RUNNER_TEMP: directory, GITHUB_OUTPUT: undefined },
        stdio: ["ignore", fd, fd],
        requireProcessTreeExit: true,
        timeoutMs: budget,
        timeoutKillGraceMs: 90_000,
        signalKillGraceMs: 90_000,
        cleanupDrainTimeoutMs: 90_000,
      });
      entry.returnedAfterManagedDrain = true;
    } catch (error) {
      entry.error = String(error);
      // An interrupted outer owner cannot attest its nested native owner's cleanup.
      report.cleanupUncertain = true;
      throw error;
    } finally {
      fs.closeSync(fd);
      entry.seconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
      entry.exit = code ?? null;
      console.log(
        "[native-proof] finish " +
          name +
          " exit=" +
          entry.exit +
          " seconds=" +
          entry.seconds.toFixed(3),
      );
      writeReport();
    }
    return { code, directory, log, entry };
  }
  async function requiredCommand(name, bin, args, options) {
    const result = await command(name, bin, args, options);
    if (result.code !== 0) throw new Error(name + " failed with exit " + result.code);
    return result;
  }
  const gitOwner = process.env.CI_GIT_OWNER;
  if (!gitOwner || !path.isAbsolute(gitOwner)) throw new Error("Trusted Git owner is unavailable");
  const ownedGit = (name, args) =>
    requiredCommand(name, "python3", ["-I", "-S", gitOwner, "--git", "120", ...args], {
      limitMs: 150_000,
    });
  const cpu = Number(
    execFileSync("/usr/sbin/sysctl", ["-n", "hw.logicalcpu"], { encoding: "utf8" }).trim(),
  );
  if (!Number.isSafeInteger(cpu) || cpu < 1)
    throw new Error("Cannot establish native parallelization width");
  const width = Math.min(cpu, 12);
  report.swiftParallelizationWidth = width;
  const common = [
    "--package-path",
    "apps/macos",
    "--build-system",
    "native",
    "--enable-code-coverage",
    "--disable-index-store",
    "-Xswiftc",
    "-gline-tables-only",
  ];
  const nativeArgs = [
    "default",
    ...common,
    "--skip-build",
    "--experimental-maximum-parallelization-width",
    String(width),
  ];
  const binaryPath = path.join(
    repo,
    "apps/macos/.build/debug/OpenClawPackageTests.xctest/Contents/MacOS/OpenClawPackageTests",
  );
  async function build(name, spec) {
    verifySource(spec);
    const result = await requiredCommand(
      name,
      "swift",
      ["build", ...common, "--build-tests", "--jobs", String(width)],
      { limitMs: 20 * 60_000, sourceState: spec.sha },
    );
    verifySource(spec);
    const buildIdentity = {
      name,
      binarySha256: hash(binaryPath),
      source: spec,
      log: result.entry.log,
    };
    fs.writeFileSync(
      path.join(result.directory, "build-identity.json"),
      JSON.stringify(buildIdentity, null, 2) + "\n",
    );
    return buildIdentity;
  }
  function checkGreenLog(result, invocation) {
    const output = fs.readFileSync(result.log, "utf8");
    const summaries = [
      ...output.matchAll(
        /Test run with (\d+) tests? in (\d+) suites? (passed|failed) after ([\d.]+) seconds/g,
      ),
    ];
    const summary = summaries.at(-1);
    if (result.code !== 0 || !summary || summary[3] !== "passed" || Number(summary[1]) === 0) {
      throw new Error(
        invocation.name + " has no successful nonempty native result (exit " + result.code + ")",
      );
    }
    if (
      invocation.kind === "standalone" &&
      (invocation.expectedSuites.some((suite) => !output.includes("Suite " + suite + " passed")) ||
        Number(summary[2]) !== invocation.expectedSuites.length)
    ) {
      throw new Error("Standalone filter did not execute every suite in its selected file");
    }
    if (
      invocation.kind === "cohort" &&
      !output.includes("testConversationDisclosurePreservesOneComposerAndItsDraft]' passed")
    ) {
      throw new Error("Original cohort did not pass the required Quick Chat XCTest");
    }
    return {
      swiftTests: Number(summary[1]),
      swiftSuites: Number(summary[2]),
      swiftSeconds: Number(summary[4]),
    };
  }
  let originalHead = binding.candidateSha;
  let livePatches = [];
  const proofLauncher = path.join(repo, "scripts/test-macos-native-clock-proof.mts");
  try {
    fs.writeFileSync(path.join(root, "binding.json"), JSON.stringify(binding, null, 2) + "\n");
    await requiredCommand(
      "platform",
      "/bin/bash",
      [
        "-euo",
        "pipefail",
        "-c",
        "sw_vers\nxcodebuild -version\nxcrun swift --version\nnode --version",
      ],
      { limitMs: 60_000 },
    );
    const actualPlatform = {
      macos: execFileSync("/usr/bin/sw_vers", ["-productVersion"], {
        encoding: "utf8",
        timeout: 30_000,
      }).trim(),
      macosBuild: execFileSync("/usr/bin/sw_vers", ["-buildVersion"], {
        encoding: "utf8",
        timeout: 30_000,
      }).trim(),
      xcode: execFileSync("/usr/bin/xcodebuild", ["-version"], {
        encoding: "utf8",
        timeout: 30_000,
      }).trim(),
      swift: execFileSync("/usr/bin/xcrun", ["swift", "--version"], {
        encoding: "utf8",
        timeout: 30_000,
      }).trim(),
    };
    report.platform = actualPlatform;
    if (
      actualPlatform.macos !== binding.platform.macos ||
      actualPlatform.macosBuild !== binding.platform.macosBuild ||
      actualPlatform.xcode !==
        "Xcode " + binding.platform.xcode + "\nBuild version " + binding.platform.xcodeBuild ||
      !actualPlatform.swift.includes("Apple Swift version " + binding.platform.swift + " ")
    ) {
      throw new Error(
        "Hosted platform moved; record and rebind against current ordinary CI before interpreting proof",
      );
    }
    const normalBuild = await build("candidate-build", binding.states.candidate);
    for (const invocation of normalPlan) {
      verifySource(binding.states.candidate);
      const result = await command(
        invocation.name,
        process.execPath,
        ["scripts/test-macos-native.mts", ...nativeArgs, ...invocation.args],
        { sourceState: binding.candidateSha },
      );
      verifySource(binding.states.candidate);
      const counts = checkGreenLog(result, invocation);
      report.normal.push({
        ...invocation,
        ...counts,
        exit: result.code,
        log: result.entry.log,
        build: normalBuild.binarySha256,
      });
      writeReport();
    }
    if (
      hash(binaryPath) !== normalBuild.binarySha256 ||
      report.normal.length !== standaloneGroups.length * 20 + 3
    ) {
      throw new Error("Clean candidate build changed or repetition inventory is incomplete");
    }
    report.cleanProofComplete = true;
    writeReport();
    for (const control of binding.controls) {
      if (remaining() <= 120_000) throw new Error("No proof budget remains for " + control.name);
      await ownedGit(control.name + "-checkout", ["checkout", "--detach", control.sourceSha]);
      originalHead = control.sourceSha;
      verifySource(binding.states[control.sourceState]);
      for (const filename of control.patches) {
        const file = path.join(bundle, "controls", filename);
        await ownedGit(control.name + "-check-" + livePatches.length, ["apply", "--check", file]);
        await ownedGit(control.name + "-apply-" + livePatches.length, ["apply", file]);
        livePatches.push(file);
      }
      const state = binding.states[control.name];
      verifySource(state);
      const launcherBytes = fs.readFileSync(path.join(bundle, "control-native-launcher.mts"));
      fs.writeFileSync(proofLauncher, launcherBytes, { flag: "wx", mode: 0o600 });
      const controlBuild = await build(control.name + "-build", state);
      const result = await command(
        control.name,
        process.execPath,
        ["scripts/test-macos-native-clock-proof.mts", ...nativeArgs, "--filter", control.filter],
        {
          sourceState: state.sha,
          env: { OPENCLAW_NATIVE_PROOF_TIMEOUT_MS: String(control.innerTimeoutMs) },
          limitMs: Math.max(180_000, control.innerTimeoutMs + 120_000),
        },
      );
      verifySource(state);
      const events = fs
        .readdirSync(result.directory)
        .filter((name) => name.endsWith("-swift-events.jsonl"))
        .flatMap((name) =>
          fs
            .readFileSync(path.join(result.directory, name), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        )
        .filter((record) => record.kind === "event")
        .map((record) => record.payload);
      const starts = events.filter((event) => event.kind === "testStarted");
      const issues = events.filter((event) => event.kind === "issueRecorded");
      const caseStarts = events.filter(
        (event) =>
          event.kind === "testCaseStarted" && event.testID?.includes(control.testIdContains),
      );
      if (control.expectedCases && caseStarts.length !== control.expectedCases) {
        throw new Error("Control did not exercise its complete argument table: " + control.name);
      }
      const ends = events.filter((event) => event.kind === "runEnded");
      const issueText = issues
        .flatMap((issue) => issue.messages ?? [])
        .map((message) => message.text)
        .join("\n");
      const logText = fs.readFileSync(result.log, "utf8");
      if (
        result.code !== control.expectedExit ||
        !starts.some((event) => event.testID?.includes(control.testIdContains))
      ) {
        throw new Error("Control did not reach its expected test/outcome: " + control.name);
      }
      if (control.expectation === "green") {
        checkGreenLog(result, { name: control.name, kind: "control" });
        if (issues.length !== 0 || ends.length !== 1)
          throw new Error("Green control has invalid event completion");
      } else if (control.expectation === "bounded-timeout") {
        if (
          ends.length !== 0 ||
          issues.length !== 0 ||
          !logText.includes("[native-clock-proof]") ||
          !logText.includes("Managed command timed out after 30000ms")
        ) {
          throw new Error("Cancellation-join mutant did not produce its managed test timeout");
        }
      } else {
        if (
          issues.length === 0 ||
          ends.length !== 1 ||
          (control.expectedIssues && issues.length !== control.expectedIssues) ||
          issues.some((issue) => !issue.testID?.includes(control.testIdContains)) ||
          control.requiredIssuePatterns.some((pattern) => !new RegExp(pattern).test(issueText))
        ) {
          throw new Error("Negative control failed for a different reason: " + control.name);
        }
      }
      report.controls.push({
        name: control.name,
        expectation: control.expectation,
        exit: result.code,
        build: controlBuild.binarySha256,
        log: result.entry.log,
        issues: issueText,
      });
      writeReport();
      if (hash(proofLauncher) !== binding.payloadHashes["control-native-launcher.mts"]) {
        throw new Error("Task-owned diagnostic launcher changed unexpectedly");
      }
      fs.unlinkSync(proofLauncher);
      for (const file of livePatches.toReversed()) {
        await ownedGit(control.name + "-reverse-check-" + livePatches.indexOf(file), [
          "apply",
          "--reverse",
          "--check",
          file,
        ]);
        await ownedGit(control.name + "-reverse-" + livePatches.indexOf(file), [
          "apply",
          "--reverse",
          file,
        ]);
      }
      livePatches = [];
      verifySource(binding.states[control.sourceState]);
    }
    await ownedGit("restore-candidate-source", ["checkout", "--detach", binding.candidateSha]);
    verifySource(binding.states.candidate);
    if (report.controls.length !== binding.controls.length)
      throw new Error("Control inventory is incomplete");
    report.state = "passed";
    report.finalSourceHead = binding.candidateSha;
    report.finalBuildIsDiagnostic = true;
  } catch (error) {
    report.state = "failed";
    report.error = String(error);
    report.lastVerifiedSourceHead = originalHead;
    report.retainedPatches = livePatches.map((file) => path.basename(file));
    process.exitCode = 1;
    console.error("Native proof failed: " + String(error));
  } finally {
    report.finishedAt = new Date().toISOString();
    writeReport();
  }
}
