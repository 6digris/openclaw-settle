import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileUtf8 } from "../../src/daemon/exec-file.js";
import { resolveSystemdUserTransport } from "../../src/daemon/systemd-user-transport.js";
import { mockProcessPlatform } from "../../src/test-utils/vitest-spies.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("../../src/daemon/exec-file.js", () => ({ execFileUtf8: vi.fn() }));
vi.mock("../../src/daemon/systemd-peer-native.js", () => ({
  openSystemdUserManager: () => {
    throw new Error("Doctor fixture must never open a real manager socket");
  },
}));
const dirs = useAutoCleanupTempDirTracker(afterEach);
const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
const shim = path.resolve("scripts/e2e/lib/doctor-install-switch/shims/busctl");
const versionArgs = [
  "--user",
  "--auto-start=no",
  "get-property",
  "org.freedesktop.systemd1",
  "/org/freedesktop/systemd1",
  "org.freedesktop.systemd1.Manager",
  "Version",
];

beforeEach(() => {
  vi.resetAllMocks();
  mockProcessPlatform("linux");
  vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", undefined);
  vi.stubEnv("SUDO_USER", undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function scenarioEnvironment() {
  const home = dirs.make("doctor-switch-transport-");
  const scenario = fs.readFileSync("scripts/e2e/lib/doctor-install-switch/scenario.sh", "utf8");
  const body = scenario.match(/use_default_service_identity\(\) \{[\s\S]*?\n\}/)?.[0];
  expect(body).toBeDefined();
  // Only replace the OS-account-home lookup. Cleanup and environment setup execute unchanged,
  // exclusively inside this test's temporary home; the full install scenario never runs.
  const result = spawnSync(
    bash,
    [
      "-c",
      `
set -euo pipefail
node() { [ "$1" = -p ]; printf '%s\\n' "$HOME"; }
${body}
use_default_service_identity
export USER=testuser
env -0
`,
    ],
    {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: path.join(home, "unavailable") },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return Object.fromEntries(
    result.stdout
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
}

it.runIf(process.platform !== "win32")(
  "routes the Doctor scenario through its explicit synthetic user bus",
  async () => {
    const env = scenarioEnvironment();
    const invocations: string[][] = [];
    vi.mocked(execFileUtf8).mockImplementation(async (command, args) => {
      expect(command).toBe("busctl");
      invocations.push([...args]);
      // Invoke only the repository shim; never resolve busctl from the host PATH.
      const result = spawnSync(process.execPath, [shim, ...args], { encoding: "utf8", env });
      return {
        code: result.status ?? 1,
        termination: "exit",
        stdout: result.stdout,
        stderr: result.stderr,
      };
    });
    await expect(resolveSystemdUserTransport(env)).resolves.toEqual({
      kind: "session-bus",
      address: env.DBUS_SESSION_BUS_ADDRESS,
      runtimeDir: env.XDG_RUNTIME_DIR,
    });
    expect(invocations).toEqual([versionArgs]);
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${env.XDG_RUNTIME_DIR}/bus`);
    const runtimeDir = env.XDG_RUNTIME_DIR;
    if (!runtimeDir) {
      throw new Error("Doctor fixture must configure its synthetic runtime directory");
    }
    expect(runtimeDir.startsWith(env.HOME + path.sep)).toBe(true);
  },
);

it.runIf(process.platform !== "win32")(
  "classifies the missing-address machine-scope rejection after checking the system manager",
  async () => {
    const env = scenarioEnvironment();
    delete env.DBUS_SESSION_BUS_ADDRESS;
    const invocations: string[][] = [];
    vi.mocked(execFileUtf8).mockImplementation(async (command, args) => {
      invocations.push([command, ...args]);
      if (command === "systemctl") {
        return { code: 0, termination: "exit", stdout: "running\n", stderr: "" };
      }
      expect(command).toBe("busctl");
      const result = spawnSync(process.execPath, [shim, ...args], { encoding: "utf8", env });
      return {
        code: result.status ?? 1,
        termination: "exit",
        stdout: result.stdout,
        stderr: result.stderr,
      };
    });
    await expect(resolveSystemdUserTransport(env)).rejects.toMatchObject({
      reason: "systemd-user-bus-unavailable",
    });
    expect(invocations).toEqual([
      ["busctl", "--machine", "testuser@", ...versionArgs],
      ["systemctl", "--system", "is-system-running"],
    ]);
  },
);

it.runIf(process.platform !== "win32").each([
  { busctl: "ENOENT", systemctl: "ENOENT", reason: "service-manager-unavailable" },
  { busctl: "ENOENT", systemctl: "running", reason: "systemd-busctl-unavailable" },
  { busctl: "EACCES", systemctl: "running", reason: "service-manager-access-denied" },
  { busctl: undefined, systemctl: "running", reason: "systemd-user-bus-unavailable" },
  { busctl: undefined, systemctl: "offline", reason: "service-manager-unavailable" },
  { busctl: undefined, systemctl: "not-booted", reason: "service-manager-unavailable" },
] as const)(
  "records $reason for the unavailable Doctor bus ($busctl, $systemctl)",
  async ({ busctl, systemctl, reason }) => {
    const env = scenarioEnvironment();
    vi.mocked(execFileUtf8).mockImplementation(async (command) => {
      const errorCode =
        command === "busctl" ? busctl : systemctl === "ENOENT" ? systemctl : undefined;
      if (errorCode) {
        return { code: 1, termination: "error", errorCode, stdout: "", stderr: errorCode };
      }
      if (command === "busctl") {
        return {
          code: 1,
          termination: "exit",
          stdout: "",
          stderr: "Failed to connect to bus: No such file or directory",
        };
      }
      return {
        code: systemctl === "running" ? 0 : 1,
        termination: "exit",
        stdout: systemctl === "not-booted" ? "" : `${systemctl}\n`,
        stderr: systemctl === "not-booted" ? "System has not been booted with systemd" : "",
      };
    });
    await expect(resolveSystemdUserTransport(env)).rejects.toMatchObject({ reason });
    expect(
      vi.mocked(execFileUtf8).mock.calls.map(([command, args]) => [command].concat(args)),
    ).toEqual([
      ["busctl", ...versionArgs],
      ["busctl", "--machine", "testuser@", ...versionArgs],
      ...(busctl === "EACCES" ? [] : [["systemctl", "--system", "is-system-running"]]),
    ]);
  },
);

it("keeps machine scope, auto-start, and foreign-manager probes outside the shim contract", () => {
  const env = scenarioEnvironment();
  for (const args of [
    ["--machine", "testuser@", ...versionArgs],
    versionArgs.filter((arg) => arg !== "--auto-start=no"),
    [...versionArgs.slice(0, -1), "ForeignProperty"],
  ]) {
    const result = spawnSync(process.execPath, [shim, ...args], { encoding: "utf8", env });
    expect(result.status, JSON.stringify(args)).toBe(1);
    expect(result.stderr).toContain("unexpected invocation");
  }
});
