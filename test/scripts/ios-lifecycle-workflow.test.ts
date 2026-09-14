import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Command = { tool: string; args: string[] };

const workflow: { jobs: Record<string, { steps?: { name?: string; run?: string }[] }> } = parse(
  readFileSync(".github/workflows/ci.yml", "utf8"),
);
const watchStep = workflow.jobs["ios-build"]?.steps?.find(
  (step) => step.name === "Run focused Apple Watch operation simulator tests",
);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const iphoneId = "11111111-2222-3333-4444-555555555555";

function runIosStep(stepName: string, options: { missing?: string; failure?: string } = {}) {
  const root = tempDirs.make("openclaw-ios-workflow-");
  const bin = path.join(root, "bin");
  const scripts = path.join(root, "scripts");
  mkdirSync(bin);
  mkdirSync(scripts);
  const runner = path.join(root, "tools.mjs");
  writeFileSync(
    runner,
    String.raw`
import { appendFileSync, copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const [tool, ...args] = process.argv.slice(2);
const root = process.env.IOS_FIXTURE_ROOT;
const failure = process.env.IOS_FIXTURE_FAILURE;
appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({
  tool, args, optIn: process.env.OPENCLAW_CI_SIMSLIM_BINARY || ""
}) + "\n");
if (tool === "installer") {
  if (failure === "install") process.exit(23);
  mkdirSync(args[0], { recursive: true });
  copyFileSync(path.join(root, "bin", "simslim"), path.join(args[0], "simslim"));
} else if (tool === "xcrun" && args[1] === "list") {
  console.log(JSON.stringify({ devices: { ios: [
    { name: "Apple Watch fixture", isAvailable: true, udid: "watch-fixture" },
    { name: "iPhone fixture", isAvailable: true, udid: process.env.IOS_FIXTURE_UDID }
  ] } }));
} else if ((tool === "simslim" && args[0] === failure) ||
           (tool === "xcrun" && args[1] === "bootstatus" && failure === "readiness")) {
  process.exit(23);
}
`,
  );
  for (const tool of ["xcrun", "xcodebuild", "simslim", "installer"]) {
    const executable = path.join(bin, tool);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${runner}' '${tool}' "$@"\n`);
    chmodSync(executable, 0o755);
  }
  if (options.missing !== "installer") {
    copyFileSync(path.join(bin, "installer"), path.join(scripts, "install-simslim.sh"));
  }
  if (options.missing !== "prepare") {
    copyFileSync(
      "scripts/ios-simulator-prepare.sh",
      path.join(scripts, "ios-simulator-prepare.sh"),
    );
  }
  const step = Object.values(workflow.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((entry) => entry.name === stepName);
  if (!step?.run) {
    throw new Error(`Missing iOS workflow step ${stepName}`);
  }
  const output = path.join(root, "output");
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", step.run], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      CI: "true",
      RUNNER_TEMP: root,
      GITHUB_OUTPUT: output,
      OPENCLAW_CI_SIMSLIM_BINARY: "",
      IOS_FIXTURE_ROOT: root,
      IOS_FIXTURE_UDID: iphoneId,
      IOS_FIXTURE_FAILURE: options.failure ?? "",
    },
  });
  const trace = path.join(root, "commands.jsonl");
  const commands: (Command & { optIn: string })[] = existsSync(trace)
    ? readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return {
    result,
    commands,
    binary: path.join(root, "openclaw-simslim", "simslim"),
    output: existsSync(output) ? readFileSync(output, "utf8") : "",
  };
}

describe.skipIf(process.platform === "win32")("iOS simulator workflow", () => {
  const lifecycleStep = "Run focused iOS lifecycle simulator tests";
  const installerStep = "Install iOS simulator tooling";

  it("prepares the selected iPhone before both lifecycle test commands", () => {
    const { result, commands } = runIosStep(lifecycleStep);
    expect(result.status, result.stderr).toBe(0);
    expect(commands.map(({ tool }) => tool)).toEqual([
      "xcrun",
      "installer",
      "simslim",
      "xcrun",
      "simslim",
      "xcodebuild",
      "xcodebuild",
    ]);
    expect(commands.filter(({ tool }) => tool === "simslim").map(({ args }) => args[1])).toEqual([
      iphoneId,
      iphoneId,
    ]);
    const tests = commands.filter(({ tool }) => tool === "xcodebuild");
    expect(tests.map(({ args }) => args[args.indexOf("-scheme") + 1])).toEqual([
      "OpenClaw",
      "OpenClawUITests",
    ]);
    for (const { args, optIn } of tests) {
      expect(args).toContain(`platform=iOS Simulator,id=${iphoneId}`);
      expect(optIn).toBe("");
    }
  });

  it.each(["installer", "prepare"])("keeps targets missing %s stock", (missing) => {
    const lifecycle = runIosStep(lifecycleStep, { missing });
    expect(lifecycle.result.status, lifecycle.result.stderr).toBe(0);
    expect(lifecycle.commands.map(({ tool }) => tool)).toEqual([
      "xcrun",
      "xcodebuild",
      "xcodebuild",
    ]);
    const install = runIosStep(installerStep, { missing });
    expect(install.result.status, install.result.stderr).toBe(0);
    expect(install.commands).toEqual([]);
    expect(install.output).toBe("");
  });

  it.each(["install", "on", "readiness", "verify"])(
    "does not test after enabled %s failure",
    (failure) => {
      const { result, commands } = runIosStep(lifecycleStep, { failure });
      expect(result.status).toBe(23);
      expect(commands.some(({ tool }) => tool === "xcodebuild")).toBe(false);
    },
  );

  it("exposes a private binary output only after successful screenshot installation", () => {
    const installed = runIosStep(installerStep);
    expect(installed.result.status, installed.result.stderr).toBe(0);
    expect(installed.output).toBe(`binary=${installed.binary}\n`);
    const failed = runIosStep(installerStep, { failure: "install" });
    expect(failed.result.status).toBe(23);
    expect(failed.output).toBe("");
  });
});

