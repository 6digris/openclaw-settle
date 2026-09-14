import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function probe(command, args, timeout = 30_000) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
  return {
    ok: !result.error && result.status === 0,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.code ?? null,
    output: result.stdout?.trim() ?? "",
  };
}

function status({ output: _output, ...result }) {
  return result;
}

function required(command, args, timeout) {
  const result = probe(command, args, timeout);
  assert(result.ok, `${path.basename(command)} preflight failed`);
  return result.output;
}

function main() {
  assert(
    process.platform === "darwin" &&
      process.env.CI === "true" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted",
    "Shortcuts preflight requires a disposable GitHub-hosted macOS runner",
  );
  assert(
    /^[0-9]+$/.test(process.env.GITHUB_RUN_ID ?? "") &&
      /^[0-9]+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? "") &&
      /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA ?? ""),
    "Missing exact workflow identity",
  );
  assert(process.argv.length === 3, "Expected one new receipt path under RUNNER_TEMP");
  const outputPath = path.resolve(process.argv[2]);
  const relative = path.relative(
    fs.realpathSync(process.env.RUNNER_TEMP),
    fs.realpathSync(path.dirname(outputPath)),
  );
  assert(
    !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`),
    "Receipt must be inside RUNNER_TEMP",
  );
  assert(!fs.existsSync(outputPath), "Receipt already exists");
  const xcode = ["/Applications/Xcode_26.6.app", "/Applications/Xcode-26.6.0.app"].find(
    (candidate) => fs.existsSync(path.join(candidate, "Contents/Developer")),
  );
  assert(xcode, "Xcode 26.6 is unavailable");
  process.env.DEVELOPER_DIR = path.join(xcode, "Contents/Developer");
  const xcodeVersion = required("xcodebuild", ["-version"]);
  assert(/^Xcode 26\.6(?:\s|$)/u.test(xcodeVersion), "Unexpected Xcode version");
  const receipt = {
    version: 1,
    sourceSha: process.env.GITHUB_SHA,
    runID: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    architecture: process.arch,
    macOSVersion: required("sw_vers", ["-productVersion"]),
    xcodeVersion,
    feasibilityOnly: true,
    installedOpenClawInvocationVerified: false,
    macOS: {},
    iOS: {},
  };
  let simulator;
  try {
    receipt.macOS.guiSession = status(probe("launchctl", ["print", `gui/${process.getuid()}`]));
    const accessibility = probe("osascript", [
      "-e",
      'tell application "System Events" to get UI elements enabled',
    ]);
    receipt.macOS.accessibility = {
      ...status(accessibility),
      enabled: accessibility.ok && accessibility.output === "true",
    };
    receipt.macOS.shortcutsAppAvailable = fs.existsSync("/System/Applications/Shortcuts.app");
    receipt.macOS.shortcutsCLIAvailable = fs.existsSync("/usr/bin/shortcuts");
    if (receipt.macOS.shortcutsAppAvailable) {
      receipt.macOS.launch = status(probe("open", ["-a", "/System/Applications/Shortcuts.app"]));
      const windows = probe("osascript", [
        "-e",
        `tell application "System Events"
repeat 20 times
if exists process "Shortcuts" then
set windowCount to count windows of process "Shortcuts"
if windowCount > 0 then return windowCount
end if
delay 0.5
end repeat
return 0
end tell`,
      ]);
      receipt.macOS.windows = {
        ...status(windows),
        count: windows.ok && /^[0-9]+$/.test(windows.output) ? Number(windows.output) : null,
      };
    }
    if (receipt.macOS.shortcutsCLIAvailable) {
      // A CLI listing is availability evidence, never App Intent discovery proof.
      receipt.macOS.cliList = status(probe("/usr/bin/shortcuts", ["list"]));
    }
    // CoreDevice requires a JSON output file for programmatic reads. Retain
    // only the count and remove this task-owned inventory before any simulator work.
    const deviceScratch = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "siri-coredevices-"));
    const deviceInventoryPath = path.join(deviceScratch, "devices.json");
    try {
      const devices = probe("xcrun", [
        "devicectl",
        "list",
        "devices",
        "--quiet",
        "--timeout",
        "15",
        "--json-output",
        deviceInventoryPath,
      ]);
      let count = null;
      if (devices.ok) {
        try {
          const payload = JSON.parse(fs.readFileSync(deviceInventoryPath, "utf8"));
          if (Array.isArray(payload?.result?.devices)) count = payload.result.devices.length;
        } catch {
          /* Unknown inventory never permits simulator allocation. */
        }
      }
      receipt.iOS.physicalDevices = { ...status(devices), count };
      if (count !== 0) {
        receipt.iOS.stopped =
          count === null ? "physical-device-check-unavailable" : "physical-device-present";
        return;
      }
    } finally {
      fs.rmSync(deviceInventoryPath, { force: true });
      fs.rmdirSync(deviceScratch);
    }
    const inventory = JSON.parse(required("xcrun", ["simctl", "list", "--json"]));
    const runtime = inventory.runtimes
      .filter((entry) => entry.isAvailable && entry.platform === "iOS")
      .sort((a, b) => b.version.localeCompare(a.version, "en", { numeric: true }))[0];
    const deviceType = runtime?.supportedDeviceTypes.find(
      (entry) => entry.productFamily === "iPhone",
    );
    receipt.iOS.runtimeAvailable = Boolean(runtime && deviceType);
    if (!runtime || !deviceType) return;
    receipt.iOS.runtime = {
      identifier: runtime.identifier,
      version: runtime.version,
      build: runtime.buildversion,
    };
    receipt.iOS.deviceType = deviceType.identifier;
    const name = `OpenClaw Siri Preflight ${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
    assert(
      !Object.values(inventory.devices)
        .flat()
        .some((device) => device.name === name),
      "Owned simulator name already exists",
    );
    const createdSimulator = required("xcrun", [
      "simctl",
      "create",
      name,
      deviceType.identifier,
      runtime.identifier,
    ]);
    assert(
      /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(createdSimulator),
      "Simulator creation returned an invalid identity",
    );
    simulator = createdSimulator;
    receipt.iOS.ownedSimulatorID = simulator;
    receipt.iOS.boot = status(probe("xcrun", ["simctl", "bootstatus", simulator, "-b"], 180_000));
    if (receipt.iOS.boot.ok) {
      receipt.iOS.shortcutsContainer = status(
        probe("xcrun", ["simctl", "get_app_container", simulator, "com.apple.shortcuts", "app"]),
      );
      receipt.iOS.shortcutsLaunch = status(
        probe("xcrun", ["simctl", "launch", simulator, "com.apple.shortcuts"]),
      );
    }
  } finally {
    if (simulator) {
      receipt.iOS.shutdown = status(probe("xcrun", ["simctl", "shutdown", simulator]));
      receipt.iOS.delete = status(probe("xcrun", ["simctl", "delete", simulator]));
    }
    // Only allowlisted results leave the disposable runner; no raw process,
    // environment, device inventory, app-container paths, or command diagnostics.
    fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    if (simulator) assert(receipt.iOS.delete.ok, "Owned simulator cleanup failed");
  }
}

try {
  main();
} catch (error) {
  console.error(
    error instanceof assert.AssertionError
      ? error.message
      : "Shortcuts preflight failed unexpectedly",
  );
  console.error("[apple-shortcuts-preflight] FAILED (exit 1)");
  process.exitCode = 1;
}
