import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { parse } from "yaml";
import {
  createVoiceFixture,
  runWatchPhase,
} from "../../scripts/ios-watch-operator-https-proof.mts";
import * as watchProof from "../../scripts/ios-watch-operator-https-proof.mts";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { waitForDead, waitForFile, waitForPidFile } from "../helpers/process-wait.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../helpers/tls-fixture.js";

type Command = { tool: string; args: string[] };

const workflow: { jobs: Record<string, { steps: { name?: string; run?: string }[] }> } = parse(
  readFileSync(".github/workflows/ci.yml", "utf8"),
);
const watchStep = workflow.jobs["ios-build"]?.steps.find(
  (step) => step.name === "Run focused Apple Watch operation simulator tests",
);
const qualification = parse(readFileSync(".github/workflows/ios-periphery.yml", "utf8"));
const qualificationSteps: {
  id?: string;
  name: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
}[] = qualification.jobs.scan.steps;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runXcodeSelection(qualificationMode: boolean, present = true, version = "26.6") {
  const root = tempDirs.make("watch-xcode-selection-");
  const envFile = path.join(root, "github-env");
  const commandsFile = path.join(root, "commands");
  const step = qualificationSteps.find((entry) => entry.name === "Verify Xcode");
  assert(step?.run);
  // Execute the actual workflow shell; only filesystem and native commands are fixtures.
  const prelude = String.raw`
function test {
  if [[ "$1" == "-d" ]]; then
    [[ "$2" == "/Applications/Xcode_26.6.app/Contents/Developer" && "$XCODE_PRESENT" == "true" ]]
  else builtin test "$@"; fi
}
function [ {
  if [[ "$1" == "-d" ]]; then test -d "$2"; else builtin [ "$@"; fi
}
function sudo { printf 'sudo:%s\n' "$*" >> "$XCODE_COMMANDS"; }
function xcodebuild {
  local selected="$DEVELOPER_DIR"
  if [[ -z "$selected" ]]; then selected=unset; fi
  printf 'xcodebuild:%s\n' "$selected" >> "$XCODE_COMMANDS"
  printf 'Xcode %s\nBuild version fixture\n' "$XCODE_VERSION"
}
function swift {
  local selected="$DEVELOPER_DIR"
  if [[ -z "$selected" ]]; then selected=unset; fi
  printf 'swift:%s\n' "$selected" >> "$XCODE_COMMANDS"
}
`;
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", prelude + step.run], {
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      DEVELOPER_DIR: "",
      WATCH_QUALIFICATION: String(qualificationMode),
      XCODE_PRESENT: String(present),
      XCODE_VERSION: version,
      XCODE_COMMANDS: commandsFile,
      GITHUB_ENV: envFile,
    },
  });
  return {
    result,
    commands: existsSync(commandsFile) ? readFileSync(commandsFile, "utf8").trim().split("\n") : [],
    environment: existsSync(envFile) ? readFileSync(envFile, "utf8") : "",
  };
}

