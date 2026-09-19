import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runSource = readFileSync("scripts/e2e/lib/upgrade-survivor/run.sh", "utf8");
const serviceSource = readFileSync(
  "scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh",
  "utf8",
);

function functionSource(source: string, name: string): string {
  const start = source.indexOf(`\n${name}() {`);
  if (start < 0) {
    throw new Error(`Missing caller ${name}`);
  }
  const end = source.indexOf("\n}\n", start);
  if (end < 0) {
    throw new Error(`Missing end of caller ${name}`);
  }
  return source.slice(start, end + 3);
}

function runShell(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", ["-c", `set -eu\n${script}`], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
}

describe("survivor startup callers", () => {
  it.each([
    ["base", "strict"],
    ["watchos-direct-node", "legacy-ready-log-ok"],
  ])("keeps %s startup and cleanup with the same owned group", (scenario, readinessMode) => {
    const root = tempDirs.make("survivor-start-caller-");
    const result = runShell(
      `
SECONDS=0
GATEWAY_LOG="$FIXTURE_ROOT/gateway.log"
SYSTEMCTL_SHIM_PID_FILE="$FIXTURE_ROOT/absent.pid"
SCENARIO="$SCENARIO_CASE"
gateway_pid=""
gateway_ownership=""
node() { printf '1000'; }
openclaw_e2e_read_positive_int_env() { printf '90'; }
upgrade_survivor_start_gateway_with_convergence_retry() {
  [ "$6" -gt "$SECONDS" ] && [ "$6" -le 90 ] || return 92
  printf 'mode:%s\n' "$5"
  printf -v "$1" '%s' 43210
  printf -v "$7" '%s' process-group
  shift 8
  printf 'command:%s\n' "$*"
}
upgrade_survivor_stop_owned_process_group() { printf 'drained:%s\n' "$1"; }
openclaw_e2e_terminate_gateways() { echo wrong-owner; return 93; }
${functionSource(runSource, "start_gateway")}
${functionSource(runSource, "stop_gateway")}
start_gateway
printf 'owner:%s:%s\n' "$gateway_pid" "$gateway_ownership"
stop_gateway
printf 'cleared:%s:%s\n' "$gateway_pid" "$gateway_ownership"
`,
      { FIXTURE_ROOT: root, SCENARIO_CASE: scenario },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`mode:${readinessMode}`);
    expect(result.stdout).toContain(
      "command:env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway --port 18789 --bind loopback --allow-unconfigured",
    );
    expect(result.stdout).toContain("owner:43210:process-group");
    expect(result.stdout).toContain("drained:43210");
    expect(result.stdout).toContain("cleared::");
  });

  it("propagates readiness failure without discarding the cleanup owner", () => {
    const result = runShell(`
GATEWAY_LOG=unused
node() { printf '1000'; }
openclaw_e2e_read_positive_int_env() { printf '90'; }
upgrade_survivor_start_gateway_with_convergence_retry() {
  printf -v "$1" '%s' 43210
  printf -v "$7" '%s' process-group
  return 73
}
${functionSource(runSource, "start_gateway")}
status=0
start_gateway || status="$?"
printf '%s:%s:%s\n' "$status" "$gateway_pid" "$gateway_ownership"
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("73:43210:process-group");
  });

  it("includes managed install time in readiness without replacing the service owner", () => {
    const root = tempDirs.make("survivor-managed-start-caller-");
    writeFileSync(path.join(root, "gateway.pid"), "43210\n");
    const result = runShell(
      `
SECONDS=0
OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG="$FIXTURE_ROOT/gateway.log"
OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE="$FIXTURE_ROOT/gateway.pid"
OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_JSON="$FIXTURE_ROOT/install.json"
OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SERVICE_INSTALL_ERR="$FIXTURE_ROOT/install.err"
node() { printf '1000'; }
openclaw_e2e_read_positive_int_env() { printf '90'; }
openclaw_e2e_maybe_timeout() {
  shift
  printf '%s\n' "$*" >"$FIXTURE_ROOT/command"
  SECONDS=$((SECONDS + 5))
}
openclaw_e2e_wait_gateway_ready() {
  [ "$1" = 43210 ] && [ "$5" = strict ] && [ -z "$6" ] || return 91
  [ "$7" -le 90 ] && [ "$(( $7 - SECONDS ))" -le 85 ] || return 92
  printf 'deadline:%s\n' "$7" >"$FIXTURE_ROOT/readiness"
}
upgrade_survivor_start_gateway_with_convergence_retry() { echo wrong-owner; return 93; }
${functionSource(serviceSource, "run_update_restart_probe_gateway")}
run_update_restart_probe_gateway install 18789 120s
`,
      { FIXTURE_ROOT: root },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(root, "command"), "utf8").trim()).toBe(
      "env -u OPENCLAW_GATEWAY_TOKEN -u OPENCLAW_GATEWAY_PASSWORD openclaw gateway install --force --json",
    );
    expect(readFileSync(path.join(root, "readiness"), "utf8")).toMatch(/^deadline:90\n$/u);
  });
});
