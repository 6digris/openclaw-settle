import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const gatewayHelper = path.resolve("scripts/e2e/lib/upgrade-survivor/gateway-start.sh");
const instanceHelper = path.resolve("scripts/lib/openclaw-e2e-instance.sh");
const refusalPrefix = "OpenClaw plugin migration inputs changed during startup convergence;";
const retryMarker = "[upgrade-survivor] retrying gateway startup after convergence input change";

function quote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

type ScenarioOptions = {
  initialLog?: string;
  initialOwnership?: string;
  initialPid?: string;
  platform?: "Darwin" | "Linux";
  readinessStatus?: number;
  setsidAvailable?: boolean;
  deadlineOffset?: number;
  expireAfterWait?: boolean;
  delayTempFile?: boolean;
  stderrFlood?: boolean;
  observeOwnership?: boolean;
  delayStderrReader?: boolean;
};

function runScenario(sequence: string, options: ScenarioOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-gateway-"));
  const executable = path.join(root, "openclaw");
  const log = path.join(root, "gateway.log");
  const count = path.join(root, "count");
  const trace = path.join(root, "trace");
  fs.writeFileSync(log, options.initialLog ?? "");
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
attempt=0
[ ! -f "$FAKE_COUNT" ] || attempt="$(cat "$FAKE_COUNT")"
attempt=$((attempt + 1))
printf '%s\n' "$attempt" >"$FAKE_COUNT"
printf 'pid=%s argc=%s\n' "$$" "$#" >>"$FAKE_TRACE"
printf 'arg=%s\n' "$@" >>"$FAKE_TRACE"
printf '%s\n' --- >>"$FAKE_TRACE"
IFS=, read -r -a steps <<<"$FAKE_SEQUENCE"
case "\${steps[$((attempt - 1))]:-missing}" in
  success)
    ${options.stderrFlood ? `head -c 131072 /dev/zero | tr "\\0" x >&2; printf "\\n" >&2` : ""}
    printf '[gateway] ready ws://127.0.0.1:24567\n' >&2
    exec sleep 30
    ;;
  refusal) printf '%s arbitrary suffix\n' ${quote(refusalPrefix)} >&2; exit 1 ;;
  refusal2) printf '%s arbitrary suffix\n' ${quote(refusalPrefix)} >&2; exit 2 ;;
  signal) kill -TERM "$$" ;;
  near) printf 'x%s arbitrary suffix\n' ${quote(refusalPrefix)} >&2; exit 1 ;;
  stdout) printf '%s arbitrary suffix\n' ${quote(refusalPrefix)}; exit 1 ;;
  unrelated) printf 'unrelated startup failure\n' >&2; exit 1 ;;
  stale) exit 1 ;;
  *) exit 64 ;;
esac
`,
    { mode: 0o755 },
  );

  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `
set -uo pipefail
source ${quote(gatewayHelper)}
${options.delayStderrReader ? `tee() { command sleep 0.3; command tee "$@"; }; export -f tee` : ""}
uname() { printf '%s\n' ${quote(options.platform ?? "Linux")}; }
${
  options.setsidAvailable === false
    ? `setsid_probe_dir=${quote(path.join(root, "no-setsid"))}
mkdir -p "$setsid_probe_dir"
PATH="$setsid_probe_dir"`
    : `setsid() { exec "$@"; }`
}
upgrade_survivor_stop_owned_process_group() {
  pkill -TERM -P "$1" >/dev/null 2>&1 || true
  kill -TERM "$1" >/dev/null 2>&1 || true
  wait "$1" >/dev/null 2>&1 || true
}
openclaw_e2e_wait_gateway_ready() {
  local leader="$1" log_file="$2" child_var="$6" deadline="$7" offset="$8"
  ${options.observeOwnership ? `printf 'inflight_pid=%s ownership=%s\\n' "$gateway_pid" "$gateway_ownership"` : ""}
  ${
    options.readinessStatus === undefined
      ? `local i status
  for i in {1..80}; do
    if tail -c "+$((offset + 1))" "$log_file" 2>/dev/null | grep -qF '[gateway] ready '; then
      return 0
    fi
    if ! kill -0 "$leader" >/dev/null 2>&1; then
      wait "$leader"; status=$?
      printf -v "$child_var" '%s' "$status"
      ${options.expireAfterWait ? `SECONDS="$deadline"` : ""}
      return 1
    fi
    sleep 0.01
  done
  return 1`
      : `local i
  for i in {1..80}; do
    [ -s "$FAKE_TRACE" ] && break
    sleep 0.01
  done
  [ -s "$FAKE_TRACE" ] || return 99
  printf -v "$child_var" '%s' ""
  return ${options.readinessStatus}`
  }
}
${options.delayTempFile ? `mktemp() { command sleep 1.1; command mktemp "$@"; }` : ""}
rm() {
  if [[ "$*" = *openclaw-upgrade-survivor-stderr.* ]]; then
    printf 'capture_bytes=%s\n' "$(wc -c <"\${@: -1}" 2>/dev/null || echo 0)"
  fi
  command rm "$@"
}
gateway_pid=${quote(options.initialPid ?? "")}
gateway_ownership=${quote(options.initialOwnership ?? "")}
export FAKE_COUNT=${quote(count)} FAKE_TRACE=${quote(trace)} FAKE_SEQUENCE=${quote(sequence)}
upgrade_survivor_start_gateway_with_convergence_retry \
  gateway_pid ${quote(log)} 8 24567 legacy-ready-log-ok "$((SECONDS+${options.deadlineOffset ?? 5}))" \
  gateway_ownership -- ${quote(executable)} args