function runWatchStep(mode = "ready", qualificationMode = false, phases?: string[]) {
  const root = tempDirs.make("openclaw-watch-workflow-");
  const bin = path.join(root, "bin");
  const temporaryRoot = path.join(root, "temporary");
  const product = path.join(root, "project derived data", "Watch Product.app");
  const testProduct = path.join(product, "PlugIns", "Watch Tests.xctest");
  mkdirSync(bin, { recursive: true });
  mkdirSync(temporaryRoot);
  mkdirSync(testProduct, { recursive: true });
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(
    path.join(root, "scripts/ios-watch-operation-tests.sh"),
    readFileSync("scripts/ios-watch-operation-tests.sh"),
  );
  const runner = path.join(root, "tools.mjs");
  writeFileSync(
    runner,
    String.raw`
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const [tool, ...args] = process.argv.slice(2);
const root = process.env.WATCH_FIXTURE_ROOT;
const mode = process.env.WATCH_FIXTURE_MODE;
if ((tool === "xcodebuild" && args.includes("-showBuildSettings") && mode === "settings-command-failed") ||
    (tool === "xcodebuild" && !args.includes("-showBuildSettings") && mode === "build-command-failed") ||
    (tool === "xcrun" && args[1] === "install" && mode === "install-command-failed")) {
  console.error("error: fixture command failed");
  process.exit(27);
}
const productPath = path.join(root, "project derived data", "Watch Product.app");
const targetTempDir = path.join(root, "project intermediates", "Watch Product.build");
const generatedPath = path.join(targetTempDir, "Watch Product.app-Simulated.xcent");
const applicationID = (mode === "mixed-case-prefix" ? "SeedFix123" : "SEEDFIX123") + ".org.example.watch";
appendFileSync(path.join(root, "commands.jsonl"), JSON.stringify({ tool, args }) + "\n");
if (tool === "xcrun") {
  if (args[0] === "segedit") {
    const output = args[5];
    if (output === "-" || !path.isAbsolute(output) ||
        (statSync(path.dirname(output)).mode & 0o777) !== 0o700) {
      throw new Error("Expected a private extraction directory and real output file");
    }
    if (mode === "missing-section") process.exit(26);
    const entitlements = mode === "missing-application-id" ? {} : {
      "application-identifier": mode === "wrong-application-id" ?
        "SEEDFIX123.org.example.other" : mode === "wrong-compiled-seed" ?
        "TEAMFIX123.org.example.watch" : mode === "compiled-seed-case-mismatch" ?
        "seedfix123.org.example.watch" : applicationID
    };
    if (mode === "explicit-private-group") {
      entitlements["keychain-access-groups"] = ["SEEDFIX123.org.example.watch"];
    } else if (mode === "malformed-keychain-groups") {
      entitlements["keychain-access-groups"] = "not-an-array";
    }
    writeFileSync(output, mode === "malformed-section" ? "not a plist" : JSON.stringify(entitlements));
  } else if (args[1] === "list") {
    console.log(JSON.stringify({ devices: { watch: [
      { name: "Apple Watch fixture", isAvailable: true, udid: "watch-fixture" }
    ] } }));
  } else if (args[1] === "bootstatus" && mode === "boot-failed") {
    process.exit(23);
  } else if (args[1] === "install" && !existsSync(args[3])) {
    process.exit(24);
  }
} else if (args.includes("-showBuildSettings")) {
  const signing = {
    DEVELOPMENT_TEAM: mode === "missing-app-team" ? "" : "TEAMFIX123",
    CODE_SIGN_STYLE: "Manual",
    CODE_SIGN_ENTITLEMENTS: "Fixture/Watch.entitlements",
    CODE_SIGNING_ALLOWED: "NO",
    CODE_SIGN_IDENTITY: "Apple Development",
    CODE_SIGN_INJECT_BASE_ENTITLEMENTS: "NO",
    ...Object.fromEntries(args.filter((arg) => arg.startsWith("CODE_SIGN")).map((arg) => arg.split("=")))
  };
  const product = {
    target: "OpenClawWatchApp",
    buildSettings: {
      ...signing,
      TARGET_BUILD_DIR: mode === "relative-product" ? "relative" : path.join(root, "project derived data"),
      TARGET_TEMP_DIR: targetTempDir,
      FULL_PRODUCT_NAME: "Watch Product.app",
      EXECUTABLE_NAME: "OpenClawWatchApp",
      PRODUCT_BUNDLE_IDENTIFIER: mode === "missing-bundle-id" ? "" : "org.example.watch"
    }
  };
  const tests = {
    target: "OpenClawWatchTests",
    buildSettings: {
      ...signing,
      DEVELOPMENT_TEAM: mode === "team-mismatch" ? "OTHERTEAM1" :
        mode === "missing-test-team" ? "" : signing.DEVELOPMENT_TEAM,
      CODE_SIGN_ENTITLEMENTS: "Fixture/WatchTests.entitlements",
      TARGET_BUILD_DIR: path.join(root, "project derived data", "Watch Product.app", "PlugIns"),
      FULL_PRODUCT_NAME: "Watch Tests.xctest",
      PRODUCT_BUNDLE_IDENTIFIER: "org.example.watch.tests",
      TEST_HOST: path.join(root, "project derived data", "Watch Product.app",
        mode === "wrong-test-host" ? "OtherHost" : "OpenClawWatchApp")
    }
  };
  const other = { target: "OtherTarget", buildSettings: { TARGET_BUILD_DIR: "/wrong", FULL_PRODUCT_NAME: "Wrong.app" } };
  console.log(JSON.stringify(!args.includes("build-for-testing") ? [other, product] :
    mode === "missing-product" ? [other, tests] :
    mode === "ambiguous-product" ? [product, product, tests] :
    mode === "duplicate-test-target" ? [other, product, tests, tests] :
    mode === "missing-test-product" ? [other, product] : [other, product, tests]));
} else if (tool === "codesign") {
  if (args.includes("--verify")) {
    if ((mode === "invalid-signature" && args.at(-1).endsWith(".app")) ||
        (mode === "invalid-test-signature" && args.at(-1).endsWith(".xctest"))) {
      process.exit(25);
    }
  } else {
    console.log(JSON.stringify({ "get-task-allow": true }));
  }
} else if (tool === "plutil") {
  const input = args.at(-1);
  const plist = JSON.parse(readFileSync(input === "-" ? 0 : input, "utf8"));
  if (mode === "cleanup-failed" && path.basename(input) === "entitlements.plist" &&
      path.dirname(path.dirname(input)) === process.env.TMPDIR) {
    chmodSync(process.env.TMPDIR, 0o500);
  }
  console.log(JSON.stringify(plist));
} else if (args.includes("build-for-testing")) {
  mkdirSync(targetTempDir, { recursive: true });
  if (mode !== "missing-generated") {
    const generated = mode === "missing-generated-id" ? {} : {
      "application-identifier": mode === "unresolved-generated-id" ?
        "$(AppIdentifierPrefix)org.example.watch" : mode === "invalid-generated-prefix" ?
        "BAD_PREFIX.org.example.watch" : mode === "wrong-generated-bundle" ?
        "SEEDFIX123.org.example.other" : applicationID
    };
    writeFileSync(generatedPath, mode === "malformed-generated" ? "not a plist" : JSON.stringify(generated));
  }
  writeFileSync(path.join(productPath, "Info.plist"), JSON.stringify({
    CFBundleIdentifier: mode === "built-bundle-mismatch" ? "org.example.other" : "org.example.watch"
  }));
  const derivedIndex = args.indexOf("-derivedDataPath");
  if (derivedIndex >= 0) {
    mkdirSync(path.join(args[derivedIndex + 1], "Build/Products/Debug-watchsimulator/OpenClawWatchApp.app"), { recursive: true });
  }
}
`,
  );
  for (const tool of ["xcrun", "xcodebuild", "codesign", "plutil"]) {
    const executable = path.join(bin, tool);
    writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' '${runner}' '${tool}' "$@"\n`);
    chmodSync(executable, 0o755);
  }
  const step = qualificationMode
    ? qualificationSteps.find(
        (entry) => entry.name === "Run focused Apple Watch operation simulator tests",
      )
    : watchStep;
  if (!step?.run) {
    throw new Error("Missing Watch simulator workflow step");
  }
  let result;
  try {
    const options = {
      cwd: root,
      encoding: "utf8" as const,
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
        TMPDIR: temporaryRoot,
        TMP: temporaryRoot,
        TEMP: temporaryRoot,
        WATCH_FIXTURE_ROOT: root,
        WATCH_FIXTURE_MODE: mode,
      },
    };
    if (phases) {
      const state = path.join(root, "owned-build");
      mkdirSync(state, { mode: 0o700 });
      for (const phase of phases) {
        if (mode === "wrong-owned-device" && phase !== "build") {
          const file = path.join(state, "build.json");
          writeFileSync(
            file,
            JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), simulator: randomUUID() }),
          );
        }
        result = spawnSync(
          "/bin/bash",
          [
            "scripts/ios-watch-operation-tests.sh",
            path.join(root, `${phase}.xcresult`),
            "11111111-1111-4111-8111-111111111111",
            phase,
            state,
          ],
          options,
        );
        if (result.status !== 0) {
          break;
        }
      }
    } else {
      result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", step.run], options);
    }
  } finally {
    chmodSync(temporaryRoot, 0o700);
  }
  assert(result);
  const commands: Command[] = existsSync(path.join(root, "commands.jsonl"))
    ? readFileSync(path.join(root, "commands.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { result, commands, product, testProduct, root, temporaryRoot };
}

describe.skipIf(process.platform === "win32")("Watch simulator workflow", () => {
  it("exports the fixed qualification Xcode without changing global selection", () => {
    const { result, commands, environment } = runXcodeSelection(true);
    expect(result.status, result.stderr).toBe(0);
    expect(commands).toEqual([
      "xcodebuild:/Applications/Xcode_26.6.app/Contents/Developer",
      "xcodebuild:/Applications/Xcode_26.6.app/Contents/Developer",
      "swift:/Applications/Xcode_26.6.app/Contents/Developer",
    ]);
    expect(environment).toBe("DEVELOPER_DIR=/Applications/Xcode_26.6.app/Contents/Developer\n");
  });

  it.each([
    ["absent", false, "26.6"],
    ["wrong-version", true, "26.5"],
  ] as const)(
    "fails qualification for %s Xcode without global selection or fallback",
    (_, present, version) => {
      const { result, commands } = runXcodeSelection(true, present, version);
      expect(result.status).not.toBe(0);
      expect(commands.some((command) => command.startsWith("sudo:"))).toBe(false);
      expect(commands.some((command) => command.startsWith("swift:"))).toBe(false);
    },
  );

  it("preserves ordinary Periphery Xcode selection", () => {
    const { result, commands, environment } = runXcodeSelection(false);
    expect(result.status, result.stderr).toBe(0);
    expect(commands).toEqual([
      "sudo:xcode-select -s /Applications/Xcode_26.6.app/Contents/Developer",
      "xcodebuild:unset",
      "xcodebuild:unset",
      "swift:unset",
    ]);
    expect(environment).toBe("");
  });

  it.each(["success", "failure", "cancelled", "skipped"])(
    "runs subsequent captures only after successful HTTPS/voice qualification: %s",
    (outcome) => {
      const live = qualificationSteps.find((step) => step.id === "watch_https");
      const captures = qualificationSteps.find(
        (step) => step.name === "Capture direct Watch review surfaces",
      );
      const condition = captures?.if;
      assert(live && condition);
      assert(condition.startsWith("${{") && condition.endsWith("}}"));
      // This workflow condition uses the JS-compatible &&/==/! expression subset.
      const admitted = runInNewContext(condition.slice(3, -2), {
        github: { event_name: "workflow_dispatch" },
        inputs: { watch_qualification: true },
        steps: { watch_tests: { outcome: "success" }, watch_https: { outcome } },
        cancelled: () => false,
      });
      expect(admitted).toBe(outcome === "success");
    },
  );

  it("reuses project build products and installs the exact Watch target before running its tests", () => {
    const { result, commands, product, testProduct, root, temporaryRoot } = runWatchStep();
    expect(result.status, result.stderr).toBe(0);
    const xcodeCommands = commands.filter((command) => command.tool === "xcodebuild");
    for (const command of xcodeCommands) {
      expect(command.args).not.toContain("-derivedDataPath");
      expect(command.args).not.toContain("-target");
      expect(command.args).not.toContain("-alltargets");
    }
    expect(
      commands
        .filter((command) => command.tool === "xcrun" && command.args[0] === "simctl")
        .map((command) => command.args),
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
    const build = xcodeCommands.find((command) => !command.args.includes("-showBuildSettings"));
    const settingsQuery = xcodeCommands.find((command) =>
      command.args.includes("-showBuildSettings"),
    );
    expect(
      settingsQuery?.args.filter((arg) => arg !== "-showBuildSettings" && arg !== "-json"),
    ).toEqual(build?.args);
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
          "-only-testing:OpenClawWatchTests/WatchDirectConversationTests",
          "-only-testing:OpenClawWatchTests/WatchGatewayControllerTests",
          "CODE_SIGNING_ALLOWED=YES",
          "CODE_SIGN_IDENTITY=-",
          "CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES",
        ]),
      );
      expect(
        command.args.some((arg) =>
          /^(DEVELOPMENT_TEAM|CODE_SIGN_STYLE|CODE_SIGN_ENTITLEMENTS|PROVISIONING_PROFILE_SPECIFIER)=/.test(
            arg,
          ),
        ),
      ).toBe(false);
    }
    const installIndex = commands.findIndex((command) => command.args.includes("install"));
    expect(
      commands.slice(0, installIndex).filter((command) => command.tool === "codesign"),
    ).toEqual([
      { tool: "codesign", args: ["--verify", "--strict", product] },
      { tool: "codesign", args: ["--verify", "--strict", testProduct] },
    ]);
    const extraction = commands.find(
      (command) => command.tool === "xcrun" && command.args[0] === "segedit",
    );
    expect(extraction?.args.slice(0, 5)).toEqual([
      "segedit",
      path.join(product, "OpenClawWatchApp"),
      "-extract",
      "__TEXT",
      "__entitlements",
    ]);
    const plistPath = extraction?.args[5];
    assert(plistPath, "Expected an extracted entitlement plist");
    expect(plistPath).not.toBe("-");
    expect(path.dirname(path.dirname(plistPath))).toBe(temporaryRoot);
    expect(commands.slice(0, installIndex).filter((command) => command.tool === "plutil")).toEqual([
      { tool: "plutil", args: ["-convert", "json", "-o", "-", path.join(product, "Info.plist")] },
      {
        tool: "plutil",
        args: [
          "-convert",
          "json",
          "-o",
          "-",
          path.join(
            root,
            "project intermediates",
            "Watch Product.build",
            "Watch Product.app-Simulated.xcent",
          ),
        ],
      },
      { tool: "plutil", args: ["-convert", "json", "-o", "-", plistPath] },
    ]);
    expect(readdirSync(temporaryRoot)).toEqual([]);
    expect(result.stderr.split("\n")[0]).toBe(
      '{"watchBuildSettings":{"OpenClawWatchApp":1,"OpenClawWatchTests":1}}',
    );
    expect(result.stderr).toContain('"team":"TEAMFIX123"');
    expect(result.stderr).toContain('"applicationID":"SEEDFIX123.org.example.watch"');
    expect(result.stderr).toContain('"style":"Manual"');
    expect(result.stderr).toContain('"entitlementsFile":"Fixture/Watch.entitlements"');
    expect(result.stderr).toContain('"entitlementsSource":"__TEXT,__entitlements"');
    expect(result.stderr).toContain('"keychainAccessGroups":null');
    expect(
      xcodeCommands.find((command) => command.args.includes("test-without-building"))?.args,
    ).toContain("apps/ios/build/LifecycleTestResults/OpenClawWatchOperationTests.xcresult");
  });

  it.each([
    "missing-product",
    "ambiguous-product",
    "relative-product",
    "missing-test-product",
    "duplicate-test-target",
    "wrong-test-host",
    "invalid-signature",
    "invalid-test-signature",
    "missing-section",
    "malformed-section",
    "missing-application-id",
    "wrong-application-id",
    "wrong-compiled-seed",
    "compiled-seed-case-mismatch",
    "missing-generated",
    "malformed-generated",
    "missing-generated-id",
    "unresolved-generated-id",
    "invalid-generated-prefix",
    "wrong-generated-bundle",
    "missing-app-team",
    "missing-test-team",
    "team-mismatch",
    "missing-bundle-id",
    "built-bundle-mismatch",
    "malformed-keychain-groups",
  ])("rejects %s settings before simulator installation or test execution", (mode) => {
    const { result, commands, temporaryRoot } = runWatchStep(mode);
    expect(result.status).not.toBe(0);
    const appCount = mode === "missing-product" ? 0 : mode === "ambiguous-product" ? 2 : 1;
    const testCount =
      mode === "missing-test-product" ? 0 : mode === "duplicate-test-target" ? 2 : 1;
    expect(result.stderr.split("\n")[0]).toBe(
      JSON.stringify({
        watchBuildSettings: { OpenClawWatchApp: appCount, OpenClawWatchTests: testCount },
      }),
    );
    if (appCount !== 1) {
      expect(result.stderr).toContain(
        `Expected one OpenClawWatchApp target from Xcode, got ${appCount}`,
      );
    } else if (testCount !== 1) {
      expect(result.stderr).toContain(
        `Expected one OpenClawWatchTests target from Xcode, got ${testCount}`,
      );
    }
    if (mode === "missing-app-team") {
      expect(result.stderr).toContain("Missing configured Watch app development team");
    } else if (mode === "team-mismatch" || mode === "missing-test-team") {
      expect(result.stderr).toContain("Configured Watch test team does not match the app team");
    } else if (mode === "missing-bundle-id") {
      expect(result.stderr).toContain("Missing configured Watch app bundle identifier");
    } else if (mode === "built-bundle-mismatch") {
      expect(result.stderr).toContain(
        "Built Watch bundle identifier does not match its configuration",
      );
    } else if (
      [
        "missing-generated-id",
        "unresolved-generated-id",
        "invalid-generated-prefix",
        "wrong-generated-bundle",
      ].includes(mode)
    ) {
      expect(result.stderr).toContain(
        "Expected a fully evaluated generated Watch application identifier for the configured bundle",
      );
    } else if (mode === "wrong-compiled-seed" || mode === "compiled-seed-case-mismatch") {
      expect(result.stderr).toContain(
        "Simulated Watch host application identifier does not match its build identity",
      );
    }
    if (mode === "missing-generated" || mode === "malformed-generated") {
      expect(
        commands.some(
          (command) =>
            command.tool === "plutil" && command.args.at(-1)?.endsWith("-Simulated.xcent"),
        ),
      ).toBe(true);
      expect(commands.some((command) => command.args[0] === "segedit")).toBe(false);
    }
    expect(result.stderr).not.toContain("OtherTarget");
    expect(result.stderr).not.toContain("/wrong");
    expect(commands.some((command) => command.args.includes("install"))).toBe(false);
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(false);
    expect(readdirSync(temporaryRoot)).toEqual([]);
  });

  it("stops before installation and test execution when extraction cleanup fails", () => {
    const { result, commands, temporaryRoot } = runWatchStep("cleanup-failed");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/EACCES|EPERM/);
    expect(commands.some((command) => command.tool === "plutil")).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.tool === "plutil" && command.args.at(-1)?.endsWith("/entitlements.plist"),
      ),
    ).toBe(true);
    expect(commands.some((command) => command.args.includes("install"))).toBe(false);
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(false);
    expect(readdirSync(temporaryRoot)).toHaveLength(1);
  });

  it("accepts an explicitly provided private Keychain group without changing signing configuration", () => {
    const { result, commands } = runWatchStep("explicit-private-group");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('"keychainAccessGroups":["SEEDFIX123.org.example.watch"]');
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(true);
  });

  it("preserves a mixed-case generated App ID prefix independently of the configured team", () => {
    const { result, commands } = runWatchStep("mixed-case-prefix");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('"team":"TEAMFIX123"');
    expect(result.stderr).toContain('"applicationID":"SeedFix123.org.example.watch"');
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(true);
  });

  it("preserves simulator readiness failure without installing or running tests", () => {
    const { result, commands } = runWatchStep("boot-failed");
    expect(result.status).toBe(23);
    expect(commands.some((command) => command.args.includes("install"))).toBe(false);
    expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(false);
  });

  it("runs the same Watch suites in qualification mode and retains an independent result bundle", () => {
    const normal = runWatchStep();
    const focused = runWatchStep("ready", true);
    expect(focused.result.status, focused.result.stderr).toBe(0);
    const testSelection = (commands: Command[]) =>
      commands
        .find((command) => command.args.includes("test-without-building"))
        ?.args.filter((arg) => arg.startsWith("-only-testing:"));
    expect(testSelection(focused.commands)).toEqual(testSelection(normal.commands));
    expect(
      focused.commands.find((command) => command.args.includes("test-without-building"))?.args,
    ).toContain(path.join(focused.root, "watch-qualification/WatchOperationTests.xcresult"));
  });

  it("builds an owned qualification host once, then uses only that simulator without fixture phases in normal suites", () => {
    const { result, commands, product, root } = runWatchStep("ready", false, [
      "build",
      "identity",
      "negative",
      "positive",
      "voice",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const xcode = commands.filter((command) => command.tool === "xcodebuild");
    expect(
      xcode.filter(
        (command) =>
          command.args.includes("build-for-testing") &&
          !command.args.includes("-showBuildSettings"),
      ),
    ).toHaveLength(1);
    expect(xcode.filter((command) => command.args.includes("test-without-building"))).toHaveLength(
      4,
    );
    for (const command of xcode) {
      expect(command.args).not.toContain("-derivedDataPath");
      for (const [option, value] of [
        ["-project", "apps/ios/OpenClaw.xcodeproj"],
        ["-scheme", "OpenClawWatchApp"],
        ["-configuration", "Debug"],
      ] as const) {
        expect(command.args[command.args.indexOf(option) + 1]).toBe(value);
      }
      expect(command.args.filter((arg) => arg.startsWith("CODE_SIGN"))).toEqual([
        "CODE_SIGNING_ALLOWED=YES",
        "CODE_SIGN_IDENTITY=-",
        "CODE_SIGN_INJECT_BASE_ENTITLEMENTS=YES",
      ]);
      expect(command.args).toContain(
        "platform=watchOS Simulator,id=11111111-1111-4111-8111-111111111111",
      );
      expect(command.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual([
        "-only-testing:OpenClawWatchTests/WatchOperatorHTTPSQualificationTests",
      ]);
    }
    const build = xcode.find((command) => !command.args.includes("-showBuildSettings"));
    const settingsQuery = xcode.find((command) => command.args.includes("-showBuildSettings"));
    expect(
      settingsQuery?.args.filter((arg) => arg !== "-showBuildSettings" && arg !== "-json"),
    ).toEqual(build?.args);
    expect(JSON.parse(readFileSync(path.join(root, "owned-build", "build.json"), "utf8"))).toEqual({
      simulator: "11111111-1111-4111-8111-111111111111",
      appPath: product,
      bundleID: "org.example.watch",
    });
    expect(
      commands.filter((command) => command.args[0] === "simctl").map((command) => command.args),
    ).toEqual([["simctl", "install", "11111111-1111-4111-8111-111111111111", product]]);
  });

  it.each([
    ["ready", 0, "install"],
    ["build-command-failed", 27, "build-for-testing"],
    ["settings-command-failed", 27, "build-settings"],
    ["invalid-signature", 1, "host-validation"],
    ["install-command-failed", 27, "install"],
  ])("retains ordered build diagnostics for %s without pipeline ambiguity", (mode, exit, last) => {
    const { result } = runWatchStep(mode, false, ["build"]);
    expect(result.status).toBe(exit);
    const markers = result.stderr
      .split("\n")
      .filter((line) => line.startsWith("OPENCLAW_WATCH_BUILD\t"));
    const labels = ["build-for-testing", "build-settings", "host-validation", "install"];
    const reached = labels.slice(0, labels.indexOf(last) + 1);
    expect(markers).toEqual(
      reached.flatMap((label) => [
        `OPENCLAW_WATCH_BUILD\tstart\t${label}`,
        `OPENCLAW_WATCH_BUILD\tend\t${label}\t${label === last ? exit : 0}`,
      ]),
    );
  });

  it.each(["unknown-phase", "wrong-owned-device"])(
    "rejects %s before native phase execution",
    (mode) => {
      const { result, commands } = runWatchStep(
        mode,
        false,
        mode === "unknown-phase" ? ["unrecognized"] : ["build", "positive"],
      );
      expect(result.status).not.toBe(0);
      expect(commands.some((command) => command.args.includes("test-without-building"))).toBe(
        false,
      );
    },
  );

  it("keeps qualification opt-in and separates test evidence from Periphery reports", () => {
    expect(qualification.on.workflow_dispatch.inputs.watch_qualification.default).toBe(false);
    for (const name of [
      "Run Periphery",
      "Build Periphery report",
      "Upload Periphery report",
      "Fail on dead code",
    ]) {
      expect(qualificationSteps.find((step) => step.name === name)?.if).toContain(
        "!(github.event_name == 'workflow_dispatch' && inputs.watch_qualification)",
      );
    }
    const artifact = qualificationSteps.find(
      (step) => step.name === "Upload Watch qualification evidence",
    );
    expect(artifact?.if).toContain("always()");
    expect(artifact?.with?.["if-no-files-found"]).toBe("error");
    expect(String(artifact?.with?.path).trim().split("\n")).toEqual([
      "${{ runner.temp }}/watch-qualification/source-head.txt",
      "${{ runner.temp }}/watch-qualification/xcode-version.txt",
      "${{ runner.temp }}/watch-qualification/shared-tests.log",
      "${{ runner.temp }}/watch-qualification/watch-tests.log",
      "${{ runner.temp }}/watch-qualification/WatchOperationTests.xcresult",
      "${{ runner.temp }}/watch-qualification/ui-fixtures",
      "${{ runner.temp }}/watch-qualification/operator-https.json",
    ]);
    const liveHTTPS = qualificationSteps.find(
      (step) => step.name === "Prove Watch operator HTTPS and native voice retirement",
    );
    expect(liveHTTPS?.if).toContain(
      "github.event_name == 'workflow_dispatch' && inputs.watch_qualification",
    );
    expect(liveHTTPS?.run).toBe(
      "node --import ./scripts/tsx.mjs scripts/ios-watch-operator-https-proof.mts",
    );
    const shared = qualificationSteps.find(
      (step) => step.name === "Run focused shared Watch transport tests",
    );
    expect(shared?.run).toContain("GatewayOperatorHTTPSessionTests");
    expect(shared?.run).toContain("GatewayOperatorHTTPWireTests");
    expect(shared?.run).toContain("--no-parallel");
  });
});

describe("Watch build command diagnostics", () => {
  afterEach(() => vi.restoreAllMocks());

  async function command(
    source: string,
    report: Record<string, unknown>,
    timeout = 2000,
    label = "watch-build",
    saved?: unknown[],
  ) {
    return watchProof.runWatchQualificationCommand(label, process.execPath, ["-e", source], {
      environment: process.env,
      report,
      save: async () => {
        saved?.push(structuredClone(report));
      },
      timeout,
    });
  }

  it("retains sanitized build output and the first failure after successful and failed cleanup", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    const saved: unknown[] = [];
    await expect(
      command(
        String.raw`
      (async () => {
        process.stderr.write("OPENCLAW_WATCH_");
        await new Promise(resolve => setTimeout(resolve, 10));
        process.stderr.write("BUILD\tstart\tbuild-settings\n");
        process.stderr.write("OPENCLAW_WATCH_BUILD\tstart\tprivate-label\n");
        process.stderr.write("OPENCLAW_WATCH_BUILD\tstart\tinstall\tprivate-argument\n");
        process.stderr.write("error: Authorization: Bear");
        await new Promise(resolve => setTimeout(resolve, 10));
        process.stderr.write("er private-fixture-credential\n");
        for (const part of [
          "error: /Users/private-", "person/project/file.swift failed\n",
          "Authorization: Bear", "er private-fixture-credential\n",
          "error: https://private.internal/path?token=private-fixture-credential\n",
          "error: private-person@example.invalid 192.168.4.5 11111111-1111-4111-8111-111111111111\n",
          "-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----\n"
        ]) {
          process.stdout.write(part);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        process.stderr.write("error: fixture failure\n");
        process.stderr.write("OPENCLAW_WATCH_BUILD\tend\tbuild-settings\t27\n");
        process.exitCode = 27;
      })();
    `,
        report,
        2000,
        "watch-build",
        saved,
      ),
    ).rejects.toThrow();
    const failed = structuredClone(report.failedChild);
    expect(failed).toMatchObject({
      label: "watch-build",
      outcome: "exit",
      code: 27,
      signal: null,
      build: {
        steps: [
          { event: "start", label: "build-settings" },
          { event: "end", label: "build-settings", code: 27 },
        ],
        stderr: expect.stringContaining("error: fixture failure"),
      },
    });
    expect(saved.at(-1)).toMatchObject({ failedChild: failed });
    await command("", report, 2000, "watch-shutdown", saved);
    await expect(
      command("process.exitCode = 9", report, 2000, "watch-delete", saved),
    ).rejects.toThrow();
    expect(report.failedChild).toEqual(failed);
    expect(report.child).toMatchObject({ label: "watch-delete", code: 9 });
    const published = JSON.stringify([report, saved, consoleLog.mock.calls]);
    for (const privateValue of [
      "private-person",
      "private-fixture-credential",
      "private.internal",
      "192.168.4.5",
      "11111111-",
      "private-key-material",
      "private-label",
      "private-argument",
    ]) {
      expect(published).not.toContain(privateValue);
    }
    expect(published).not.toContain("-e");
  });

  it.each(["private-person/project", "private person/private project"])(
    "preserves located compiler errors without publishing the path: %s",
    async (directory) => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const report: Record<string, unknown> = {};
      const saved: unknown[] = [];
      const message =
        "error: main actor-isolated static property 'scopes' cannot be accessed from outside of the actor";
      const diagnostic = `/Users/${directory}/WatchOperatorHTTPSQualificationTests.swift:142:95: ${message}\n`;
      await expect(
        command(
          `process.stdout.write(${JSON.stringify(diagnostic)}); process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 1;`,
          report,
          2000,
          "watch-build",
          saved,
        ),
      ).rejects.toThrow();
      expect(report.failedChild).toMatchObject({
        build: {
          stdout: `[path]:142:95: ${message}`,
          stderr: `[path]:142:95: ${message}`,
        },
      });
      expect(JSON.stringify([report, saved, consoleLog.mock.calls])).not.toMatch(
        /Users|private.person|private project|WatchOperatorHTTPSQualificationTests/,
      );
    },
  );

  it("does not publish ambiguous progress paths or their private suffix words", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    const saved: unknown[] = [];
    const diagnostic =
      "SwiftCompile /Users/private person/private project/Watch.swift normal arm64 private-note\n";
    await expect(
      command(
        `process.stdout.write(${JSON.stringify(diagnostic)}); process.stderr.write(${JSON.stringify(diagnostic)}); process.exitCode = 1;`,
        report,
        2000,
        "watch-build",
        saved,
      ),
    ).rejects.toThrow();
    expect(report.failedChild).toMatchObject({ build: { stdout: "", stderr: "" } });
    expect(JSON.stringify([report, saved, consoleLog.mock.calls])).not.toMatch(
      /Users|private|person|project|Watch|SwiftCompile/,
    );
  });

  it.skipIf(process.platform === "win32")(
    "retains leader exit facts when held output rejects before close",
    { timeout: 20000 },
    async () => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      // This fixture owns the deliberate failed join and releases its held pipes afterward.
      const directory = mkdtempSync(path.join(realpathSync(tmpdir()), "watch-held-output-"));
      const owner = createVitestResourceOwner(directory);
      const file = (name: string) => path.join(directory, name);
      const output = "error: held output fixture\n";
      const leaf = `
const fs = require("node:fs");
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(file("release"))})) clearInterval(timer);
}, 5);
fs.writeFileSync(${JSON.stringify(file("leaf.pid"))}, String(process.pid));
process.send("ready");
process.disconnect();
`;
      const leader = `
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(file("leader.pid"))}, String(process.pid));
const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(leaf)}], {
  detached: true, stdio: ["ignore", "inherit", "inherit", "ipc"],
});
child.once("message", () => {
  fs.writeSync(1, ${JSON.stringify(output)});
  process.exit(7);
});
`;
      const report: Record<string, unknown> = {};
      const completion = watchProof
        .runWatchQualificationCommand("watch-build", process.execPath, ["-e", leader], {
          environment: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
          report,
          save: async () => {
            if (report.child) {
              writeFileSync(file("closed"), "closed");
            }
          },
          timeout: 15000,
        })
        .catch((error: unknown) => error);
      await runQaGatewayFixture(
        async () => {
          const failure = await completion;
          expect(failure).toMatchObject({ code: "EPROCESSGROUP_CLEANUP_FAILED" });
          expect(hasUnjoinedWork(failure)).toBe(true);
          expect(report.child).toBeUndefined();
          expect(report.failedChild).toMatchObject({
            code: 7,
            signal: null,
            outputBytes: Buffer.byteLength(output),
            outcome: "rejected",
            errorCode: "EPROCESSGROUP_CLEANUP_FAILED",
            unjoined: true,
          });
          const firstFailure = structuredClone(report.failedChild);
          expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
          writeFileSync(file("release"), "release");
          await waitForFile(file("closed"), 2000);
          expect(report.child).toMatchObject({ code: 7, outputBytes: Buffer.byteLength(output) });
          await command("", report, 2000, "watch-delete");
          expect(report.failedChild).toEqual(firstFailure);
        },
        async () => {
          writeFileSync(file("release"), "release");
          await completion;
          for (const name of ["leader.pid", "leaf.pid"]) {
            if (existsSync(file(name))) {
              await waitForDead(await waitForPidFile(file(name), 2000), 2000);
            }
          }
          rmSync(directory, { recursive: true, force: true });
        },
      );
    },
  );

  it.each(["timeout", "signal", "spawn"])(
    "classifies %s without inferring timeout from SIGTERM",
    async (kind) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const report: Record<string, unknown> = {};
      const run =
        kind === "spawn"
          ? watchProof.runWatchQualificationCommand(
              "watch-build",
              "/missing-watch-fixture-tool",
              [],
              {
                environment: process.env,
                report,
                save: async () => {},
              },
            )
          : command(
              kind === "timeout"
                ? "setInterval(() => {}, 1000)"
                : "process.kill(process.pid, 'SIGTERM')",
              report,
              kind === "timeout" ? 350 : 2000,
            );
      await expect(run).rejects.toThrow();
      expect(report.failedChild).toMatchObject({
        outcome: kind === "signal" ? "signal" : "rejected",
        errorCode: kind === "timeout" ? "ETIMEDOUT" : kind === "spawn" ? "ENOENT" : null,
        elapsedMs: expect.any(Number),
      });
    },
  );

  it("keeps the four MiB combined output cutoff and joins its rejected child", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    const failure = await command(
      `
      process.stdout.write("error: fixture start\\n");
      process.stderr.write(Buffer.alloc(4 * 1024 * 1024 + 1, 120));
    `,
      report,
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "ABORT_ERR" });
    expect(hasUnjoinedWork(failure)).toBe(false);
    expect(report.failedChild).toMatchObject({
      outcome: "rejected",
      errorCode: "ABORT_ERR",
      unjoined: false,
      build: { truncated: true },
    });
    expect((report.failedChild as { outputBytes: number }).outputBytes).toBeGreaterThan(
      4 * 1024 * 1024,
    );
  });

  it("bounds both build streams and does not expose output after identity admission", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    await expect(
      command(
        `
      process.stdout.write(("error: bounded fixture\\n").repeat(10000));
      process.stderr.write(("error: bounded fixture\\n").repeat(10000));
      process.exitCode = 1;
    `,
        report,
      ),
    ).rejects.toThrow();
    const failed = report.failedChild as { build: { stdout: string; stderr: string } };
    expect(Buffer.byteLength(failed.build.stdout)).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(failed.build.stderr)).toBeLessThanOrEqual(4096);
    const privateReport: Record<string, unknown> = {};
    await expect(
      command(
        "console.error('private-phase-token'); process.exitCode = 1",
        privateReport,
        2000,
        "watch-positive",
      ),
    ).rejects.toThrow();
    expect(privateReport.failedChild).not.toHaveProperty("build");
    expect(JSON.stringify([privateReport, consoleLog.mock.calls])).not.toContain(
      "private-phase-token",
    );
    expect(privateReport).not.toHaveProperty("identityOutput");
  });

  it.each(["passed", "failed", "skipped"] as const)(
    "records only attributed identity scalars across split UTF8 and ANSI: %s",
    async (outcome) => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const report: Record<string, unknown> = {};
      const saved: unknown[] = [];
      const text = [
        "\u001b[32m\u25c7 Suite WatchOperatorHTTPSQualificationTests started.\u001b[0m",
        ...(outcome === "skipped" ? [] : ["\u25c7 Test qualification() started."]),
        outcome === "skipped"
          ? '\u21b7 Test qualification() skipped: "/Users/private person/input.json private-token"'
          : `\u2714 Test qualification() ${outcome} after 0.001 seconds${outcome === "failed" ? " with 1 issue" : ""}.`,
        `\u2714 Suite WatchOperatorHTTPSQualificationTests ${outcome === "failed" ? "failed" : "passed"} after 0.002 seconds${outcome === "failed" ? " with 1 issue" : ""}.`,
        `\u2714 Test run with 1 test in 1 suite ${outcome === "failed" ? "failed" : "passed"} after 0.003 seconds${outcome === "failed" ? " with 1 issue" : ""}.`,
        "private-person@example.invalid https://private.internal/path 192.168.4.5",
        "11111111-1111-4111-8111-111111111111 private-identity private-input",
        "",
      ].join("\n");
      const source = `
        (async () => {
          const bytes = Buffer.from(${JSON.stringify(text)});
          for (let offset = 0; offset < bytes.length; offset += 2) {
            await new Promise(resolve => process.stderr.write(bytes.subarray(offset, offset + 2), resolve));
            await new Promise(resolve => setImmediate(resolve));
          }
          process.exitCode = ${outcome === "failed" ? 1 : 0};
        })();
      `;
      const result = command(source, report, 2000, "watch-identity", saved);
      if (outcome === "failed") {
        await expect(result).rejects.toThrow();
      } else {
        await result;
      }
      const diagnostic = {
        reportedCount: 1,
        summaryOutcome: outcome === "failed" ? "failed" : "passed",
        attribution: "expected-suite",
        expectedQualificationStart: outcome !== "skipped",
        expectedQualificationPass: outcome === "passed",
        expectedQualificationFail: outcome === "failed",
        expectedQualificationSkip: outcome === "skipped",
        truncated: false,
      };
      expect(report.identityOutput).toEqual(diagnostic);
      expect(saved.at(-1)).toMatchObject({ identityOutput: diagnostic });
      expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThan(512);
      expect(JSON.stringify([report, saved, consoleLog.mock.calls])).not.toMatch(
        /private|Users|input\.json|192\.168|11111111-|https:|skipped:/,
      );
    },
  );

  it.each([
    ["missing suite", "", "unavailable"],
    ["wrong suite", "\u25c7 Suite OtherTests started.\n", "ambiguous"],
    [
      "conflicting suites",
      "\u25c7 Suite WatchOperatorHTTPSQualificationTests started.\n\u25c7 Suite OtherTests started.\n",
      "ambiguous",
    ],
    [
      "lookalike suite",
      "\u25c7 Suite WatchOperatorHTTPSQualificationTestsExtra started.\n",
      "ambiguous",
    ],
    ["missing output", "", "unavailable"],
    [
      "conflicting outcomes",
      "\u25c7 Suite WatchOperatorHTTPSQualificationTests started.\n",
      "ambiguous",
    ],
    [
      "cross-stream suite",
      "\u25c7 Suite WatchOperatorHTTPSQualificationTests started.\n",
      "ambiguous",
    ],
  ])("keeps identity attribution conservative for %s", async (mode, suite, attribution) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    const events =
      mode === "missing output"
        ? ""
        : "\u25c7 Test qualification() started.\n\u2714 Test qualification() passed after 0.001 seconds.\n" +
          (mode === "conflicting outcomes" ? "\u21b7 Test qualification() skipped.\n" : "");
    await command(
      mode === "cross-stream suite"
        ? `process.stdout.write(${JSON.stringify(suite)}); process.stderr.write(${JSON.stringify(events)});`
        : `process.stdout.write(${JSON.stringify(suite + events)});`,
      report,
      2000,
      "watch-identity",
    );
    expect(report.identityOutput).toMatchObject({
      reportedCount: null,
      summaryOutcome: "unavailable",
      attribution,
      expectedQualificationStart: null,
      expectedQualificationPass: null,
      expectedQualificationFail: null,
      expectedQualificationSkip: null,
    });
  });

  it.each(["0", "-1", "1.5", "NaN", "9007199254740992", "1 private-token", "conflict"])(
    "does not manufacture an identity execution verdict from summary count %s",
    async (count) => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      const report: Record<string, unknown> = {};
      const text =
        count === "conflict"
          ? "\u2714 Test run with 1 test in 1 suite passed after 0.001 seconds.\n\u2718 Test run with 2 tests in 1 suite failed after 0.001 seconds.\n"
          : `\u2714 Test run with ${count} tests in 0 suites passed after 0.001 seconds.\n`;
      await command(
        `process.stdout.write(${JSON.stringify(text)});`,
        report,
        2000,
        "watch-identity",
      );
      expect(report.identityOutput).toMatchObject({
        reportedCount: count === "0" ? 0 : null,
        summaryOutcome:
          count === "0" ? "passed" : count === "conflict" ? "ambiguous" : "unavailable",
        attribution: "unavailable",
        expectedQualificationPass: null,
      });
      expect(JSON.stringify(report)).not.toContain("private-token");
    },
  );

  it("retains scalar-only identity diagnostics on combined-stream overflow", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    await expect(
      command(
        `process.stdout.write("\\u25c7 Suite WatchOperatorHTTPSQualificationTests started.\\n");
         process.stderr.write(Buffer.alloc(4 * 1024 * 1024 + 1, 120));`,
        report,
        2000,
        "watch-identity",
      ),
    ).rejects.toThrow();
    expect(report.failedChild).toMatchObject({ errorCode: "ABORT_ERR", unjoined: false });
    expect(report.identityOutput).toEqual({
      reportedCount: null,
      summaryOutcome: "ambiguous",
      attribution: "ambiguous",
      expectedQualificationStart: null,
      expectedQualificationPass: null,
      expectedQualificationFail: null,
      expectedQualificationSkip: null,
      truncated: true,
    });
    expect(JSON.stringify([report, consoleLog.mock.calls])).not.toContain("xxxx");
  });

  it.each([
    ["suite-start", "Suite WatchOperatorHTTPSQualificationTests started.secret"],
    ["suite-end", "Suite WatchOperatorHTTPSQualificationTests passed after private-token"],
    ["test-start", "Test qualification() started.secret"],
    ["test-end", "Test qualification() passed after /Users/private person/input.json"],
    ["test-end", "Test qualification() passed after 0.001 seconds. private-token"],
    ["test-end", "Test qualification() failed after NaN seconds."],
    ["test-end", "Test qualification() failed after 0.001 seconds with 1 issues."],
    ["test-end", "Test qualification() failed after 0.001 seconds with 2 issue."],
    ["test-end", 'Test qualification() skipped: "private-token" trailing'],
    ["summary", "Test run with 1 test in 1 suite passed after private-token"],
    ["summary", "Test run with 1 test in 1 suite passed after 0.001 seconds. trailing"],
    ["summary", "Test run with 1 test in 1 suite passed after 0.001 seconds with private-token."],
  ])("leaves malformed identity %s message unavailable: %s", async (part, malformed) => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const report: Record<string, unknown> = {};
    const lines = {
      "suite-start": "Suite WatchOperatorHTTPSQualificationTests started.",
      "test-start": "Test qualification() started.",
      "test-end": "Test qualification() passed after 0.001 seconds.",
      "suite-end": "Suite WatchOperatorHTTPSQualificationTests passed after 0.002 seconds.",
      summary: "Test run with 1 test in 1 suite passed after 0.003 seconds.",
    };
    await command(
      `process.stdout.write(${JSON.stringify(
        Object.entries(lines)
          .map(([key, line]) => (key === part ? malformed : line))
          .join("\n") + "\n",
      )});`,
      report,
      2000,
      "watch-identity",
    );
    expect(report.identityOutput).toMatchObject(
      part === "summary"
        ? { reportedCount: null, summaryOutcome: "unavailable" }
        : {
            attribution: "unavailable",
            expectedQualificationStart: null,
            expectedQualificationPass: null,
            expectedQualificationFail: null,
            expectedQualificationSkip: null,
          },
    );
    expect(JSON.stringify([report, consoleLog.mock.calls])).not.toMatch(
      /private|Users|secret|trailing/,
    );
  });
});