function runWatchStep(mode = "ready") {
  const root = tempDirs.make("openclaw-watch-workflow-");
  const bin = path.join(root, "bin");
  const product = path.join(root, "project derived data", "Watch Product.app");
  mkdirSync(bin, { recursive: true });
  mkdirSync(product, { recursive: true });
  const runner = path.join(root, "tools.mjs");
  writeFileSync(
    runner,
    String.raw`
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
const [tool, ...args] = process.argv.slice(2);
const root = process.env.WATCH_FIXTURE_ROOT;
const mode = process.env.WATCH_FIXTURE_MODE;
appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({ tool, args }) + "\n");
if (tool === "xcrun") {
  if (args[1] === "list") {
    console.log(JSON.stringify({ devices: { watch: [
      { name: "Apple Watch fixture", isAvailable: true, udid: "watch-fixture" }
    ] } }));
  } else if (args[1] === "bootstatus" && mode === "boot-failed") {
    process.exit(23);
  } else if (args[1] === "install" && !existsSync(args[3])) {
    process.exit(24);
  }
} else if (args.includes("-showBuildSettings")) {
  const product = {
    target: "OpenClawWatchApp",
    buildSettings: {
      TARGET_BUILD_DIR: mode === "relative-product" ? "relative" : path.join(root, "project derived data"),
      FULL_PRODUCT_NAME: "Watch Product.app"
    }
  };
  const other = { target: "OtherTarget", buildSettings: { TARGET_BUILD_DIR: "/wrong", FULL_PRODUCT_NAME: "Wrong.app" } };
  console.log(JSON.stringify(mode === "missing-product" ? [other] :
    mode === "ambiguous-product" ? [product, product] : [other, product]));
} else if (args.includes("build-for-testing")) {
  const derivedIndex = args.indexOf("-derivedDataPath");
  if (derivedIndex >= 0) {
    mkdirSync(path.join(args[derivedIndex + 1], "Build/Products/Debug-watchsimulator/OpenClawWatchApp.app"), { recursive: true });
  }
}
`,
  );
  for (const tool of ["xcrun", "xcodebuild"]) {
    const executable = path.join(bin, tool);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${runner}' '${tool}' "$@"\n`);
    chmodSync(executable, 0o755);
  }
  if (!watchStep?.run) {
    throw new Error("Missing Watch simulator workflow step");
  }
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", watchStep.run], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      RUNNER_TEMP: root,
      WATCH_FIXTURE_ROOT: root,
      WATCH_FIXTURE_MODE: mode,
      OPENCLAW_CI_SIMSLIM_BINARY: path.join(root, "must-not-use-simslim"),
    },
  });
  const commands: Command[] = readFileSync(path.join(root, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return { result, commands, product };
}

describe.skipIf(process.platform === "win32")("Watch simulator workflow", () => {
  it("reuses project build products and installs the exact Watch target before running its tests", () => {
    const { result, commands, product } = runWatchStep();
    expect(result.status, result.stderr).toBe(0);
    const xcodeCommands = commands.filter((command) => command.tool === "xcodebuild");
    for (const command of xcodeCommands) {
      expect(command.args).not.toContain("-derivedDataPath");
    }
    expect(
      commands.filter((command) => command.tool === "xcrun").map((command) => command.args),
    ).toEqual([
      ["simctl", "list", "devices", "available", "--json"],
      ["simctl", "boot", "watch-fixture"],
      ["simctl", "bootstatus", "watch-fixture", "-b"],
      ["simctl", "install", "watch-fixture", product],
    ]);
    expect(
      xcodeCommands.map((command) =>
        command.args.find((arg) =>
          ["build-for-testing", "-showBuildSettings", "test-without-building"].includes(arg),
        ),
      ),
    ).toEqual(["build-for-testing", "-showBuildSettings", "test-without-building"]);
    for (const command of xcodeCommands.filter(
      (entry) =>
        entry.args.includes("build-for-testing") || entry.args.includes("test-without-building"),
    )) {
      expect(command.args).toEqual(
        expect.arrayContaining([
          "OpenClawWatchApp",
          "Debug",
          "platform=watchOS Simulator,id=watch-fixture",
          "-parallel-testing-enabled",
          "NO",
          "-only-testing:OpenClawWatchTests/WatchInboxStoreOperationTests",
          "-only-testing:OpenClawWatchTests/WatchRealtimeMediaTests",
          "-only-testing:OpenClawWatchTests/WatchGatewayConfigurationTests",
          "CODE_SIGNING_ALLOWED=NO",
        ]),
      );
    }
    expect(
      xcodeCommands.find((command) => command.args.includes("test-without-building"))?.args,
    ).toContain("apps/ios/build/LifecycleTestResults/OpenClawWatchOperationTests.xcresult");
  });

  it.each(["missing-product", "ambiguous-product", "relative-product"])(
    "rejects %s settings before simulator installation or test execution",
    (mode) => {
      const { result, commands } = runWatchStep(mode);
      expect(result.status).not.toBe(0);
      expect(commands.some((command) => command.args.includes("install"))).toBe(false);
      expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(
        false,
      );
    },
  );

  it("preserves simulator readiness failure without installing or running tests", () => {
    const { result, commands } = runWatchStep("boot-failed");
    expect(result.status).toBe(23);
    expect(commands.some((command) => command.args.includes("install"))).toBe(false);
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(false);
  });
});