status=$?
printf 'gateway_pid=%s\n' "$gateway_pid"
printf 'gateway_ownership=%s\n' "$gateway_ownership"
if [ "$status" -eq 0 ] && [ -n "$gateway_pid" ]; then
  upgrade_survivor_stop_owned_process_group "$gateway_pid" "$((SECONDS + 2))"
fi
exit "$status"
`,
    ],
    { encoding: "utf8" },
  );
  const traceText = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "";
  const logText = fs.readFileSync(log, "utf8");
  fs.rmSync(root, { force: true, recursive: true });
  return { result, traceText, logText };
}

function launches(traceText: string): string[] {
  return traceText.split("---\n").filter(Boolean);
}

function reserveLoopbackPort(): number {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import net from "node:net";
const server = net.createServer();
server.listen(0, "127.0.0.1", () => {
  console.log(server.address().port);
  server.close();
});`,
    ],
    { encoding: "utf8" },
  );
  const port = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isInteger(port) || port < 1) {
    throw new Error(`failed to reserve loopback port: ${result.stderr}`);
  }
  return port;
}

function linuxProcessIsLive(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    return fields[0] !== "Z" && fields[0] !== "X";
  } catch {
    return false;
  }
}

function runOwnedProcessGroupRetry(options: {
  deadlineOffset: number;
  killDelay: number;
  realTime?: boolean;
  inheritStderr?: boolean;
  delaySetsid?: boolean;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-pgid-"));
  const executable = path.join(root, "openclaw");
  const listener = path.join(root, "listener.mjs");
  const log = path.join(root, "gateway.log");
  const count = path.join(root, "count");
  const trace = path.join(root, "trace");
  const firstBound = path.join(root, "first-bound");
  const secondBound = path.join(root, "second-bound");
  const descendant = path.join(root, "descendant.pid");
  const port = reserveLoopbackPort();
  fs.writeFileSync(
    listener,
    `import fs from "node:fs";
import net from "node:net";

const [mode, portText, boundPath, pidPath] = process.argv.slice(2);
const server = net.createServer();
if (mode === "resistant") {
  process.on("SIGTERM", () => {});
} else {
  process.on("SIGTERM", () => server.close(() => process.exit(0)));
}
server.on("error", (error) => {
  console.error(error.code ?? error.message);
  process.exit(1);
});
server.listen(Number(portText), "127.0.0.1", () => {
  if (pidPath) fs.writeFileSync(pidPath, String(process.pid));
  fs.writeFileSync(boundPath, "bound");
  if (mode === "ready") {
    console.error(\`[gateway] ready ws://127.0.0.1:\${portText}\`);
  }
});
`,
  );
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env bash
set -euo pipefail
attempt=0
[ ! -f "$FAKE_COUNT" ] || attempt="$(cat "$FAKE_COUNT")"
attempt=$((attempt + 1))
printf '%s\n' "$attempt" >"$FAKE_COUNT"
printf 'attempt=%s pid=%s\n---\n' "$attempt" "$$" >>"$FAKE_TRACE"
if [ "$attempt" -eq 1 ]; then
  node "$FAKE_LISTENER" resistant "$FAKE_PORT" "$FAKE_FIRST_BOUND" "$FAKE_DESCENDANT" \
    >/dev/null ${options.inheritStderr ? "" : "2>&1"} </dev/null &
  for _ in {1..200}; do
    [ -s "$FAKE_FIRST_BOUND" ] && break
    command sleep 0.01
  done
  [ -s "$FAKE_FIRST_BOUND" ] || exit 65
  printf '%s port owner survived TERM\n' ${quote(refusalPrefix)} >&2
  exit 1
fi
exec node "$FAKE_LISTENER" ready "$FAKE_PORT" "$FAKE_SECOND_BOUND" ""
`,
    { mode: 0o755 },
  );

  const result = spawnSync(
    "/bin/bash",
    [
      "-c",
      `
set -uo pipefail
source ${quote(instanceHelper)}
source ${quote(gatewayHelper)}
${options.delaySetsid ? `setsid() { local start_deadline=$((SECONDS + 2)); while [ "$SECONDS" -lt "$start_deadline" ]; do :; done; exec /usr/bin/setsid "$@"; }` : ""}
kill_delay=${quote(String(options.killDelay))}
${
  options.realTime
    ? ""
    : `sleep() {
  case "\${1:-}" in
    0.1 | 0.25) command sleep 0.01 ;;
    *) command sleep "$@" ;;
  esac
}`
}
${
  options.realTime
    ? ""
    : `kill() {
  if [ "\${1:-}" = "-KILL" ] && [ "\${2:-}" = "--" ] && [[ "\${3:-}" = -* ]]; then
    (command sleep "$kill_delay"; builtin kill "$@") >/dev/null 2>&1 &
    return 0
  fi
  builtin kill "$@"
}`
}
gateway_pid=""
cleanup() {
  [ -z "$gateway_pid" ] || builtin kill -KILL -- "-$gateway_pid" >/dev/null 2>&1 || true
  if [ -s ${quote(descendant)} ]; then
    builtin kill -KILL "$(cat ${quote(descendant)})" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
export FAKE_COUNT=${quote(count)}
export FAKE_TRACE=${quote(trace)}
export FAKE_LISTENER=${quote(listener)}
export FAKE_PORT=${quote(String(port))}
export FAKE_FIRST_BOUND=${quote(firstBound)}
export FAKE_SECOND_BOUND=${quote(secondBound)}
export FAKE_DESCENDANT=${quote(descendant)}
started_ms="$(node -p 'Date.now()')"
upgrade_survivor_start_gateway_with_convergence_retry \
  gateway_pid ${quote(log)} 80 "$FAKE_PORT" legacy-ready-log-ok \
  "$((SECONDS+${options.deadlineOffset}))" -- ${quote(executable)}
status=$?
finished_ms="$(node -p 'Date.now()')"
printf 'elapsed_ms=%s\n' "$((finished_ms - started_ms))"
printf 'gateway_pid=%s\n' "$gateway_pid"
if [ "$status" -eq 0 ]; then
  builtin kill -KILL -- "-$gateway_pid" >/dev/null 2>&1 || true
  wait "$gateway_pid" >/dev/null 2>&1 || true
  gateway_pid=""
fi
exit "$status"
`,
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  const traceText = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8") : "";
  const logText = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
  const descendantPid = fs.existsSync(descendant)
    ? Number(fs.readFileSync(descendant, "utf8").trim())
    : 0;
  const secondBindSucceeded = fs.existsSync(secondBound);
  const descendantLive = descendantPid > 0 && linuxProcessIsLive(descendantPid);
  fs.rmSync(root, { force: true, recursive: true });
  return { descendantLive, logText, result, secondBindSucceeded, traceText };
}

describe("upgrade survivor gateway convergence launcher", () => {
  it.each([
    ["Darwin", { platform: "Darwin" as const }],
    ["missing setsid", { setsidAvailable: false }],
  ])("fails closed on %s without changing the preexisting pid or log", (_label, options) => {
    const { result, traceText, logText } = runScenario("success", {
      ...options,
      initialLog: "keep-log\n",
      initialOwnership: "keep-ownership",
      initialPid: "keep-pid",
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toContain("gateway_pid=keep-pid");
    expect(result.stdout).toContain("gateway_ownership=keep-ownership");
    expect(logText).toBe("keep-log\n");
    expect(traceText).toBe("");
  });

  it("returns the waitable leader pid rather than the executable pid", () => {
    const { result, traceText } = runScenario("success");
    const launch = launches(traceText)[0];
    const returnedPid = result.stdout.match(/gateway_pid=(\d+)/u)?.[1];
    const executablePid = launch?.match(/pid=(\d+)/u)?.[1];

    expect(result.status, result.stderr).toBe(0);
    expect(launches(traceText)).toHaveLength(1);
    expect(returnedPid).toMatch(/^\d+$/u);
    expect(executablePid).toMatch(/^\d+$/u);
    expect(returnedPid).not.toBe(executablePid);
    expect(result.stdout).toContain("gateway_ownership=process-group");
  });

  it("publishes ownership while readiness is pending for caller EXIT cleanup", () => {
    const { result } = runScenario("success", { observeOwnership: true });
    const returnedPid = result.stdout.match(/gateway_pid=(\d+)/u)?.[1];
    expect(result.status, result.stderr).toBe(0);
    expect(returnedPid).toMatch(/^\d+$/u);
    expect(result.stdout).toContain(`inflight_pid=${returnedPid} ownership=process-group`);
  });

  it("keeps refusal capture bounded while forwarding noisy stderr to the log", () => {
    const { result, logText } = runScenario("success", { stderrFlood: true });
    const captureBytes = Number(result.stdout.match(/capture_bytes=\s*(\d+)/u)?.[1]);
    expect(result.status, result.stderr).toBe(0);
    expect(logText.length).toBeGreaterThan(131072);
    expect(captureBytes).toBeLessThan(256);
  });

  it("retries one exact-prefix stderr refusal with an arbitrary suffix", () => {
    const { result, traceText, logText } = runScenario("refusal,success");

    expect(result.status, result.stderr).toBe(0);
    expect(launches(traceText)).toHaveLength(2);
    expect(logText.split(retryMarker).length - 1).toBe(1);
  });

  it("waits for delayed stderr consumption before deciding whether to retry", () => {
    const { result, traceText, logText } = runScenario("refusal,success", {
      delayStderrReader: true,
    });
    expect(result.status, `${result.stderr}\n${logText}`).toBe(0);
    expect(launches(traceText)).toHaveLength(2);
    expect(logText.split(retryMarker).length - 1).toBe(1);
  });

  it("caps two refusals at two launches", () => {
    const { result, traceText, logText } = runScenario("refusal,refusal");

    expect(result.status).toBe(1);
    expect(launches(traceText)).toHaveLength(2);
    expect(logText.split(retryMarker).length - 1).toBe(1);
  });

  it.each([
    ["exit 2", "refusal2", "", 1],
    ["signal", "signal", "", 1],
    ["near prefix", "near", "", 1],
    ["stdout only", "stdout", "", 1],
    ["unrelated exit 1", "unrelated", "", 1],
    ["stale refusal", "stale", `${refusalPrefix} old\n`, 1],
  ])("does not retry %s", (_label, sequence, initialLog, expectedStatus) => {
    const { result, traceText, logText } = runScenario(sequence, { initialLog });

    expect(result.status).toBe(expectedStatus);
    expect(launches(traceText)).toHaveLength(1);
    expect(logText).not.toContain(retryMarker);
  });

  it("ignores stale readiness", () => {
    const { result, traceText } = runScenario("unrelated", {
      initialLog: "[gateway] ready ws://127.0.0.1:24567\n",
    });

    expect(result.status).toBe(1);
    expect(launches(traceText)).toHaveLength(1);
  });

  it("does not launch or mark a retry after the shared deadline expires", () => {
    const { result, traceText, logText } = runScenario("success", { deadlineOffset: 0 });

    expect(result.status).toBe(1);
    expect(traceText).toBe("");
    expect(logText).not.toContain(retryMarker);
    expect(result.stdout).toContain("Gateway did not become ready");
  });

  it("does not start a process when setup consumes the remaining deadline", () => {
    const { result, traceText } = runScenario("success", {
      deadlineOffset: 1,
      delayTempFile: true,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(traceText).toBe("");
    expect(result.stdout).toContain("Gateway did not become ready");
  });

  it("does not relaunch when the first refusal consumes the shared deadline", () => {
    const { result, traceText, logText } = runScenario("refusal,success", {
      expireAfterWait: true,
    });

    expect(result.status).toBe(1);
    expect(launches(traceText)).toHaveLength(1);
    expect(logText).not.toContain(retryMarker);
  });

  it("does not retry readiness status 2", () => {
    const { result, traceText, logText } = runScenario("refusal", { readinessStatus: 2 });

    expect(result.status).toBe(2);
    expect(launches(traceText)).toHaveLength(1);
    expect(logText).not.toContain(retryMarker);
  });

  it.runIf(process.platform === "linux")(
    "leaves no live TERM-resistant descendant after failure",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-setsid-"));
      const executable = path.join(root, "openclaw");
      const log = path.join(root, "gateway.log");
      const descendant = path.join(root, "descendant.pid");
      fs.writeFileSync(
        executable,
        `#!/usr/bin/env bash
( trap '' TERM; printf '%s\n' "$BASHPID" >${quote(descendant)}; while :; do sleep 1; done ) &
exit 1
`,
        { mode: 0o755 },
      );

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          `
source ${quote(gatewayHelper)}
openclaw_e2e_wait_gateway_ready() {
  local leader="$1" child_var="$6"
  wait "$leader"
  printf -v "$child_var" '%s' "$?"
  return 1
}
openclaw_e2e_stop_process() {
  kill -TERM -- "-$1" >/dev/null 2>&1 || true
  sleep 0.05
  kill -KILL -- "-$1" >/dev/null 2>&1 || true
  wait "$1" >/dev/null 2>&1 || true
}
gateway_pid=""
upgrade_survivor_start_gateway_with_convergence_retry \
  gateway_pid ${quote(log)} 8 24567 legacy-ready-log-ok "$((SECONDS+5))" \
  -- ${quote(executable)} args
status=$?
pid="$(cat ${quote(descendant)})"
for _ in {1..100}; do
  [ ! -e "/proc/$pid/stat" ] && exit "$status"
  state="$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true)"
  [ "$state" = "Z" ] && exit "$status"
  sleep 0.01
done
exit 99
`,
        ],
        { encoding: "utf8", timeout: 5_000 },
      );
      fs.rmSync(root, { force: true, recursive: true });

      expect(result.status, result.stderr).toBe(1);
    },
  );

  it.runIf(process.platform === "linux").each([false, true])(
    "drains the owned process group before retrying a converged startup (inherited stderr=%s)",
    (inheritStderr) => {
      const { descendantLive, logText, result, secondBindSucceeded, traceText } =
        runOwnedProcessGroupRetry({ deadlineOffset: 5, killDelay: 0.2, inheritStderr });
      const diagnostic = `${result.stderr}\n${result.stdout}\n${logText}`;

      expect(launches(traceText), diagnostic).toHaveLength(2);
      expect(logText.split(retryMarker).length - 1, diagnostic).toBe(1);
      expect(secondBindSucceeded, diagnostic).toBe(true);
      expect(result.status, diagnostic).toBe(0);
      expect(logText, diagnostic).not.toContain("EADDRINUSE");
      expect(descendantLive, diagnostic).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "does not retry when the owned process group outlives the shared deadline",
    () => {
      const { descendantLive, logText, result, secondBindSucceeded, traceText } =
        runOwnedProcessGroupRetry({ deadlineOffset: 1, killDelay: 2 });
      const diagnostic = `${result.stderr}\n${result.stdout}\n${logText}`;

      expect(result.status, diagnostic).toBe(1);
      expect(launches(traceText), diagnostic).toHaveLength(1);
      expect(logText, diagnostic).not.toContain(retryMarker);
      expect(secondBindSucceeded, diagnostic).toBe(false);
      expect(descendantLive, diagnostic).toBe(false);
    },
  );
  it.runIf(process.platform === "linux")(
    "bounds direct-child cleanup before setsid establishes its process group",
    () => {
      const { descendantLive, logText, result, traceText } = runOwnedProcessGroupRetry({
        deadlineOffset: 1,
        killDelay: 0,
        realTime: true,
        delaySetsid: true,
      });
      const diagnostic = `${result.stderr}\n${result.stdout}\n${logText}`;
      const elapsedMs = Number(result.stdout.match(/elapsed_ms=(\d+)/u)?.[1]);
      expect(result.error, diagnostic).toBeUndefined();
      expect(result.status, diagnostic).toBe(1);
      expect(elapsedMs, diagnostic).toBeLessThan(2_000);
      expect(launches(traceText), diagnostic).toHaveLength(0);
      expect(descendantLive, diagnostic).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "bounds TERM-resistant descendant cleanup by the real startup deadline",
    () => {
      const { descendantLive, logText, result, traceText } = runOwnedProcessGroupRetry({
        deadlineOffset: 1,
        killDelay: 0,
        realTime: true,
      });
      const diagnostic = `${result.stderr}\n${result.stdout}\n${logText}`;
      const elapsedMs = Number(result.stdout.match(/elapsed_ms=(\d+)/u)?.[1]);
      expect(result.error, diagnostic).toBeUndefined();
      expect(elapsedMs, diagnostic).toBeGreaterThanOrEqual(0);
      // One-second Bash deadline plus a bounded scheduler/probe allowance, not ten-second cleanup.
      expect(elapsedMs, diagnostic).toBeLessThan(2_000);
      expect(launches(traceText).length, diagnostic).toBeGreaterThanOrEqual(1);
      expect(launches(traceText).length, diagnostic).toBeLessThanOrEqual(2);
      expect(descendantLive, diagnostic).toBe(false);
      expect(logText, diagnostic).not.toContain("EADDRINUSE");
    },
  );
});
