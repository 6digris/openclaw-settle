import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect } from "node:net";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { parse } from "yaml";
import {
  createVoiceFixture,
  runWatchPhase,
} from "../../scripts/ios-watch-operator-https-proof.mts";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
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
    const { result, commands } = runWatchStep("ready", false, [
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
      expect(command.args).toContain(
        "platform=watchOS Simulator,id=11111111-1111-4111-8111-111111111111",
      );
      expect(command.args.filter((arg) => arg.startsWith("-only-testing:"))).toEqual([
        "-only-testing:OpenClawWatchTests/WatchOperatorHTTPSQualificationTests",
      ]);
    }
    expect(
      commands.filter((command) => command.args[0] === "simctl").map((command) => command.args[1]),
    ).toEqual(["install"]);
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

describe("Watch qualification phase admission", () => {
  it.each(["helper", "native", "unjoined", "malformed", "stale", "missing"])(
    "preserves only bounded public diagnostics for %s failure",
    async (mode) => {
      const directory = tempDirs.make("watch-phase-diagnostic-");
      const failure = await runWatchPhase("negative", randomUUID(), directory, async () => {
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

  it.each(["run", "phase", "nonce", "failed", "missing", "skipped", "oversized", "unjoined"])(
    "rejects %s evidence even when the tool reports success",
    async (mode) => {
      const directory = tempDirs.make("watch-phase-");
      await expect(
        runWatchPhase("negative", randomUUID(), directory, async () => {
          const file = path.join(directory, "input.json");
          const input = JSON.parse(readFileSync(file, "utf8"));
          if (mode === "missing") {
            rmSync(file);
            return;
          }
          if (mode !== "skipped") {
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
          if (mode === "unjoined") {
            result.ownersJoined = false;
          }
          writeFileSync(path.join(directory, "result.json"), JSON.stringify(result), {
            mode: 0o600,
          });
        }),
      ).rejects.toThrow();
    },
  );

  it("accepts only a consumed request and matching current result", async () => {
    const directory = tempDirs.make("watch-phase-");
    const run = randomUUID();
    const result = await runWatchPhase("identity", run, directory, async () => {
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