describe("Watch qualification phase admission", () => {
  afterEach(() => vi.restoreAllMocks());

  function phaseOwner(home = tempDirs.make("watch-phase-")): Parameters<typeof runWatchPhase>[2] {
    const directory = path.join(home, "Library", "Caches", "OpenClawQualification");
    mkdirSync(directory, { recursive: true });
    return {
      current: { home, directory },
      bundleID: "private.fixture.bundle",
      evidenceDirectory: tempDirs.make("watch-phase-evidence-"),
      resolveContainer: async () => home,
      report: {},
    };
  }

  it("carries the resolved container through consecutive phases and private capture", async () => {
    const root = tempDirs.make("watch-location-");
    const suffix = path.join("Library", "Caches", "OpenClawQualification");
    const evidenceDirectory = path.join(root, "evidence");
    mkdirSync(evidenceDirectory);
    const original = path.join(root, "original");
    mkdirSync(path.join(original, suffix), { recursive: true });
    let nativeHome = original;
    const resolveContainer = vi.fn(async () => nativeHome);
    const owner = {
      current: { home: original, directory: path.join(original, suffix) } as {
        home: string;
        directory: string;
      } | null,
      bundleID: "private.fixture.bundle",
      evidenceDirectory,
      resolveContainer,
      report: {},
    };
    const run = randomUUID();
    for (const [index, phase] of (["identity", "negative"] as const).entries()) {
      const before = owner.current!;
      const result = await runWatchPhase(phase, run, owner, async () => {
        expect(owner.current).toBeNull();
        expect(resolveContainer).toHaveBeenCalledTimes(index);
        const input = JSON.parse(readFileSync(path.join(before.directory, "input.json"), "utf8"));
        const identity = statSync(before.directory, { bigint: true });
        nativeHome = path.join(root, `relocated-${index}`);
        renameSync(before.home, nativeHome);
        const directory = path.join(nativeHome, suffix);
        const relocated = statSync(directory, { bigint: true });
        expect([relocated.dev, relocated.ino]).toEqual([identity.dev, identity.ino]);
        rmSync(path.join(directory, "input.json"));
        writeFileSync(
          path.join(directory, "result.json"),
          JSON.stringify({ ...input, ok: true, ownersJoined: true }),
          { mode: 0o600 },
        );
      });
      expect(result).toMatchObject({ run, phase, ok: true, ownersJoined: true });
      expect(owner.current).toEqual({
        home: realpathSync(nativeHome),
        directory: path.join(realpathSync(nativeHome), suffix),
      });
      expect(resolveContainer).toHaveBeenCalledTimes(index + 1);
      const captured = path.join(evidenceDirectory, `${phase}-result.json`);
      expect(JSON.parse(readFileSync(captured, "utf8"))).toEqual(result);
      expect(statSync(captured).mode & 0o777).toBe(0o600);
    }
  });

  it.each(["failed", "relative", "file", "unjoined"])(
    "does not admit or privately capture a valid old result after %s location resolution",
    async (mode) => {
      const root = tempDirs.make("watch-location-failure-");
      const directory = path.join(root, "Library", "Caches", "OpenClawQualification");
      const evidenceDirectory = path.join(root, "evidence");
      mkdirSync(directory, { recursive: true });
      mkdirSync(evidenceDirectory);
      const file = path.join(root, "not-a-directory");
      writeFileSync(file, "");
      const owner = {
        current: { home: root, directory } as { home: string; directory: string } | null,
        bundleID: "private.fixture.bundle",
        evidenceDirectory,
        report: {},
        resolveContainer: vi.fn(async () => {
          if (mode === "failed") {
            throw new Error("private-query-failure");
          }
          if (mode === "unjoined") {
            throw Object.assign(new Error("private-query-child"), {
              processTreeState: "indeterminate",
            });
          }
          return mode === "relative" ? "relative-container" : file;
        }),
      };
      const outcome = await runWatchPhase("identity", randomUUID(), owner, async () => {
        const input = JSON.parse(readFileSync(path.join(directory, "input.json"), "utf8"));
        rmSync(path.join(directory, "input.json"));
        writeFileSync(
          path.join(directory, "result.json"),
          JSON.stringify({ ...input, ok: true, ownersJoined: true }),
          { mode: 0o600 },
        );
      }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(AggregateError);
      expect(outcome).toMatchObject({ phaseFailure: { ownersJoined: false } });
      expect(hasUnjoinedWork(outcome)).toBe(true);
      expect(owner.current).toBeNull();
      expect(existsSync(path.join(evidenceDirectory, "identity-result.json"))).toBe(false);
      expect(owner.resolveContainer).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(owner.report)).not.toContain(root);
    },
  );

  it.each([
    "same",
    "alias",
    "moved",
    "renamed",
    "missing-after-write",
    "stale",
    "duplicate",
    "truncated",
    "malformed",
    "oversized",
    "unforwarded",
    "post-query-failure",
    "late-after-admission",
    "unjoined",
    "unterminated",
    "attributes-unavailable",
    "split-streams",
    "overflow",
    "run-mismatch",
    "phase-mismatch",
    "nonce-mismatch",
    "owner-acknowledgement",
    "input-consumption",
    "native-not-ok",
    "post-query-success",
    "query-unjoined",
  ])("keeps the diagnostic bridge separate from admission: %s", async (mode) => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const root = tempDirs.make("watch-bridge-");
    const original = path.join(root, "original");
    const current = path.join(root, "current");
    const suffix = path.join("Library", "Caches", "OpenClawQualification");
    const directory = path.join(original, suffix);
    mkdirSync(directory, { recursive: true });
    if (mode === "alias") {
      symlinkSync(original, current, "dir");
    } else if (mode === "moved") {
      mkdirSync(path.join(current, suffix), { recursive: true });
    }
    const bundleID = "private.fixture.bundle";
    const report: Record<string, unknown> = {};
    let input!: { run: string; phase: string; nonce: string };
    const fingerprint = (domain: string, values: string[], nonce = input.nonce) =>
      createHash("sha256")
        .update(
          ["openclaw.watch.bridge.v1", nonce.toLowerCase(), domain, ...values].join("\0") + "\0",
        )
        .digest("hex");
    const identity = (target: string, domain: string) => {
      const info = statSync(target, { bigint: true });
      return fingerprint(domain, [info.dev.toString(), info.ino.toString()]);
    };
    const record = (event: string, target: string) =>
      [
        "OPENCLAW_WATCH_BRIDGE",
        "1",
        event,
        fingerprint(
          "phase",
          [input.run.toLowerCase(), input.phase],
          mode === "stale" ? randomUUID() : input.nonce,
        ),
        mode === "attributes-unavailable"
          ? "unavailable"
          : identity(path.join(target, suffix), "directory"),
        mode === "attributes-unavailable" ? "unavailable" : identity(target, "home"),
        mode === "attributes-unavailable" ? "unavailable" : fingerprint("bundle", [bundleID]),
      ].join("\t") + "\n";
    const resolveContainer = vi.fn(async () => {
      if (["post-query-failure", "post-query-success"].includes(mode)) {
        throw new Error("/Users/private-person private-query-description");
      }
      if (mode === "query-unjoined") {
        throw Object.assign(new Error("private-query-child"), {
          processTreeState: "indeterminate",
        });
      }
      return ["alias", "moved", "renamed"].includes(mode) ? current : original;
    });
    const owner = phaseOwner(original);
    owner.resolveContainer = resolveContainer;
    owner.report = report;
    const outcome = await runWatchPhase("identity", randomUUID(), owner, async () => {
      input = JSON.parse(readFileSync(path.join(directory, "input.json"), "utf8"));
      if (mode !== "input-consumption") {
        rmSync(path.join(directory, "input.json"));
      }
      if (mode === "renamed") {
        const before = statSync(directory, { bigint: true });
        renameSync(original, current);
        const after = statSync(path.join(current, suffix), { bigint: true });
        expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      }
      const target = ["moved", "renamed"].includes(mode) ? current : original;
      const resultFile = path.join(target, suffix, "result.json");
      const result = {
        ...input,
        ok: mode !== "native-not-ok",
        ownersJoined: mode !== "owner-acknowledgement",
      };
      if (mode === "run-mismatch") {
        result.run = randomUUID();
      }
      if (mode === "phase-mismatch") {
        result.phase = "negative";
      }
      if (mode === "nonce-mismatch") {
        result.nonce = randomUUID();
      }
      writeFileSync(resultFile, JSON.stringify(result), { mode: 0o600 });
      if (
        ![
          "same",
          "alias",
          "moved",
          "renamed",
          "run-mismatch",
          "phase-mismatch",
          "nonce-mismatch",
          "owner-acknowledgement",
          "input-consumption",
          "native-not-ok",
          "post-query-success",
          "query-unjoined",
        ].includes(mode)
      ) {
        rmSync(resultFile);
      }
      if (mode === "unjoined") {
        throw Object.assign(new Error("private-child"), { processTreeState: "indeterminate" });
      }
      let stdout = record("consumed", target) + record("written", target);
      if (mode === "duplicate") {
        stdout += record("written", target);
      } else if (mode === "malformed") {
        stdout += "OPENCLAW_WATCH_BRIDGE\tprivate-token /Users/private-person\n";
      } else if (mode === "oversized") {
        stdout += "OPENCLAW_WATCH_BRIDGE\t" + "private-token".repeat(100) + "\n";
      } else if (mode === "unforwarded") {
        stdout = "native output unavailable\n";
      } else if (mode === "unterminated") {
        stdout = stdout.trimEnd();
      }
      if (["split-streams", "overflow"].includes(mode)) {
        return watchProof.runWatchQualificationCommand(
          "watch-identity",
          process.execPath,
          [
            "-e",
            `
          (async () => {
            const output = Buffer.from(${JSON.stringify(record("consumed", target))});
            for (let offset = 0; offset < output.length; offset += 2) {
              await new Promise(resolve => process.stdout.write(output.subarray(offset, offset + 2), resolve));
            }
            process.stderr.write(${JSON.stringify(record("written", target))});
            process.stderr.write(${mode === "overflow" ? "Buffer.alloc(4 * 1024 * 1024 + 1, 120)" : JSON.stringify("\u001b[32mprivate-\u00e9-input\u001b[0m\n")});
          })();
        `,
          ],
          { environment: process.env, report: {}, save: async () => {}, timeout: 2000 },
        );
      }
      return {
        stdout,
        stderr: "private-person@example.invalid\n",
        truncated: mode === "truncated",
      };
    }).catch((error: unknown) => error);
    const good = ["same", "alias", "moved", "renamed"].includes(mode);
    if (good) {
      expect(outcome).toMatchObject({ ok: true, ownersJoined: true });
    } else {
      expect(outcome).toBeInstanceOf(AggregateError);
      const admissionFailure = [
        "run-mismatch",
        "phase-mismatch",
        "nonce-mismatch",
        "owner-acknowledgement",
        "input-consumption",
        "native-not-ok",
      ].includes(mode)
        ? mode
        : ["unjoined", "post-query-failure", "post-query-success", "query-unjoined"].includes(mode)
          ? null
          : "result-missing";
      expect(outcome).toMatchObject({
        phaseFailure: {
          admissionFailure,
          ownersJoined: mode === "native-not-ok",
        },
      });
      expect(hasUnjoinedWork(outcome)).toBe(mode !== "native-not-ok");
    }
    expect(resolveContainer).toHaveBeenCalledTimes(mode === "unjoined" ? 0 : 1);
    const ambiguous = [
      "stale",
      "duplicate",
      "truncated",
      "malformed",
      "oversized",
      "unterminated",
      "overflow",
    ].includes(mode);
    if (mode === "renamed") {
      expect(report.phaseBridge).toMatchObject({ sameCanonicalHome: false });
    }
    expect(report.phaseBridge).toMatchObject({
      phase: "identity",
      original: {
        beforeExecution: {
          directory: expect.any(String),
          home: expect.any(String),
          input: "present",
          result: "absent",
        },
      },
      sameCanonicalHome: [
        "unjoined",
        "post-query-failure",
        "post-query-success",
        "query-unjoined",
      ].includes(mode)
        ? null
        : !["moved", "renamed"].includes(mode),
      native: {
        state: ambiguous
          ? "ambiguous"
          : ["unforwarded", "unjoined"].includes(mode)
            ? "unavailable"
            : "complete",
      },
      query:
        mode === "unjoined"
          ? "not-joined"
          : ["post-query-failure", "post-query-success", "query-unjoined"].includes(mode)
            ? "failed"
            : "ok",
    });
    if (mode === "unjoined") {
      expect(report.phaseBridge).toMatchObject({ original: { afterAdmission: null } });
    }
    if (["same", "alias", "moved", "renamed", "missing-after-write"].includes(mode)) {
      const bridge = report.phaseBridge as {
        original: {
          beforeExecution: { directory: string };
          afterAdmission: { directory: string | null; home: string | null; result: string };
        };
        current: { directory: string; result: string };
        native: { consumed: { directory: string }; written: { directory: string } };
      };
      expect(bridge.current.directory === bridge.original.beforeExecution.directory).toBe(
        mode !== "moved",
      );
      if (mode === "renamed") {
        expect(bridge.original.afterAdmission).toEqual({
          directory: null,
          home: null,
          input: "absent",
          result: "absent",
        });
      } else {
        expect(bridge.original.afterAdmission.directory).toBe(
          bridge.original.beforeExecution.directory,
        );
      }
      expect(bridge.native.consumed.directory).toBe(bridge.current.directory);
      expect(bridge.native.written.directory).toBe(bridge.current.directory);
      expect(bridge.current.result).toBe(mode === "missing-after-write" ? "absent" : "present");
    }
    if (mode === "late-after-admission") {
      writeFileSync(
        path.join(directory, "result.json"),
        JSON.stringify({ ...input, ok: true, ownersJoined: true }),
        { mode: 0o600 },
      );
      expect(report.phaseBridge).toMatchObject({
        original: { afterAdmission: { result: "absent" } },
        current: { result: "absent" },
        sameCanonicalHome: true,
      });
      expect(existsSync(path.join(owner.evidenceDirectory, "identity-result.json"))).toBe(false);
      expect(resolveContainer).toHaveBeenCalledTimes(1);
    }
    if (mode === "attributes-unavailable") {
      expect(report.phaseBridge).toMatchObject({
        native: {
          consumed: { directory: null, home: null, bundle: null },
          written: { directory: null, home: null, bundle: null },
        },
      });
    }
    expect(JSON.stringify([report, consoleLog.mock.calls])).not.toMatch(
      /private-|Users|watch-bridge-|fixture\.bundle/,
    );
    expect(JSON.stringify(report)).not.toContain(input!.nonce);
    expect(JSON.stringify(report)).not.toContain(input!.run);
  });

  it.each(["helper", "native", "unjoined", "malformed", "stale", "missing"])(
    "preserves only bounded public diagnostics for %s failure",
    async (mode) => {
      const owner = phaseOwner();
      const directory = owner.current!.directory;
      const failure = await runWatchPhase("negative", randomUUID(), owner, async () => {
        const file = path.join(directory, "input.json");
        const input = JSON.parse(readFileSync(file, "utf8"));
        rmSync(file);
        if (mode !== "missing") {
          const errors =
            mode === "malformed"
              ? [
                  null,
                  "private-description",
                  { domain: "private-domain", code: 1 },
                  { domain: "NSURLErrorDomain", code: "private-code" },
                  { domain: "other", code: 1.5 },
                  { domain: "other", code: Number.MAX_SAFE_INTEGER + 1 },
                  { domain: "NSOSStatusErrorDomain", code: -50, description: "private-detail" },
                ]
              : Array.from({ length: 10 }, (_, index) => ({
                  domain: "NSURLErrorDomain",
                  code: -1200 - index,
                  description: "private-detail",
                }));
          writeFileSync(
            path.join(directory, "result.json"),
            JSON.stringify({
              ...input,
              nonce: mode === "stale" ? randomUUID() : input.nonce,
              ok: mode === "helper",
              ownersJoined: mode !== "unjoined",
              errors,
              token: "private-token",
              deviceID: "private-identity",
              path: "/private/fixture/result",
            }),
            { mode: 0o600 },
          );
        }
        if (mode === "helper") {
          throw new Error("private-helper-description");
        }
      }).then(
        () => {
          throw new Error("Expected phase failure");
        },
        (error: unknown) => error as AggregateError & { phaseFailure: unknown },
      );
      const unverified = ["unjoined", "stale", "missing"].includes(mode);
      expect(failure.phaseFailure).toEqual({
        phase: "negative",
        ownersJoined: !unverified,
        helperExecutionFailed: mode === "helper",
        admissionFailure:
          mode === "missing"
            ? "result-missing"
            : mode === "stale"
              ? "nonce-mismatch"
              : mode === "unjoined"
                ? "owner-acknowledgement"
                : mode === "helper"
                  ? null
                  : "native-not-ok",
        errors: ["stale", "missing"].includes(mode)
          ? []
          : mode === "malformed"
            ? [{ domain: "NSOSStatusErrorDomain", code: -50 }]
            : Array.from({ length: 8 }, (_, index) => ({
                domain: "NSURLErrorDomain",
                code: -1200 - index,
              })),
      });
      expect(hasUnjoinedWork(new AggregateError([failure], "outer phase failure"))).toBe(
        unverified,
      );
      expect(JSON.stringify(failure.phaseFailure)).not.toContain("private");
    },
  );

  it.for([
    ["run", "run-mismatch"],
    ["phase", "phase-mismatch"],
    ["nonce", "nonce-mismatch"],
    ["failed", "native-not-ok"],
    ["missing", "result-missing"],
    ["skipped", "input-consumption"],
    ["oversized", "result-invalid"],
    ["mode", "result-invalid"],
    ["json", "result-invalid"],
    ["unreadable", "result-unreadable"],
    ["unjoined", "owner-acknowledgement"],
    ["multiple", "run-mismatch"],
    ["owner and native", "owner-acknowledgement"],
  ] as const)(
    "records the first current %s admission failure despite a valid old result",
    async ([mode, admissionFailure], context) => {
      if (mode === "unreadable" && (process.platform === "win32" || process.getuid?.() === 0)) {
        context.skip();
      }
      const owner = phaseOwner();
      const oldDirectory = owner.current!.directory;
      const currentHome = tempDirs.make("watch-current-");
      const directory = path.join(currentHome, "Library", "Caches", "OpenClawQualification");
      mkdirSync(directory, { recursive: true });
      owner.resolveContainer = vi.fn(async () => currentHome);
      let failure: AggregateError & { phaseFailure: unknown };
      try {
        failure = await runWatchPhase("negative", randomUUID(), owner, async () => {
          const oldInput = path.join(oldDirectory, "input.json");
          const input = JSON.parse(readFileSync(oldInput, "utf8"));
          rmSync(oldInput);
          writeFileSync(
            path.join(oldDirectory, "result.json"),
            JSON.stringify({ ...input, ok: true, ownersJoined: true }),
            { mode: 0o600 },
          );
          const file = path.join(directory, "input.json");
          writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
          if (mode === "missing") {
            rmSync(file);
            return;
          }
          if (!["skipped", "multiple", "owner and native"].includes(mode)) {
            rmSync(file);
          }
          const result = { ...input, ok: true, ownersJoined: true };
          if (["run", "phase", "nonce"].includes(mode)) {
            result[mode] = "stale";
          }
          if (mode === "failed") {
            result.ok = false;
          }
          if (mode === "oversized") {
            result.extra = "x".repeat(16384);
          }
          if (["unjoined", "multiple", "owner and native"].includes(mode)) {
            result.ownersJoined = false;
          }
          if (["multiple", "owner and native"].includes(mode)) {
            result.ok = false;
          }
          if (mode === "multiple") {
            result.run = result.phase = result.nonce = "private-stale";
          }
          writeFileSync(
            path.join(directory, "result.json"),
            mode === "json" ? "{" : JSON.stringify(result),
            {
              mode: mode === "mode" ? 0o644 : 0o600,
            },
          );
          if (mode === "mode") {
            chmodSync(path.join(directory, "result.json"), 0o644);
          }
          if (mode === "unreadable") {
            chmodSync(directory, 0o000);
          }
        }).then(
          () => {
            throw new Error("Expected phase failure");
          },
          (error: unknown) => error as AggregateError & { phaseFailure: unknown },
        );
      } finally {
        chmodSync(directory, 0o700);
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.phaseFailure).toMatchObject({
        phase: "negative",
        helperExecutionFailed: false,
        admissionFailure,
        ownersJoined: mode === "failed",
      });
      expect(hasUnjoinedWork(failure)).toBe(mode !== "failed");
      expect(owner.current).toBeNull();
      expect(owner.resolveContainer).toHaveBeenCalledTimes(1);
      if (mode === "failed") {
        expect(
          JSON.parse(
            readFileSync(path.join(owner.evidenceDirectory, "negative-result.json"), "utf8"),
          ),
        ).toMatchObject({ ok: false, ownersJoined: true });
      }
      if (mode === "owner and native") {
        expect(failure.errors).toHaveLength(2);
      }
      expect(JSON.stringify(failure.phaseFailure)).not.toMatch(/private|watch-phase-/);
    },
  );

  it.each(["missing", "nonce", "unjoined", "skipped"])(
    "keeps favorable identity console output separate from %s admission failure",
    async (mode) => {
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const owner = phaseOwner();
        const directory = owner.current!.directory;
        const report: Record<string, unknown> = {};
        const failure = await runWatchPhase("identity", randomUUID(), owner, async () => {
          await watchProof.runWatchQualificationCommand(
            "watch-identity",
            process.execPath,
            [
              "-e",
              'console.log("\\u25c7 Suite WatchOperatorHTTPSQualificationTests started.\\n\\u25c7 Test qualification() started.\\n\\u2714 Test qualification() passed after 0.001 seconds.\\n\\u2714 Test run with 1 test in 1 suite passed after 0.001 seconds.");',
            ],
            { environment: process.env, report, save: async () => {} },
          );
          const file = path.join(directory, "input.json");
          const input = JSON.parse(readFileSync(file, "utf8"));
          if (mode !== "skipped") {
            rmSync(file);
          }
          if (mode !== "missing") {
            writeFileSync(
              path.join(directory, "result.json"),
              JSON.stringify({
                ...input,
                nonce: mode === "nonce" ? randomUUID() : input.nonce,
                ownersJoined: mode !== "unjoined",
                ok: true,
              }),
              { mode: 0o600 },
            );
          }
        }).catch((error: unknown) => error);
        expect(report.identityOutput).toMatchObject({
          reportedCount: 1,
          summaryOutcome: "passed",
          expectedQualificationPass: true,
        });
        expect(failure).toBeInstanceOf(AggregateError);
        expect(hasUnjoinedWork(failure)).toBe(true);
      } finally {
        consoleLog.mockRestore();
      }
    },
  );

  it("accepts only a consumed request and matching current result", async () => {
    const owner = phaseOwner();
    const directory = owner.current!.directory;
    const run = randomUUID();
    const result = await runWatchPhase("identity", run, owner, async () => {
      const file = path.join(directory, "input.json");
      const input = JSON.parse(readFileSync(file, "utf8"));
      rmSync(file);
      writeFileSync(
        path.join(directory, "result.json"),
        JSON.stringify({ ...input, ok: true, ownersJoined: true }),
        {
          mode: 0o600,
        },
      );
    });
    expect(result).toMatchObject({ run, phase: "identity", ok: true });
  });
});

describe("Watch voice fixture lifecycle", () => {
  it.each(["sent", "closed"])(
    "reports old hello %s and joins callbacks plus both socket owners",
    async (outcome) => {
      const fixture = createVoiceFixture({
        cert: Buffer.from(TEST_TLS_CERT_PEM),
        key: Buffer.from(TEST_TLS_KEY_PEM),
        controlToken: "control-fixture",
        oldToken: "old-fixture",
        replacementToken: "new-fixture",
        deviceID: "fixture-device",
      });
      const endpoint = await fixture.listen();
      const clients: WebSocket[] = [];
      const raw = connect(Number(new URL(endpoint).port), "127.0.0.1");
      const rawClosed = once(raw, "close");
      const control = (action: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          // This local fixture certificate is deliberately not a system-trust qualification.
          const request = httpsRequest(
            `${endpoint}/${action}`,
            {
              rejectUnauthorized: false,
              agent: false,
              headers: { Authorization: "Bearer control-fixture" },
            },
            (response) => {
              let text = "";
              response.on("data", (chunk) => {
                text += chunk;
              });
              response.on("end", () => {
                try {
                  assert.equal(response.statusCode, 200);
                  resolve(JSON.parse(text));
                } catch (error) {
                  reject(error instanceof Error ? error : new Error("Invalid fixture response"));
                }
              });
            },
          );
          request.on("error", reject);
          request.end();
        });
      const open = async (token: string) => {
        const socket = new WebSocket(endpoint.replace("https:", "wss:"), {
          rejectUnauthorized: false,
        });
        clients.push(socket);
        const challenge = once(socket, "message");
        await once(socket, "open");
        await challenge;
        socket.send(
          JSON.stringify({
            type: "req",
            id: randomUUID(),
            method: "connect",
            params: {
              minProtocol: 4,
              maxProtocol: 4,
              device: { id: "fixture-device" },
              role: "operator",
              scopes: ["operator.read", "operator.talk"],
              auth: { deviceToken: token },
            },
          }),
        );
        return socket;
      };
      try {
        await once(raw, "connect");
        const old = await open("old-fixture");
        expect(await control("connected")).toEqual({ oldConnectObserved: true });
        if (outcome === "closed") {
          const closed = once(old, "close");
          old.close();
          await closed;
        }
        const oldHello = outcome === "sent" ? once(old, "message") : Promise.resolve();
        expect(await control("release")).toEqual({ oldHelloOutcome: outcome });
        await oldHello;
        const fresh = await open("new-fixture");
        await once(fresh, "message");
        fresh.send(JSON.stringify({ type: "req", id: randomUUID(), method: "agents.list" }));
        expect(await control("fresh")).toEqual({ freshAuthenticated: true });
        expect(await control("status")).toEqual({
          freshAuthenticated: true,
          oldHelloOutcome: outcome,
        });
      } finally {
        const closed = clients
          .filter((client) => client.readyState !== WebSocket.CLOSED)
          .map((client) => once(client, "close"));
        await fixture.close();
        await Promise.all([rawClosed, ...closed]);
      }
    },
  );
});
